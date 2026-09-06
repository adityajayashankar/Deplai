"""Checkpointed LangGraph workflow for multi-agent code remediation.

The workflow is deliberately stateful:

    Master -> Planner -> Implementor -> deterministic Reviewer -> Synthesizer

Planner and Implementor are the only LLM nodes. Their inputs and outputs use
strict JSON contracts. The reviewer performs local, reproducible validation and
never consumes an LLM request.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shlex
from typing import Any, TypedDict
from uuid import uuid4

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from claude_remediator import (
    ClaudeBudgetTracker,
    MAX_FILE_BYTES,
    _extract_json,
    _list_candidate_files,
    _read_file,
    _resolve_path_against_allowed,
    _run_repo_shell,
    _validate_change_candidate,
    _write_file,
)
from remediation_pipeline.validator import DiffValidator
from remediation_pipeline.remediation_store import bind_remediation_run, remediation_runs
from utils import get_repo_root, set_current_project_id

from .remediation_supervisor import (
    AGENT_NODE_TIMEOUT_SECONDS,
    SUPERVISOR_MAX_CONTEXT_CHARS,
    SUPERVISOR_MAX_FILES,
    SUPERVISOR_MAX_FINDINGS,
    SUPERVISOR_MAX_PROMPT_CHARS,
    _dispatch_llm,
)
from .reasoning_preserve import inject_reasoning


_EDITABLE_MANIFESTS = {
    "package.json",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "pyproject.toml",
    "Cargo.toml",
    "build.gradle",
    "build.gradle.kts",
}


def _env_int(name: str, default: int, *, minimum: int, maximum: int | None = None) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    return min(maximum, value) if maximum is not None else value


_REVIEW_MIN_SCORE = _env_int("REMEDIATION_LOCAL_REVIEW_MIN_SCORE", 80, minimum=0, maximum=100)
_SOURCE_WINDOW_LINES = _env_int("REMEDIATION_SUPERVISOR_CONTEXT_LINES", 30, minimum=8)
_LOW_QUOTA_OPENROUTER_MARKERS = (
    "minimax-m3",
    "minimax-m2.7",
    "nemotron",
)


class RemediationWorkflowState(TypedDict):
    project_id: str
    wiki_context: str
    remediation_run_id: str
    scan_data: dict[str, Any]
    contexts: dict[str, str]
    allowed_paths: list[str]
    llm_provider: str
    llm_api_key: str
    llm_model: str
    user_id: str
    organization_id: str
    llm_access_mode: str
    llm_credential_id: str
    budget_tracker: ClaudeBudgetTracker | None
    persist_changes: bool
    round: int
    plan: dict[str, Any]
    planner_warning: str
    proposal: dict[str, Any]
    proposer_parse_warning: str
    critique: dict[str, Any]
    attempt_history: list[dict[str, Any]]
    final_result: dict[str, Any]
    error: str


_PLANNER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "targets", "constraints"],
    "properties": {
        "summary": {"type": "string", "maxLength": 800},
        "targets": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["path", "findings", "approach", "verification"],
                "properties": {
                    "path": {"type": "string", "maxLength": 500},
                    "findings": {"type": "array", "maxItems": 16, "items": {"type": "string", "maxLength": 160}},
                    "approach": {"type": "string", "maxLength": 1200},
                    "verification": {"type": "string", "maxLength": 800},
                },
            },
        },
        "constraints": {"type": "array", "maxItems": 12, "items": {"type": "string", "maxLength": 300}},
    },
}

_IMPLEMENTOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "changes"],
    "properties": {
        "summary": {"type": "string", "maxLength": 800},
        "changes": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["path", "reason", "format", "content"],
                "properties": {
                    "path": {"type": "string", "maxLength": 500},
                    "reason": {"type": "string", "maxLength": 800},
                    "format": {"type": "string", "enum": ["unified_diff", "search_replace"]},
                    "content": {"type": "string", "maxLength": 20000},
                },
            },
        },
    },
}


def _response_format(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}


def _prompt_system_guard(stage: str) -> str:
    """Hard system-level guard for free-model consistency. Must be first message."""
    return (
        "You are a structured-output engine only. You must reply with EXACTLY ONE valid JSON object. "
        "No markdown, no explanation, no apologies, no commentary outside the JSON. "
        "Every required key must be present. If you are unsure about a value, use an empty string or [] — never omit the key. "
        f"Stage: {stage}. Schema strict mode is ON. Violation = failure."
    )


def _validate_planner_json(value: dict[str, Any], allowed_paths: list[str]) -> dict[str, Any]:
    if set(value) != {"summary", "targets", "constraints"}:
        raise ValueError("Planner response keys do not match the strict schema")
    if not isinstance(value["summary"], str) or not isinstance(value["targets"], list) or not isinstance(value["constraints"], list):
        raise ValueError("Planner response has invalid field types")
    allowed = set(allowed_paths)
    if not value["targets"]:
        raise ValueError("Planner returned no targets")
    for target in value["targets"]:
        if not isinstance(target, dict) or set(target) != {"path", "findings", "approach", "verification"}:
            raise ValueError("Planner target does not match the strict schema")
        if _normalize_path(target["path"]) not in allowed:
            raise ValueError(f"Planner selected a path outside the allowlist: {target.get('path')}")
        if not isinstance(target["findings"], list) or not all(isinstance(item, str) for item in target["findings"]):
            raise ValueError("Planner target findings must be strings")
        if not isinstance(target["approach"], str) or not isinstance(target["verification"], str):
            raise ValueError("Planner target text fields must be strings")
    return value


def _validate_implementor_json(value: dict[str, Any]) -> dict[str, Any]:
    if set(value) != {"summary", "changes"}:
        raise ValueError("Implementor response keys do not match the strict schema")
    if not isinstance(value["summary"], str) or not isinstance(value["changes"], list):
        raise ValueError("Implementor response has invalid field types")
    for change in value["changes"]:
        if not isinstance(change, dict) or set(change) != {"path", "reason", "format", "content"}:
            raise ValueError("Implementor change does not match the strict schema")
        if change["format"] not in {"unified_diff", "search_replace"} or not all(
            isinstance(change[field], str) for field in ("path", "reason", "content")
        ):
            raise ValueError("Implementor change contains invalid values")
    return value


def _normalize_path(value: Any) -> str:
    path = str(value or "").strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path.lstrip("/")


def _finding_paths(scan_data: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for finding in scan_data.get("code_security", []) or []:
        if not isinstance(finding, dict):
            continue
        candidates = [finding.get("primary_path"), finding.get("filename"), finding.get("file")]
        candidates.extend(
            occurrence.get("filename")
            for occurrence in (finding.get("occurrences", []) or [])
            if isinstance(occurrence, dict)
        )
        for candidate in candidates:
            path = _normalize_path(candidate)
            if path and path not in paths:
                paths.append(path)
    return paths


def _supply_packages(scan_data: dict[str, Any]) -> list[str]:
    packages: list[str] = []
    for finding in scan_data.get("supply_chain", []) or []:
        if not isinstance(finding, dict):
            continue
        package = str(finding.get("package") or finding.get("name") or "").strip().lower()
        if package and package not in packages:
            packages.append(package)
    return packages


def _read_context_candidates(paths: list[str]) -> dict[str, str]:
    """Read all candidate files in one helper container.

    The previous implementation launched one Docker container per file.  On
    Docker Desktop that made context collection take tens of seconds per batch.
    Base64 framing lets one read safely carry arbitrary source contents.
    """
    if not paths:
        return {}

    repo_root = get_repo_root()
    commands: list[str] = []
    for path in paths:
        encoded_path = base64.b64encode(path.encode("utf-8")).decode("ascii")
        target = shlex.quote(f"{repo_root}/{path}")
        commands.append(
            " ".join(
                [
                    f"printf '%s\\t' {shlex.quote(encoded_path)};",
                    f"head -c {MAX_FILE_BYTES} {target} 2>/dev/null | base64 | tr -d '\\n';",
                    "printf '\\n'",
                ]
            )
        )

    raw = _run_repo_shell("; ".join(commands), mode="ro")
    contexts: dict[str, str] = {}
    for row in raw.splitlines():
        if "\t" not in row:
            continue
        encoded_path, encoded_content = row.split("\t", 1)
        try:
            path = base64.b64decode(encoded_path).decode("utf-8")
            content = base64.b64decode(encoded_content).decode("utf-8")
        except Exception:
            continue
        if path in paths and content.strip():
            contexts[path] = content
    return contexts


def collect_remediation_contexts(scan_data: dict[str, Any]) -> dict[str, str]:
    """Collect vulnerability-first source context plus relevant manifests."""
    candidates = _list_candidate_files()
    allowed = set(candidates)

    source_paths: list[str] = []
    for raw_path in _finding_paths(scan_data):
        resolved = _resolve_path_against_allowed(raw_path, allowed)
        if resolved and resolved not in source_paths:
            source_paths.append(resolved)

    packages = _supply_packages(scan_data)
    # Manifests are useful for SCA fixes, but they displaced vulnerable source
    # files in code-only batches in the old workflow.
    manifest_paths = (
        [path for path in candidates if os.path.basename(path) in _EDITABLE_MANIFESTS]
        if packages
        else []
    )
    read_paths = list(dict.fromkeys([*source_paths, *manifest_paths]))
    all_contexts = _read_context_candidates(read_paths)

    ranked_manifests = sorted(
        manifest_paths,
        key=lambda path: (
            -sum(1 for package in packages if package in all_contexts.get(path, "").lower()),
            path.count("/"),
            path,
        ),
    )

    selected: list[str] = []
    for path in [*source_paths, *ranked_manifests]:
        if path in all_contexts and path not in selected:
            selected.append(path)
        if len(selected) >= SUPERVISOR_MAX_FILES:
            break
    return {path: all_contexts[path] for path in selected}


def _occurrence_lines(scan_data: dict[str, Any], path: str) -> list[int]:
    lines: list[int] = []
    for finding in scan_data.get("code_security", []) or []:
        if not isinstance(finding, dict):
            continue
        primary = _normalize_path(finding.get("primary_path"))
        if primary == path:
            try:
                primary_line = int(finding.get("line_number") or finding.get("line") or 0)
            except (TypeError, ValueError):
                primary_line = 0
            if primary_line > 0 and primary_line not in lines:
                lines.append(primary_line)
        for occurrence in finding.get("occurrences", []) or []:
            if not isinstance(occurrence, dict):
                continue
            occurrence_path = _normalize_path(occurrence.get("filename")) or primary
            if occurrence_path != path:
                continue
            try:
                line = int(occurrence.get("line_number") or occurrence.get("line") or 1)
            except (TypeError, ValueError):
                line = 1
            if line > 0 and line not in lines:
                lines.append(line)
    return sorted(lines)


def _source_excerpt(
    source_lines: list[str],
    line_numbers: list[int],
    max_chars: int,
) -> tuple[str, list[str]]:
    """Keep exact, editable source lines around findings within a packet cap."""
    if max_chars <= 0 or not source_lines:
        return "", []

    if not line_numbers:
        if sum(len(line) + 1 for line in source_lines) <= max_chars:
            return "\n".join(source_lines), []
        return "[No precise finding location was available; source omitted from this packet.]", []

    valid_lines = sorted({line for line in line_numbers if 1 <= line <= len(source_lines)})[:4]
    if not valid_lines:
        return "[Finding location is outside the current source file; source omitted from this packet.]", []

    for radius in (_SOURCE_WINDOW_LINES, 16, 8, 3, 1, 0):
        ranges: list[tuple[int, int]] = []
        for line in valid_lines:
            start = max(1, line - radius)
            end = min(len(source_lines), line + radius)
            if ranges and start <= ranges[-1][1] + 1:
                ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
            else:
                ranges.append((start, end))
        rendered = "\n\n".join("\n".join(source_lines[start - 1:end]) for start, end in ranges)
        if len(rendered) <= max_chars:
            return rendered, [f"{start}-{end}" for start, end in ranges]

    # A single physical source line can be larger than the request limit.
    # Never cut that line: an implementor would otherwise create a search/
    # replace patch that cannot be validated against the actual repository.
    line = valid_lines[0]
    return (
        f"[Line {line} exceeds the safe context budget; this finding requires manual source review.]",
        [f"{line}-{line}"],
    )


def _render_contexts(state: RemediationWorkflowState, max_chars: int = SUPERVISOR_MAX_CONTEXT_CHARS) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    consumed = 0
    contexts = state.get("contexts", {})
    paths = list(contexts)
    manifest_count = sum(os.path.basename(path) in _EDITABLE_MANIFESTS for path in paths)
    source_count = len(paths) - manifest_count
    if manifest_count and source_count:
        manifest_cap = min(1200, max(120, max_chars // (len(paths) * 2)))
        source_cap = max(120, (max_chars - manifest_cap * manifest_count) // source_count)
    else:
        manifest_cap = source_cap = max(120, max_chars // max(1, len(paths)))

    for path, content in contexts.items():
        if consumed >= max_chars:
            break
        text = str(content or "")
        line_numbers = _occurrence_lines(state["scan_data"], path)
        remaining = max_chars - consumed
        path_cap = manifest_cap if os.path.basename(path) in _EDITABLE_MANIFESTS else source_cap
        excerpt_cap = min(remaining, path_cap)
        if os.path.basename(path) in _EDITABLE_MANIFESTS:
            rendered = text
            location_value: list[str] = []
            if len(rendered) > excerpt_cap:
                marker = "\n[Manifest context omitted after this point; do not assume omitted dependencies are unchanged.]"
                if excerpt_cap <= len(marker):
                    rendered = "[Manifest context omitted.]"[:excerpt_cap]
                else:
                    rendered = rendered[:excerpt_cap - len(marker)] + marker
        else:
            rendered, location_value = _source_excerpt(text.splitlines(), line_numbers, excerpt_cap)
        if not rendered.strip():
            continue
        sections.append({"path": path, "line_ranges": location_value, "excerpt": rendered})
        consumed += len(rendered)
    return sections


def _compact_findings(scan_data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    code: list[dict[str, Any]] = []
    for finding in (scan_data.get("code_security", []) or [])[:SUPERVISOR_MAX_FINDINGS]:
        if not isinstance(finding, dict):
            continue
        code.append(
            {
                "cwe_id": finding.get("cwe_id"),
                "severity": finding.get("severity"),
                "title": finding.get("title") or finding.get("name"),
                "description": str(finding.get("description") or "")[:240],
                "primary_path": finding.get("primary_path"),
                "occurrences": (finding.get("occurrences") or [])[:4],
                "root_cause_key": finding.get("root_cause_key"),
            }
        )

    supply: list[dict[str, Any]] = []
    for finding in (scan_data.get("supply_chain", []) or [])[:SUPERVISOR_MAX_FINDINGS]:
        if not isinstance(finding, dict):
            continue
        supply.append(
            {
                "cve_id": finding.get("cve_id"),
                "severity": finding.get("severity"),
                "package": finding.get("package") or finding.get("name"),
                "installed_version": finding.get("installed_version") or finding.get("version"),
                "fix_version": finding.get("fix_version"),
                "related_cve_ids": (finding.get("related_cve_ids") or [])[:8],
                "root_cause_key": finding.get("root_cause_key"),
            }
        )
    return {"code_security": code, "supply_chain": supply}


def _uses_low_quota_openrouter_model(state: RemediationWorkflowState) -> bool:
    model = str(state.get("llm_model") or "").lower()
    provider = str(state.get("llm_provider") or "").lower()
    return provider == "openrouter" or any(marker in model for marker in _LOW_QUOTA_OPENROUTER_MARKERS)


def _prompt_char_limit(state: RemediationWorkflowState, stage: str) -> int:
    # Do not silently truncate a packet. The caller packetizes instead. The
    # gateway clamps the completion budget against OpenRouter's exact free-tier
    # request cap after this bounded source packet is assembled.
    return max(2_000, min(4_600, SUPERVISOR_MAX_PROMPT_CHARS))


def _stage_max_tokens(state: RemediationWorkflowState, stage: str) -> int | None:
    return 3_072 if stage == "implementor" else 1_024


def _json_prompt(payload: dict[str, Any], *, max_chars: int) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > max_chars:
        raise ValueError("CONTEXT_LIMIT: split this packet; required repository context was not truncated")
    return raw


def _bounded_reference_context(value: object) -> str:
    text = str(value or "")
    max_chars = 600
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 92] + "\n[OpenWiki context omitted after this point; verify against the current source.]"


def _prompt_with_bounded_context(
    payload: dict[str, Any],
    state: RemediationWorkflowState,
    *,
    stage: str,
) -> str:
    """Fit source evidence into the actual JSON prompt limit without truncating code lines."""
    max_chars = _prompt_char_limit(state, stage)
    prompt_input = dict(payload["input"])
    prompt_input["repository_context"] = []
    payload_without_sources = {**payload, "input": prompt_input}
    available = max(0, max_chars - len(json.dumps(payload_without_sources, ensure_ascii=False, separators=(",", ":"))) - 160)

    while True:
        candidate_input = dict(prompt_input)
        candidate_input["repository_context"] = _render_contexts(state, max_chars=available)
        candidate = {**payload, "input": candidate_input}
        serialized = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"))
        if len(serialized) <= max_chars:
            return serialized
        if available <= 0:
            return _json_prompt(payload_without_sources, max_chars=max_chars)
        available = max(0, available - max(96, len(serialized) - max_chars + 64))


def _planner_prompt(state: RemediationWorkflowState) -> str:
    return _prompt_with_bounded_context(
        {
            "schema_version": "remediation.request.v2",
            "stage": "planner",
            "system": _prompt_system_guard("planner"),
            "rules": [
                "Your response MUST be a single JSON object. No prose, no markdown fences, no commentary.",
                "Required top-level keys (exact, in this order): summary, targets, constraints.",
                "targets is a non-empty array. Every target must have keys: path, findings, approach, verification.",
                "path MUST be one of the allowed_paths exactly as listed. No invented paths.",
                "summary must be a non-empty string of <= 800 chars.",
                "constraints must be an array (use [] if none).",
                "If you cannot map a finding, still return a target for it with approach='manual review required'.",
            ],
            "input": {
                "allowed_paths": state["allowed_paths"],
                "findings": _compact_findings(state["scan_data"]),
                "repository_context": [],
                "reference_context": _bounded_reference_context(state.get("wiki_context", "")),
            },
        },
        state,
        stage="planner",
    )


def _implementor_prompt(state: RemediationWorkflowState) -> str:
    return _prompt_with_bounded_context(
        {
            "schema_version": "remediation.request.v2",
            "stage": "implementor",
            "system": _prompt_system_guard("implementor"),
            "rules": [
                "Your response MUST be a single JSON object. No prose, no markdown fences, no commentary.",
                "Required top-level keys (exact): summary, changes.",
                "Each change object MUST have keys: path, reason, format, content.",
                "Use format='search_replace' unless a unified diff is clearly easier. It is more reliable for free coding models.",
                "For format='search_replace', content MUST contain one or more exact blocks: <<<<<<< SEARCH\\n<existing text>\\n=======\\n<replacement text>\\n>>>>>>> REPLACE. The SEARCH text must occur exactly once in the repository context.",
                "For format='unified_diff', content must start with '--- a/<path>' on the first line and contain '+++ b/<path>' on the second line, followed by @@ hunks.",
                "path MUST be one of the allowed_paths exactly. Do not invent paths.",
                "Every SEARCH block must match the current source EXACTLY including indentation; copy lines verbatim from repository_context.",
                "If a path needs several edits, put multiple SEARCH/REPLACE blocks in that path's single change object.",
                "summary must be a non-empty string of <= 800 chars describing what was fixed.",
                "If no changes are needed, return changes=[]. Never invent fixes.",
            ],
            "input": {
                "plan": state.get("plan") or {},
                "allowed_paths": state["allowed_paths"],
                "findings": _compact_findings(state["scan_data"]),
                "repository_context": [],
                "reference_context": _bounded_reference_context(state.get("wiki_context", "")),
            },
        },
        state,
        stage="implementor",
    )


def _search_replace_to_unified_diff(path: str, before: str, content: str) -> str:
    """Apply exact SEARCH/REPLACE blocks locally and return a unified diff.

    The format is intentionally narrow: every search string must have exactly
    one match in the evolving source. This gives free models an easier output
    contract while preserving deterministic patch validation downstream.
    """
    import difflib
    import re

    pattern = re.compile(
        r"^<<<<<<< SEARCH\r?\n(.*?)\r?\n=======\r?\n(.*?)(?:\r?\n)?>>>>>>> REPLACE$",
        re.MULTILINE | re.DOTALL,
    )
    blocks = pattern.findall(content.strip())
    if not blocks:
        raise ValueError("search_replace must contain at least one complete SEARCH/REPLACE block")

    after = before
    for search_text, replace_text in blocks:
        if not search_text:
            raise ValueError("search_replace cannot use an empty SEARCH block")
        matches = after.count(search_text)
        if matches != 1:
            raise ValueError(f"SEARCH block must match exactly once (matched {matches})")
        after = after.replace(search_text, replace_text, 1)
    if after == before:
        raise ValueError("search_replace produced no source change")
    return "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
        )
    )


def _change_diff(change: dict[str, Any]) -> str:
    explicit = change.get("diff")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    content = change.get("content")
    fmt = str(change.get("format") or "").strip().lower()
    if (
        isinstance(content, str)
        and fmt in {"diff", "patch", "unified_diff"}
    ):
        return content.strip()
    if isinstance(content, str) and content.lstrip().startswith("--- ") and "\n+++ " in content:
        return content.strip()
    return ""


def _proposal_preflight(state: RemediationWorkflowState) -> tuple[list[dict[str, str]], list[str]]:
    valid: list[dict[str, str]] = []
    errors: list[str] = []
    allowed = set(state.get("allowed_paths") or [])
    changes = (state.get("proposal") or {}).get("changes") or []
    if not isinstance(changes, list) or not changes:
        return [], ["Implementor returned no changes."]

    seen: set[str] = set()
    for raw in changes:
        if not isinstance(raw, dict):
            errors.append("Implementor returned a non-object change.")
            continue
        raw_path = str(raw.get("path") or "").strip()
        path = _resolve_path_against_allowed(raw_path, allowed)
        if not path:
            errors.append(f"{raw_path or '(missing path)'} is outside the editable context.")
            continue
        if path in seen:
            errors.append(f"{path} was proposed more than once.")
            continue
        before = state.get("contexts", {}).get(path)
        if before is None:
            before = _read_file(path, max_bytes=200_000)
        fmt = str(raw.get("format") or "").strip().lower()
        try:
            if fmt == "search_replace":
                content = raw.get("content")
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("search_replace content is empty")
                diff = _search_replace_to_unified_diff(path, before, content)
            else:
                diff = _change_diff(raw)
                if not diff:
                    raise ValueError("unified diff is empty")
            after = DiffValidator._apply_unified_diff(before, diff)
        except Exception as exc:
            errors.append(f"{path} patch does not apply: {exc}")
            continue
        ok, reason = _validate_change_candidate(path, before, after)
        if not ok:
            errors.append(f"{path} failed safety validation: {reason}")
            continue
        seen.add(path)
        valid.append(
            {
                "path": path,
                "reason": str(raw.get("reason") or "Security remediation").strip(),
                "diff": diff,
                "after": after,
            }
        )
    return valid, errors


def _vulnerability_ids_for_path(state: RemediationWorkflowState, path: str) -> list[str]:
    identifiers: list[str] = []

    def add(value: Any, prefix: str = "") -> None:
        text = str(value or "").strip()
        if not text:
            return
        if prefix and not text.upper().startswith(prefix):
            text = f"{prefix}{text}"
        if text not in identifiers:
            identifiers.append(text)

    for finding in state.get("scan_data", {}).get("code_security", []) or []:
        if not isinstance(finding, dict):
            continue
        finding_paths = {
            _normalize_path(finding.get("primary_path")),
            _normalize_path(finding.get("filename")),
            _normalize_path(finding.get("file")),
        }
        finding_paths.update(
            _normalize_path(item.get("filename"))
            for item in (finding.get("occurrences", []) or [])
            if isinstance(item, dict)
        )
        if path in finding_paths:
            add(finding.get("cwe_id"), "CWE-")
            add(finding.get("root_cause_key"))

    if os.path.basename(path) in _EDITABLE_MANIFESTS:
        manifest = str(state.get("contexts", {}).get(path) or "").lower()
        for finding in state.get("scan_data", {}).get("supply_chain", []) or []:
            if not isinstance(finding, dict):
                continue
            package = str(finding.get("package") or finding.get("name") or "").strip().lower()
            if package and package in manifest:
                add(finding.get("cve_id"))
                add(finding.get("root_cause_key"))
    return identifiers


def _bind_runtime_context(state: RemediationWorkflowState) -> None:
    set_current_project_id(state.get("project_id", ""))
    bind_remediation_run(state.get("remediation_run_id"))
    try:
        from ai_gateway import bind_ai_context

        bind_ai_context(
            user_id=state.get("user_id"),
            organization_id=state.get("organization_id"),
        )
    except Exception:
        pass


def _llm(
    state: RemediationWorkflowState,
    prompt: str,
    stage: str,
    *,
    max_tokens: int | None = None,
    temperature: float = 0.15,
) -> tuple[bool, str]:
    _bind_runtime_context(state)
    return _dispatch_llm(
        prompt,
        provider=state.get("llm_provider", ""),
        api_key=state.get("llm_api_key", ""),
        model=state.get("llm_model", ""),
        budget_tracker=state.get("budget_tracker"),
        stage=stage,
        user_id=state.get("user_id", ""),
        organization_id=state.get("organization_id", ""),
        access_mode="platform",
        credential_id="",
        max_tokens=max_tokens,
        # Native json_schema mode is not portable across OpenRouter free
        # upstreams. The workflow enforces these schemas locally instead.
        response_format=None,
        temperature=temperature,
    )


def _retry_contract_prompt(prompt: str, error: Exception) -> str:
    """Ask once more without relying on provider-native schema support."""
    return (
        "RETRY: The prior response violated the local JSON contract ("
        f"{str(error)[:180]}). Reply with exactly one JSON object and no markdown.\n"
        + prompt
    )


def _json_contract_call(
    state: RemediationWorkflowState,
    prompt: str,
    stage: str,
    *,
    max_tokens: int,
    validator,
) -> tuple[bool, dict[str, Any] | str]:
    """Obtain locally validated JSON from a free model, with one repair retry.

    This is strict at the trust boundary, but intentionally does *not* use
    OpenRouter's ``response_format=json_schema``. Some free upstreams reject
    that optional API feature with HTTP 400 even when their normal chat output
    is valid JSON.
    """
    last_error: Exception | None = None
    for attempt in range(2):
        attempt_prompt = prompt if attempt == 0 else _retry_contract_prompt(prompt, last_error or ValueError("invalid JSON"))
        ok, raw = _llm(state, attempt_prompt, stage, max_tokens=max_tokens)
        if not ok:
            return False, raw
        try:
            parsed = _extract_json(raw)
            return True, validator(parsed)
        except Exception as exc:
            last_error = exc
    return False, f"local JSON contract failed after retry: {last_error}"


def _master_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    _bind_runtime_context(state)
    if not state.get("scan_data"):
        return {**state, "error": "Master received no scanner findings."}
    if not state.get("contexts"):
        return {**state, "error": "Master received no readable vulnerable source context."}
    if not state.get("allowed_paths"):
        return {**state, "error": "Master received an empty editable path allowlist."}
    return state


def _planner_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    ok, result = _json_contract_call(
        state,
        _planner_prompt(state),
        "workflow_planner",
        max_tokens=_stage_max_tokens(state, "planner") or 1_024,
        validator=lambda value: _validate_planner_json(value, state.get("allowed_paths") or []),
    )
    if not ok:
        return {**state, "error": f"Planner local JSON contract failed: {result}"}
    parsed = result
    assert isinstance(parsed, dict)
    remediation_runs.store_agent_artifact(
        state.get("remediation_run_id"), "planner", parsed, count_llm_call=True
    )
    return {**state, "plan": parsed, "planner_warning": ""}


def _implementor_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    ok, result = _json_contract_call(
        state,
        _implementor_prompt(state),
        "workflow_implementor",
        max_tokens=_stage_max_tokens(state, "implementor") or 3_072,
        validator=_validate_implementor_json,
    )
    if not ok:
        return {
            **state,
            "proposal": {"summary": "Malformed implementor output.", "changes": []},
            "proposer_parse_warning": f"Implementor local JSON contract error: {result}",
            "error": f"Implementor local JSON contract failed: {result}",
        }
    parsed = result
    assert isinstance(parsed, dict)
    changes = parsed["changes"]
    proposal = {
        "summary": str(parsed.get("summary") or "").strip(),
        "changes": changes,
    }
    remediation_runs.store_agent_artifact(
        state.get("remediation_run_id"), "implementor", proposal, count_llm_call=True
    )
    return {**state, "proposal": proposal, "proposer_parse_warning": ""}


def _record_review(
    state: RemediationWorkflowState,
    critique: dict[str, Any],
) -> RemediationWorkflowState:
    history = list(state.get("attempt_history") or [])
    history.append(
        {
            "round": int(state.get("round", 0)) + 1,
            "proposal": state.get("proposal") or {},
            "critique": critique,
        }
    )
    return {**state, "critique": critique, "attempt_history": history}


def _reviewer_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    valid, errors = _proposal_preflight(state)
    planned_paths = {
        _normalize_path(target.get("path"))
        for target in (state.get("plan") or {}).get("targets", [])
        if isinstance(target, dict)
    }
    changed_paths = {item["path"] for item in valid}
    proposed_count = len((state.get("proposal") or {}).get("changes") or [])
    scope_ok = not errors and bool(changed_paths) and changed_paths.issubset(set(state.get("allowed_paths") or []))
    patch_ok = not errors and len(valid) == proposed_count and proposed_count > 0
    safety_ok = patch_ok  # _proposal_preflight runs the local language-aware safety validator.
    coverage_ok = bool(planned_paths) and planned_paths.issubset(changed_paths)
    minimal_ok = proposed_count <= max(1, len(planned_paths)) and all(len(item["diff"]) <= 20_000 for item in valid)
    checks = {
        "allowed_file_scope": {"passed": scope_ok, "points": 25 if scope_ok else 0, "maximum": 25},
        "patch_integrity": {"passed": patch_ok, "points": 20 if patch_ok else 0, "maximum": 20},
        "syntax_and_safety": {"passed": safety_ok, "points": 20 if safety_ok else 0, "maximum": 20},
        "planned_finding_coverage": {"passed": coverage_ok, "points": 25 if coverage_ok else 0, "maximum": 25},
        "minimal_change": {"passed": minimal_ok, "points": 10 if minimal_ok else 0, "maximum": 10},
    }
    score = sum(int(check["points"]) for check in checks.values())
    accepted = not errors and score >= _REVIEW_MIN_SCORE
    missing = list(errors[:8])
    if not coverage_ok:
        missing.append("The patch does not cover every path in the approved plan.")
    critique = {
        "verdict": "accept" if accepted else "reject",
        "feedback": (
            "Deterministic local review passed."
            if accepted
            else "Deterministic local review failed: " + "; ".join(missing or [f"score below {_REVIEW_MIN_SCORE}"])
        ),
        "missing": missing,
        "quality_score": score,
        "score_maximum": 100,
        "checks": checks,
    }
    remediation_runs.store_agent_artifact(state.get("remediation_run_id"), "reviewer", critique)
    return _record_review(state, critique)


def _synthesizer_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    valid, errors = _proposal_preflight(state)
    changed_files: list[dict[str, Any]] = []
    if (state.get("critique") or {}).get("verdict") != "accept":
        errors = errors + ["Local review rejected this patch set; changes were not accepted."]
        valid = []
    for item in valid:
        if state.get("persist_changes", False):
            _write_file(item["path"], item["after"])
        changed_files.append(
            {
                "path": item["path"],
                "reason": item["reason"],
                "diff": item["diff"],
                "vulns_addressed": _vulnerability_ids_for_path(state, item["path"]),
            }
        )

    critique = state.get("critique") or {}
    final = {
        "summary": str((state.get("proposal") or {}).get("summary") or "Remediation completed."),
        "changed_files": changed_files,
        "rejected_changes": [{"path": "", "reason": error} for error in errors],
        "proposed_change_count": len((state.get("proposal") or {}).get("changes") or []),
        "applied_change_count": len(changed_files),
        "files_considered": list(state.get("contexts", {}).keys()),
        "negotiation_rounds": 1,
        "critic_verdict": critique.get("verdict", "reject"),
        "critic_score": critique.get("quality_score", 0),
        "attempt_history": state.get("attempt_history") or [],
        "planner_warning": state.get("planner_warning") or "",
        "workflow": "master_planner_implementor_local_reviewer",
        "llm_calls": 2 + int(state.get("round", 0)),
        "llm_cost_usd": round(float(getattr(state.get("budget_tracker"), "total_usd", 0.0)), 6),
    }
    return {**state, "final_result": final}


def _route_after_master(state: RemediationWorkflowState) -> str:
    return "error_end" if state.get("error") else "planner"


def _route_after_implementor(state: RemediationWorkflowState) -> str:
    return "error_end" if state.get("error") else "reviewer"


def build_remediation_graph(checkpointer: Any | None = None) -> Any:
    graph = StateGraph(RemediationWorkflowState)
    graph.add_node("master", _master_node)
    graph.add_node("planner", _planner_node)
    graph.add_node("implementor", _implementor_node)
    graph.add_node("reviewer", _reviewer_node)
    def repair(state):
        repaired = {**state, "round": 1, "plan": {**state.get("plan", {}),
            "review_feedback": state.get("critique", {}).get("missing", [])}}
        return _implementor_node(repaired)
    graph.add_node("repair", repair)
    graph.add_node("synthesizer", _synthesizer_node)
    graph.add_node("error_end", lambda state: state)

    graph.set_entry_point("master")
    graph.add_conditional_edges(
        "master",
        _route_after_master,
        {"planner": "planner", "error_end": "error_end"},
    )
    graph.add_edge("planner", "implementor")
    graph.add_conditional_edges(
        "implementor",
        _route_after_implementor,
        {"reviewer": "reviewer", "error_end": "error_end"},
    )
    graph.add_conditional_edges("reviewer", lambda state: "repair" if state.get("critique", {}).get("verdict") == "reject"
        and state.get("critique", {}).get("missing") and state.get("round", 0) == 0 else "synthesizer",
        {"repair": "repair", "synthesizer": "synthesizer"})
    graph.add_conditional_edges("repair", _route_after_implementor, {"reviewer": "reviewer", "error_end": "error_end"})
    graph.add_edge("synthesizer", END)
    graph.add_edge("error_end", END)
    return graph.compile(checkpointer=checkpointer)


async def run_remediation_workflow(
    scan_data: dict[str, Any],
    *,
    project_id: str,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    budget_tracker: ClaudeBudgetTracker | None = None,
    on_message=None,
    user_id: str | None = None,
    organization_id: str | None = None,
    access_mode: str | None = None,
    llm_credential_id: str | None = None,
    persist_changes: bool = False,
    remediation_run_id: str | None = None,
) -> tuple[bool, dict[str, Any] | str]:
    async def emit(message_type: str, content: str) -> None:
        if on_message:
            await on_message(message_type, content)

    set_current_project_id(project_id)
    run_id = str(remediation_run_id or "").strip()
    bind_remediation_run(run_id)
    await emit("supervisor_phase", "Master is collecting vulnerability-centered repository context.")
    try:
        contexts = await asyncio.to_thread(collect_remediation_contexts, scan_data)
    except Exception as exc:
        return False, f"Master failed to collect repository context: {exc}"
    if not contexts:
        return False, "No readable vulnerable source files or editable manifests were found."

    state: RemediationWorkflowState = {
        "project_id": project_id,
        "remediation_run_id": run_id,
        "scan_data": scan_data,
        "contexts": contexts,
        "allowed_paths": list(contexts),
        "llm_provider": "openrouter",
        "llm_api_key": "",
        "llm_model": "openrouter/free",
        "user_id": str(user_id or ""),
        "organization_id": str(organization_id or ""),
        "llm_access_mode": "platform",
        "llm_credential_id": "",
        "budget_tracker": budget_tracker,
        "persist_changes": persist_changes,
        "round": 0,
        "plan": {},
        "planner_warning": "",
        "proposal": {},
        "proposer_parse_warning": "",
        "critique": {},
        "attempt_history": [],
        "final_result": {},
        "error": "",
    }

    from openwiki_context import wiki_context
    wiki, wiki_status = await asyncio.to_thread(wiki_context, project_id=project_id,
        tenant=str(organization_id or ""), user_id=str(user_id or ""), run_id=run_id,
        model="openrouter/free", contexts=contexts,
        repository_id=str(scan_data.get("project_id") or ""), revision=str(scan_data.get("source_revision") or ""))
    state["wiki_context"] = wiki
    await emit("info", wiki_status)

    thread_id = f"remediation:{project_id}:{run_id or uuid4()}"
    # Full LangGraph checkpoints contain source excerpts. Persist only compact,
    # embedded agent artifacts in Mongo and keep transient source context local.
    checkpointer = MemorySaver()
    checkpoint_backend = "mongodb_artifacts" if remediation_runs.enabled else "memory"
    remediation_runs.mark_status(run_id, "running", checkpoint_backend=checkpoint_backend)
    graph = build_remediation_graph(checkpointer=checkpointer)
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": 10,
    }
    latest = state

    await emit(
        "planner_phase",
        f"Master selected {len(contexts)} context file(s); Planner is mapping findings to fixes.",
    )
    try:
        async with asyncio.timeout(max(AGENT_NODE_TIMEOUT_SECONDS * 2, 300)):
            async for update in graph.astream(state, config=config, stream_mode="updates"):
                if not isinstance(update, dict):
                    continue
                for node, payload in update.items():
                    if isinstance(payload, dict):
                        latest = {**latest, **payload}
                    if node == "planner":
                        targets = len((latest.get("plan") or {}).get("targets") or [])
                        warning = str(latest.get("planner_warning") or "").strip()
                        if warning:
                            await emit("warning", warning)
                        await emit(
                            "implementor_phase",
                            f"Planner persisted {targets} target(s); Implementor is generating patches in the generation call.",
                        )
                    elif node == "implementor":
                        changes = len((latest.get("proposal") or {}).get("changes") or [])
                        await emit("info", f"Implementor proposed {changes} change(s).")
                        await emit("reviewer_phase", "Local reviewer is validating the patch without an LLM call.")
                    elif node == "reviewer":
                        critique = latest.get("critique") or {}
                        verdict = str(critique.get("verdict") or "reject").upper()
                        score = int(critique.get("quality_score") or 0)
                        feedback = str(critique.get("feedback") or "")[:300]
                        await emit(
                            "success" if verdict == "ACCEPT" else "warning",
                            f"Local reviewer: {verdict} ({score}/100) - {feedback}",
                        )
                    elif node == "synthesizer":
                        await emit("synthesizer_phase", "Synthesizer validated the accepted patch set.")
    except TimeoutError:
        return False, "Multi-agent remediation timed out while waiting for the model workflow."
    except Exception as exc:
        return False, f"LangGraph remediation execution failed: {type(exc).__name__}: {exc}"

    if latest.get("error"):
        return False, str(latest["error"])
    final = dict(latest.get("final_result") or {})
    if not final:
        return False, "LangGraph remediation ended without a synthesized result."
    final["graph_thread_id"] = thread_id
    final["checkpoint_backend"] = checkpoint_backend
    return True, final


__all__ = [
    "RemediationWorkflowState",
    "build_remediation_graph",
    "collect_remediation_contexts",
    "run_remediation_workflow",
]

"""Checkpointed LangGraph workflow for multi-agent code remediation.

The workflow is deliberately stateful:

    Master -> Planner -> Implementor -> Reviewer
                                  ^          |
                                  |-- retry -|
                                             -> Synthesizer

Every node receives the same ``RemediationWorkflowState``.  The reviewer writes
its critique into that state before the retry edge sends it back to the
implementor, so plans, repository snippets, previous proposals, and feedback are
not reconstructed or lost between agents.
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
from utils import get_repo_root, set_current_project_id

from .remediation_supervisor import (
    AGENT_NODE_TIMEOUT_SECONDS,
    MAX_ROUNDS,
    SUPERVISOR_MAX_CONTEXT_CHARS,
    SUPERVISOR_MAX_FILES,
    SUPERVISOR_MAX_FINDINGS,
    SUPERVISOR_MAX_PROMPT_CHARS,
    _dispatch_llm,
)


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


_REVIEW_MIN_SCORE = _env_int("REMEDIATION_CRITIC_MIN_SCORE", 6, minimum=0, maximum=10)
_SOURCE_WINDOW_LINES = _env_int("REMEDIATION_SUPERVISOR_CONTEXT_LINES", 30, minimum=8)
_LOW_QUOTA_OPENROUTER_MARKERS = (
    "minimax-m3",
    "minimax-m2.7",
    "nemotron",
)


class RemediationWorkflowState(TypedDict):
    project_id: str
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


def _render_contexts(state: RemediationWorkflowState, max_chars: int = SUPERVISOR_MAX_CONTEXT_CHARS) -> str:
    sections: list[str] = []
    consumed = 0
    contexts = state.get("contexts", {})
    paths = list(contexts)
    manifest_count = sum(os.path.basename(path) in _EDITABLE_MANIFESTS for path in paths)
    source_count = len(paths) - manifest_count
    if manifest_count and source_count:
        manifest_cap = min(1200, max(600, max_chars // (len(paths) * 2)))
        source_cap = max(800, (max_chars - manifest_cap * manifest_count) // source_count)
    else:
        manifest_cap = source_cap = max(800, max_chars // max(1, len(paths)))

    for path, content in contexts.items():
        if consumed >= max_chars:
            break
        text = str(content or "")
        line_numbers = _occurrence_lines(state["scan_data"], path)
        if line_numbers and len(text) > 5000:
            source_lines = text.splitlines()
            ranges: list[tuple[int, int]] = []
            for line in line_numbers[:4]:
                start = max(1, line - _SOURCE_WINDOW_LINES)
                end = min(len(source_lines), line + _SOURCE_WINDOW_LINES)
                if ranges and start <= ranges[-1][1] + 1:
                    ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
                else:
                    ranges.append((start, end))
            chunks = ["\n".join(source_lines[start - 1:end]) for start, end in ranges]
            imports = "\n".join(source_lines[:20])
            rendered = imports + "\n\n" + "\n\n".join(chunks)
            location = ", ".join(f"{start}-{end}" for start, end in ranges)
            header = f"### {path} (imports plus vulnerable lines {location})"
        else:
            rendered = text
            header = f"### {path}"

        remaining = max_chars - consumed
        path_cap = manifest_cap if os.path.basename(path) in _EDITABLE_MANIFESTS else source_cap
        rendered = rendered[: min(remaining, path_cap)]
        if not rendered.strip():
            continue
        sections.append(f"{header}\n```text\n{rendered}\n```")
        consumed += len(rendered)
    return "\n\n".join(sections)


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


def _prompt_char_limit(state: RemediationWorkflowState) -> int:
    if not _uses_low_quota_openrouter_model(state):
        return SUPERVISOR_MAX_PROMPT_CHARS
    # The Connector gateway budgets low-quota prompts byte-conservatively.
    # Leave enough headroom for the implementor's 2K completion below 8K.
    return min(
        SUPERVISOR_MAX_PROMPT_CHARS,
        _env_int("REMEDIATION_OPENROUTER_PROMPT_CHAR_CAP", 5_000, minimum=1_024, maximum=5_000),
    )


def _stage_max_tokens(state: RemediationWorkflowState, stage: str) -> int | None:
    if not _uses_low_quota_openrouter_model(state):
        return None
    if stage == "implementor":
        return _env_int("REMEDIATION_OPENROUTER_IMPLEMENTOR_MAX_TOKENS", 2_048, minimum=256, maximum=2_048)
    return _env_int("REMEDIATION_OPENROUTER_REVIEW_MAX_TOKENS", 1_024, minimum=256, maximum=1_024)


def _bounded_prompt(value: str, *, max_chars: int = SUPERVISOR_MAX_PROMPT_CHARS) -> str:
    if len(value) <= max_chars:
        return value
    marker = "\n[context truncated at configured prompt limit]"
    return value[: max_chars - len(marker)] + marker


def _planner_prompt(state: RemediationWorkflowState) -> str:
    return _bounded_prompt(
        f"""You are the Planner in a security remediation workflow.

Create a minimal implementation plan that maps every critical/high finding to
an allowed repository file and a concrete safe fix. Do not write code yet.
Return ONLY JSON:
{{"summary":"...","targets":[{{"path":"...","findings":["CWE/CVE"],"approach":"...","verification":"..."}}],"constraints":["..."]}}

Allowed paths:
{json.dumps(state['allowed_paths'])}

Findings:
{json.dumps(_compact_findings(state['scan_data']), indent=2)}

Vulnerability-centered repository context:
        {_render_contexts(state)}""",
        max_chars=_prompt_char_limit(state),
    )


def _implementor_prompt(state: RemediationWorkflowState) -> str:
    critique = state.get("critique") or {}
    feedback = ""
    if state.get("round", 0) > 0:
        feedback = (
            "\nReviewer feedback from the previous attempt:\n"
            + json.dumps(critique, indent=2)
            + "\nYou must address every rejection reason.\n"
        )
    return _bounded_prompt(
        f"""You are the Implementor in a security remediation workflow.

Implement the Planner's approved approach using minimal unified diffs. Return
ONLY valid JSON. Put the unified diff in the `content` field so newlines and
quotes are JSON escaped correctly:
{{"summary":"...","changes":[{{"path":"relative/file","reason":"...","format":"unified_diff","content":"--- a/file\\n+++ b/file\\n@@ ..."}}]}}

Rules:
1. Modify only an allowed path.
2. Use exact context lines from the repository excerpts; do not invent APIs.
3. Keep at least three unchanged context lines around each diff hunk where available.
4. Fix critical/high findings only. Do not perform unrelated refactors.
5. Dependency upgrades must target a supplied editable manifest and its known fix version.

Plan:
{json.dumps(state.get('plan') or {}, indent=2)}
{feedback}
Findings:
{json.dumps(_compact_findings(state['scan_data']), indent=2)}

Allowed paths:
{json.dumps(state['allowed_paths'])}

Repository context:
        {_render_contexts(state)}""",
        max_chars=_prompt_char_limit(state),
    )


def _change_diff(change: dict[str, Any]) -> str:
    explicit = change.get("diff")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    content = change.get("content")
    if (
        isinstance(content, str)
        and str(change.get("format") or "").strip().lower() in {"diff", "patch", "unified_diff"}
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
        diff = _change_diff(raw)
        if not diff:
            errors.append(f"{path} did not contain a unified diff.")
            continue
        before = state.get("contexts", {}).get(path)
        if before is None:
            before = _read_file(path, max_bytes=200_000)
        try:
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


def _reviewer_prompt(state: RemediationWorkflowState, valid: list[dict[str, str]]) -> str:
    review_changes = [
        {"path": item["path"], "reason": item["reason"], "diff": item["diff"][:5000]}
        for item in valid
    ]
    return _bounded_prompt(
        f"""You are the Reviewer in a security remediation workflow.

Review the exact unified diffs against the Planner plan, findings, and source
context. Reject patches that do not fix the root cause, change the wrong file,
break syntax/behavior, weaken security, or omit a critical/high target.
Return ONLY JSON:
{{"verdict":"accept|reject","feedback":"...","missing":["..."],"quality_score":0}}

Planner plan:
{json.dumps(state.get('plan') or {}, indent=2)}

Findings:
{json.dumps(_compact_findings(state['scan_data']), indent=2)}

Proposed, locally-applicable diffs:
{json.dumps(review_changes, indent=2)}

Relevant source context:
        {_render_contexts(state, max_chars=8000)}""",
        max_chars=_prompt_char_limit(state),
    )


def _bind_runtime_context(state: RemediationWorkflowState) -> None:
    set_current_project_id(state.get("project_id", ""))
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
        access_mode=state.get("llm_access_mode", "auto"),
        credential_id=state.get("llm_credential_id", ""),
        max_tokens=max_tokens,
    )


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
    ok, raw = _llm(
        state,
        _planner_prompt(state),
        "workflow_planner",
        max_tokens=_stage_max_tokens(state, "planner"),
    )
    if ok:
        try:
            parsed = _extract_json(raw)
            targets = parsed.get("targets")
            if isinstance(targets, list) and targets:
                return {
                    **state,
                    "plan": parsed,
                    "planner_warning": "",
                }
        except Exception as exc:
            warning = f"Planner output was not valid JSON: {exc}"
        else:
            warning = "Planner returned no remediation targets."
    else:
        warning = f"Planner model call failed: {raw}"

    fallback_targets = [
        {
            "path": path,
            "findings": [],
            "approach": "Apply a minimal fix for the scanner findings mapped to this file.",
            "verification": "Patch must apply cleanly and pass syntax validation.",
        }
        for path in state.get("allowed_paths", [])
    ]
    return {
        **state,
        "plan": {
            "summary": "Deterministic fallback plan built from vulnerability-mapped files.",
            "targets": fallback_targets,
            "constraints": ["Critical/high only", "Minimal changes", "No unrelated refactors"],
        },
        "planner_warning": warning,
    }


def _implementor_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    round_number = int(state.get("round", 0)) + 1
    ok, raw = _llm(
        state,
        _implementor_prompt(state),
        f"workflow_implementor_round_{round_number}",
        max_tokens=_stage_max_tokens(state, "implementor"),
    )
    if not ok:
        return {**state, "error": f"Implementor model call failed: {raw}"}
    try:
        parsed = _extract_json(raw)
        changes = parsed.get("changes")
        if not isinstance(changes, list):
            raise ValueError("`changes` was not an array")
        proposal = {
            "summary": str(parsed.get("summary") or "").strip(),
            "changes": changes,
        }
        return {**state, "proposal": proposal, "proposer_parse_warning": ""}
    except Exception as exc:
        return {
            **state,
            "proposal": {"summary": "Malformed implementor output.", "changes": []},
            "proposer_parse_warning": f"Implementor JSON parse error: {exc}",
        }


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
    if errors:
        return _record_review(
            state,
            {
                "verdict": "reject",
                "feedback": "Local patch preflight failed: " + "; ".join(errors[:6]),
                "missing": errors[:8],
                "quality_score": 0,
            },
        )

    round_number = int(state.get("round", 0)) + 1
    ok, raw = _llm(
        state,
        _reviewer_prompt(state, valid),
        f"workflow_reviewer_round_{round_number}",
        max_tokens=_stage_max_tokens(state, "reviewer"),
    )
    if not ok:
        return {**state, "error": f"Reviewer model call failed: {raw}"}
    try:
        parsed = _extract_json(raw)
        verdict = str(parsed.get("verdict") or "reject").strip().lower()
        if verdict not in {"accept", "reject"}:
            verdict = "reject"
        try:
            score = max(0, min(10, int(parsed.get("quality_score", 0))))
        except (TypeError, ValueError):
            score = 0
        feedback = str(parsed.get("feedback") or "").strip()
        missing = parsed.get("missing") if isinstance(parsed.get("missing"), list) else []
        if verdict == "accept" and score < _REVIEW_MIN_SCORE:
            verdict = "reject"
            feedback = (
                f"Reviewer score {score}/10 is below the required {_REVIEW_MIN_SCORE}/10. "
                + feedback
            ).strip()
        critique = {
            "verdict": verdict,
            "feedback": feedback,
            "missing": missing,
            "quality_score": score,
        }
    except Exception as exc:
        critique = {
            "verdict": "reject",
            "feedback": f"Reviewer returned malformed JSON: {exc}",
            "missing": ["A machine-readable reviewer verdict is required."],
            "quality_score": 0,
        }
    return _record_review(state, critique)


def _retry_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    return {
        **state,
        "round": int(state.get("round", 0)) + 1,
        "proposal": {},
        "proposer_parse_warning": "",
    }


def _synthesizer_node(state: RemediationWorkflowState) -> RemediationWorkflowState:
    valid, errors = _proposal_preflight(state)
    changed_files: list[dict[str, Any]] = []
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
        "negotiation_rounds": int(state.get("round", 0)) + 1,
        "critic_verdict": critique.get("verdict", "reject"),
        "critic_score": critique.get("quality_score", 0),
        "attempt_history": state.get("attempt_history") or [],
        "planner_warning": state.get("planner_warning") or "",
        "workflow": "master_planner_implementor_reviewer",
        "llm_cost_usd": round(float(getattr(state.get("budget_tracker"), "total_usd", 0.0)), 6),
    }
    return {**state, "final_result": final}


def _route_after_master(state: RemediationWorkflowState) -> str:
    return "error_end" if state.get("error") else "planner"


def _route_after_implementor(state: RemediationWorkflowState) -> str:
    return "error_end" if state.get("error") else "reviewer"


def _route_after_reviewer(state: RemediationWorkflowState) -> str:
    if state.get("error"):
        return "error_end"
    verdict = str((state.get("critique") or {}).get("verdict") or "reject").lower()
    if verdict == "accept":
        return "synthesizer"
    if int(state.get("round", 0)) < MAX_ROUNDS - 1:
        return "retry"
    return "synthesizer"


def build_remediation_graph(checkpointer: Any | None = None) -> Any:
    graph = StateGraph(RemediationWorkflowState)
    graph.add_node("master", _master_node)
    graph.add_node("planner", _planner_node)
    graph.add_node("implementor", _implementor_node)
    graph.add_node("reviewer", _reviewer_node)
    graph.add_node("retry", _retry_node)
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
    graph.add_conditional_edges(
        "reviewer",
        _route_after_reviewer,
        {"retry": "retry", "synthesizer": "synthesizer", "error_end": "error_end"},
    )
    graph.add_edge("retry", "implementor")
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
) -> tuple[bool, dict[str, Any] | str]:
    async def emit(message_type: str, content: str) -> None:
        if on_message:
            await on_message(message_type, content)

    set_current_project_id(project_id)
    await emit("supervisor_phase", "Master is collecting vulnerability-centered repository context.")
    try:
        contexts = await asyncio.to_thread(collect_remediation_contexts, scan_data)
    except Exception as exc:
        return False, f"Master failed to collect repository context: {exc}"
    if not contexts:
        return False, "No readable vulnerable source files or editable manifests were found."

    state: RemediationWorkflowState = {
        "project_id": project_id,
        "scan_data": scan_data,
        "contexts": contexts,
        "allowed_paths": list(contexts),
        "llm_provider": llm_provider or "",
        "llm_api_key": llm_api_key or "",
        "llm_model": llm_model or "",
        "user_id": str(user_id or ""),
        "organization_id": str(organization_id or ""),
        "llm_access_mode": access_mode or "auto",
        "llm_credential_id": llm_credential_id or "",
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

    thread_id = f"remediation:{project_id}:{uuid4()}"
    graph = build_remediation_graph(checkpointer=MemorySaver())
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": max(12, MAX_ROUNDS * 4 + 4),
    }
    latest = state

    await emit(
        "planner_phase",
        f"Master selected {len(contexts)} context file(s); Planner is mapping findings to fixes.",
    )
    try:
        async with asyncio.timeout(max(AGENT_NODE_TIMEOUT_SECONDS * (2 * MAX_ROUNDS + 1), 300)):
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
                            f"Planner persisted {targets} target(s); Implementor round 1 is generating patches.",
                        )
                    elif node == "implementor":
                        changes = len((latest.get("proposal") or {}).get("changes") or [])
                        round_number = int(latest.get("round", 0)) + 1
                        await emit("info", f"Implementor round {round_number} proposed {changes} change(s).")
                        await emit("reviewer_phase", f"Reviewer is validating round {round_number} against source context.")
                    elif node == "reviewer":
                        critique = latest.get("critique") or {}
                        verdict = str(critique.get("verdict") or "reject").upper()
                        score = int(critique.get("quality_score") or 0)
                        feedback = str(critique.get("feedback") or "")[:300]
                        await emit(
                            "success" if verdict == "ACCEPT" else "warning",
                            f"Reviewer: {verdict} ({score}/10) - {feedback}",
                        )
                    elif node == "retry":
                        round_number = int(latest.get("round", 0)) + 1
                        await emit(
                            "supervisor_phase",
                            f"Master routed reviewer feedback back to Implementor for round {round_number}.",
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
    return True, final


__all__ = [
    "RemediationWorkflowState",
    "build_remediation_graph",
    "collect_remediation_contexts",
    "run_remediation_workflow",
]

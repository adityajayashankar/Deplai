"""LLM-powered remediation agent that edits files inside the codebase volume."""

import base64
import ast
import json
import os
import shlex
import re
import difflib
from urllib import error as urlerror
from urllib import request as urlrequest
from dataclasses import dataclass, field
from math import ceil
from typing import Any

from anthropic import Anthropic

from utils import CODEBASE_VOLUME, decode_output, get_docker_client, get_repo_root

DEFAULT_MODEL = (
    os.getenv("REMEDIATION_CLAUDE_MODEL", "").strip()
    or os.getenv("CLAUDE_MODEL", "").strip()
    or "claude-sonnet-4-5"
)
REMEDIATION_BACKEND = os.getenv("REMEDIATION_LLM_BACKEND", "auto").strip().lower()
MAX_CONTEXT_FILES = int(os.getenv("REMEDIATION_MAX_CONTEXT_FILES", "12"))
MAX_PATCH_FILES = int(os.getenv("REMEDIATION_MAX_PATCH_FILES", "10"))
MAX_FILE_BYTES = int(os.getenv("REMEDIATION_MAX_FILE_BYTES", "60000"))
OPENAI_COMPAT_TIMEOUT = int(os.getenv("REMEDIATION_LLM_TIMEOUT_SECONDS", "120"))
MAX_PROVIDER_MODELS = int(os.getenv("REMEDIATION_MAX_PROVIDER_MODELS", "2"))
MAX_PROMPT_CHARS = int(os.getenv("REMEDIATION_MAX_PROMPT_CHARS", "26000"))
MAX_COMPLETION_TOKENS = int(os.getenv("REMEDIATION_MAX_COMPLETION_TOKENS", "2048"))
MAX_REMEDIATION_COST_USD = float(os.getenv("DEPLAI_MAX_REMEDIATION_COST_USD", "1.00") or "1.00")
OLLAMA_CLOUD_CHAT_ENDPOINT = "https://ollama.com/api/chat"
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b"

DEFAULT_OLLAMA_MODELS = [
    "qwen2.5-coder:7b",
    "qwen2.5:7b",
    "llama3.1:8b",
]

DEFAULT_GROQ_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "groq/compound-mini",
]

DEFAULT_OPENROUTER_MODELS = [
    os.getenv("OPENROUTER_MODEL", "").strip(),
    "qwen/qwen3-32b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "moonshotai/kimi-k2-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
]

MODEL_PRICING_PER_MILLION: dict[str, tuple[float, float]] = {
    "claude-opus-4-6": (5.00, 25.00),
    "claude-opus-4-5": (5.00, 25.00),
    "claude-opus-4-1": (15.00, 75.00),
    "claude-opus-4": (15.00, 75.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-sonnet-4-5": (3.00, 15.00),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-3-7-sonnet-latest": (3.00, 15.00),
    "claude-3-5-sonnet-20241022": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-3-5-haiku-20241022": (0.80, 4.00),
}

MANIFEST_FILES = {
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "requirements.txt",
    "poetry.lock",
    "pyproject.toml",
    "go.mod",
    "go.sum",
    "pom.xml",
    "Cargo.toml",
    "Cargo.lock",
}


@dataclass
class Change:
    path: str
    reason: str
    content: str


@dataclass
class RejectedChange:
    path: str
    reason: str


@dataclass
class ClaudeBudgetTracker:
    budget_cap_usd: float = MAX_REMEDIATION_COST_USD
    total_usd: float = 0.0
    calls: list[dict[str, Any]] = field(default_factory=list)

    def guard(self, *, model: str, prompt: str, max_tokens: int, stage: str) -> None:
        projected_cost = _usd_cost_for_tokens(
            model,
            _estimate_tokens(prompt),
            max_tokens,
        )
        if self.total_usd + projected_cost > self.budget_cap_usd:
            raise RuntimeError(
                f"Claude remediation budget exceeded for {stage}. "
                f"Current spend ${self.total_usd:.4f}, projected worst-case ${projected_cost:.4f}, "
                f"cap ${self.budget_cap_usd:.2f}."
            )

    def record_response(self, *, model: str, prompt: str, stage: str, response: Any) -> float:
        usage = getattr(response, "usage", None)
        input_tokens = int(
            getattr(usage, "input_tokens", 0)
            + getattr(usage, "cache_creation_input_tokens", 0)
            + getattr(usage, "cache_read_input_tokens", 0)
        )
        output_tokens = int(getattr(usage, "output_tokens", 0))
        if input_tokens <= 0:
            input_tokens = _estimate_tokens(prompt)
        cost_usd = _usd_cost_for_tokens(model, input_tokens, output_tokens)
        self.total_usd = round(self.total_usd + cost_usd, 6)
        self.calls.append(
            {
                "stage": stage,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": round(cost_usd, 6),
            }
        )
        return cost_usd


CONTAINER_TIMEOUT = int(os.getenv("REMEDIATION_CONTAINER_TIMEOUT", "120"))
MAX_DELETED_LINES = int(os.getenv("REMEDIATION_MAX_DELETED_LINES", "280"))
DELETE_TO_ADD_RATIO_LIMIT = float(os.getenv("REMEDIATION_DELETE_TO_ADD_RATIO_LIMIT", "6"))
MIN_RETAIN_RATIO = float(os.getenv("REMEDIATION_MIN_RETAIN_RATIO", "0.55"))
DESTRUCTIVE_GUARD_MIN_ORIGINAL_LINES = int(os.getenv("REMEDIATION_DESTRUCTIVE_GUARD_MIN_ORIGINAL_LINES", "220"))
DESTRUCTIVE_GUARD_LARGE_FILE_LINES = int(os.getenv("REMEDIATION_DESTRUCTIVE_GUARD_LARGE_FILE_LINES", "600"))
DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION = float(os.getenv("REMEDIATION_DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION", "0.35"))
DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION_LARGE = float(
    os.getenv("REMEDIATION_DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION_LARGE", "0.50")
)

SUSPICIOUS_ADDED_PATTERNS = [
    r"curl\s+[^\n]*\|\s*(sh|bash)",
    r"wget\s+[^\n]*\|\s*(sh|bash)",
    r"nc\s+-e\b",
    r"/dev/tcp/",
    r"base64\s+-d\s*\|\s*(sh|bash)",
    r"powershell\s+-enc(odedcommand)?\b",
]
BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{220,}={0,2}")


def _run_repo_shell(command: str, mode: str = "ro", check: bool = False) -> str:
    container = get_docker_client().containers.run(
        "alpine",
        command=["sh", "-lc", command],
        volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": mode}},
        detach=True,
    )
    try:
        result = container.wait(timeout=CONTAINER_TIMEOUT)
        output = container.logs()
    finally:
        container.remove(force=True)
    if check:
        exit_code = result.get("StatusCode", -1)
        if exit_code != 0:
            raise RuntimeError(
                f"Container command exited {exit_code}: {decode_output(output)[:200]}"
            )
    return decode_output(output)


def _is_safe_rel_path(path: str) -> bool:
    if not path or path.startswith("/") or "\\" in path:
        return False
    parts = path.split("/")
    return all(part not in ("", ".", "..") for part in parts)


def _normalize_rel_path(path: str) -> str:
    """Normalize a path string into a slash-delimited relative path."""
    p = str(path or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    # Drop empty/current-directory segments and collapse duplicate slashes.
    p = "/".join(part for part in p.split("/") if part not in ("", "."))
    return p


def _project_id_from_repo_root() -> str:
    """Extract active project id from /repo/{project_id} context when available."""
    repo_root = get_repo_root().rstrip("/")
    if repo_root == "/repo":
        return ""
    return repo_root.rsplit("/", 1)[-1]


def _resolve_path_against_allowed(path: str, allowed_paths: set[str]) -> str | None:
    """Resolve model/scanner path variants to a concrete allowed repository path.

    Handles common prefixes emitted by scanners/LLMs (e.g. /tmp/scan/{pid}/...,
    /repo/{pid}/..., {pid}/...) and supports safe suffix matching when unique.
    """
    raw = _normalize_rel_path(path)
    if not raw:
        return None

    candidates: list[str] = [raw]
    pid = _project_id_from_repo_root()

    def add_candidate(candidate: str) -> None:
        c = _normalize_rel_path(candidate)
        if c and c not in candidates:
            candidates.append(c)

    for value in list(candidates):
        for prefix in ("tmp/scan/", "repo/"):
            if value.startswith(prefix):
                add_candidate(value[len(prefix):])
        if "tmp/scan/" in value:
            add_candidate(value.split("tmp/scan/", 1)[1])
        if "repo/" in value:
            add_candidate(value.split("repo/", 1)[1])
        if pid and value.startswith(f"{pid}/"):
            add_candidate(value[len(pid) + 1 :])

    for value in candidates:
        if value in allowed_paths:
            return value

    matches: set[str] = set()
    for value in candidates:
        for allowed in allowed_paths:
            if value.endswith("/" + allowed) or allowed.endswith("/" + value):
                matches.add(allowed)

    if len(matches) == 1:
        return next(iter(matches))
    return None


def _list_candidate_files() -> list[str]:
    repo_root = get_repo_root()
    command = (
        f"find {shlex.quote(repo_root)} -type f "
        "\\( -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' "
        "-o -name '*.java' -o -name '*.go' -o -name '*.rs' -o -name '*.rb' "
        "-o -name '*.php' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' "
        "-o -name '*.cs' -o -name '*.swift' -o -name '*.kt' -o -name '*.scala' "
        "-o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.toml' "
        "-o -name '*.xml' -o -name '*.md' -o -name '*.txt' "
        "-o -name 'Dockerfile' -o -name 'Makefile' "
        f"\\) 2>/dev/null | sed 's|^{repo_root}/||' | head -800"
    )
    raw = _run_repo_shell(command, mode="ro")
    return [line.strip() for line in raw.splitlines() if line.strip()]


def _read_file(path: str, max_bytes: int = MAX_FILE_BYTES) -> str:
    quoted = shlex.quote(f"{get_repo_root()}/{path}")
    command = f"head -c {max_bytes} {quoted} 2>/dev/null || true"
    return _run_repo_shell(command, mode="ro")


def _write_file(path: str, content: str) -> None:
    repo_root = get_repo_root()
    target = f"{repo_root}/{path}"
    parent = os.path.dirname(target) or repo_root
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    command = (
        f"mkdir -p {shlex.quote(parent)} && "
        f"echo {shlex.quote(encoded)} | base64 -d > {shlex.quote(target)}"
    )
    _run_repo_shell(command, mode="rw", check=True)


def _validate_change_candidate(path: str, before: str, after: str) -> tuple[bool, str]:
    """Safety checks for generated changes before writing to disk.

    Blocks obviously suspicious payload-style additions and catches basic syntax issues.
    """
    if not isinstance(after, str) or not after.strip():
        return (False, "Empty or non-string file content")
    if "\x00" in after:
        return (False, "NUL byte detected in generated content")

    # Inspect only added lines to reduce false positives.
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    added_lines: list[str] = []
    deleted_count = 0
    added_count = 0
    for line in difflib.ndiff(before_lines, after_lines):
        if line.startswith("+ "):
            added_lines.append(line[2:])
            added_count += 1
        elif line.startswith("- "):
            deleted_count += 1
    added_blob = "\n".join(added_lines)

    for pattern in SUSPICIOUS_ADDED_PATTERNS:
        if re.search(pattern, added_blob, flags=re.IGNORECASE):
            return (False, f"Suspicious payload pattern detected: {pattern}")

    if BASE64_BLOB_RE.search(added_blob):
        return (False, "Large opaque base64-like payload detected in added lines")

    original_line_count = len(before_lines)
    final_line_count = len(after_lines)
    if original_line_count >= DESTRUCTIVE_GUARD_MIN_ORIGINAL_LINES:
        retain_ratio = (final_line_count / max(1, original_line_count))
        delete_to_add_ratio = (deleted_count / max(1, added_count))
        delete_fraction = (deleted_count / max(1, original_line_count))
        is_large_file = original_line_count >= DESTRUCTIVE_GUARD_LARGE_FILE_LINES
        max_delete_fraction = (
            DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION_LARGE
            if is_large_file
            else DESTRUCTIVE_GUARD_MAX_DELETE_FRACTION
        )
        delete_ratio_limit = max(DELETE_TO_ADD_RATIO_LIMIT, 12.0) if is_large_file else DELETE_TO_ADD_RATIO_LIMIT

        if added_count == 0 and deleted_count > 0:
            return (
                False,
                "Destructive rewrite blocked: produced pure-deletion change with no added lines.",
            )

        if (
            deleted_count > MAX_DELETED_LINES
            and delete_to_add_ratio > delete_ratio_limit
            and delete_fraction > max_delete_fraction
        ):
            return (
                False,
                (
                    "Destructive rewrite blocked: "
                    f"deleted {deleted_count} lines vs added {added_count} lines "
                    f"(ratio {delete_to_add_ratio:.1f} > {delete_ratio_limit}, "
                    f"delete fraction {delete_fraction:.1%} > {max_delete_fraction:.1%})."
                ),
            )
        if retain_ratio < MIN_RETAIN_RATIO and deleted_count > MAX_DELETED_LINES:
            return (
                False,
                (
                    "Destructive shrink blocked: "
                    f"file retained only {retain_ratio:.2%} of original lines "
                    f"(minimum {MIN_RETAIN_RATIO:.2%})."
                ),
            )

    lower_path = path.lower()
    if lower_path.endswith(".py"):
        try:
            ast.parse(after)
        except SyntaxError as exc:
            return (False, f"Python syntax error: {exc.msg} at line {exc.lineno}")
    elif lower_path.endswith(".json"):
        try:
            json.loads(after)
        except Exception as exc:
            return (False, f"JSON syntax error: {exc}")

    return (True, "")


def _build_unified_diff(path: str, before: str, after: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
        )
    )


def _pricing_for_model(model: str) -> tuple[float, float]:
    normalized = str(model or "").strip().lower()
    if normalized in MODEL_PRICING_PER_MILLION:
        return MODEL_PRICING_PER_MILLION[normalized]
    if "haiku" in normalized:
        return MODEL_PRICING_PER_MILLION["claude-3-5-haiku-20241022"]
    if "opus" in normalized:
        return MODEL_PRICING_PER_MILLION["claude-opus-4-5"]
    return MODEL_PRICING_PER_MILLION["claude-sonnet-4-5"]


def _estimate_tokens(text: str) -> int:
    return max(1, ceil(len(str(text or "")) / 4))


def _usd_cost_for_tokens(model: str, input_tokens: int, output_tokens: int) -> float:
    input_rate, output_rate = _pricing_for_model(model)
    return ((max(0, input_tokens) * input_rate) + (max(0, output_tokens) * output_rate)) / 1_000_000


def _sanitize_json_control_chars(text: str) -> str:
    """Escape literal (unescaped) control characters inside JSON string values.

    LLMs often embed raw newlines / tabs inside the ``"content"`` field instead
    of the valid JSON escape sequences ``\\n`` / ``\\t``.  A naive
    ``str.replace("\\n", "\\\\n")`` would corrupt structural whitespace, so we
    walk the text character-by-character, tracking whether we are inside a JSON
    string, and only escape control chars there.
    """
    result: list[str] = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == '\\':
                # Escape sequence — copy verbatim (both backslash and next char)
                result.append(ch)
                i += 1
                if i < len(text):
                    result.append(text[i])
            elif ch == '"':
                in_string = False
                result.append(ch)
            elif ord(ch) < 0x20:
                # Unescaped control character — escape it
                if ch == '\n':
                    result.append('\\n')
                elif ch == '\r':
                    result.append('\\r')
                elif ch == '\t':
                    result.append('\\t')
                else:
                    result.append(f'\\u{ord(ch):04x}')
            else:
                result.append(ch)
        else:
            if ch == '"':
                in_string = True
                result.append(ch)
            else:
                result.append(ch)
        i += 1
    return ''.join(result)


def _escape_unescaped_quotes_in_content_fields(text: str) -> str:
    """Escape unescaped quotes inside `"content": "..."` JSON fields.

    Some model outputs include raw `"` characters inside code content, which
    breaks JSON parsing. This pass only touches `content` field string bodies.
    """
    out: list[str] = []
    i = 0
    marker = '"content"'
    n = len(text)

    while i < n:
        idx = text.find(marker, i)
        if idx == -1:
            out.append(text[i:])
            break

        out.append(text[i:idx])
        out.append(marker)
        i = idx + len(marker)

        # Copy until colon
        while i < n and text[i] != ":":
            out.append(text[i])
            i += 1
        if i >= n:
            break
        out.append(":")
        i += 1

        # Preserve whitespace
        while i < n and text[i].isspace():
            out.append(text[i])
            i += 1

        # Only process string-valued content fields
        if i >= n or text[i] != '"':
            continue

        out.append('"')
        i += 1
        escaped = False
        while i < n:
            ch = text[i]
            if escaped:
                out.append(ch)
                escaped = False
                i += 1
                continue
            if ch == "\\":
                out.append(ch)
                escaped = True
                i += 1
                continue
            if ch == '"':
                # Treat quote as terminator only if followed by comma/brace.
                j = i + 1
                while j < n and text[j].isspace():
                    j += 1
                if j < n and text[j] in ",}":
                    out.append('"')
                    i += 1
                    break
                out.append('\\"')
                i += 1
                continue
            out.append(ch)
            i += 1

    return "".join(out)


def _strip_markdown_code_fences(value: str) -> str:
    text = str(value or "")
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip("\n")
    return text


def _coerce_change_content(raw: dict[str, Any]) -> tuple[str | None, str]:
    """Extract usable file content from flexible LLM payload shapes."""
    content_keys = (
        "content",
        "updated_content",
        "new_content",
        "file_content",
        "full_content",
        "after",
        "text",
        "code",
    )
    candidate: Any = None
    source_key = ""
    for key in content_keys:
        if key in raw:
            candidate = raw.get(key)
            source_key = key
            break

    if isinstance(candidate, dict):
        for nested_key in ("content", "text", "code"):
            nested = candidate.get(nested_key)
            if isinstance(nested, str):
                candidate = nested
                break

    if isinstance(candidate, list):
        str_items = [item for item in candidate if isinstance(item, str)]
        if str_items:
            candidate = "\n".join(str_items)

    if not isinstance(candidate, str):
        return (None, source_key or "content")

    content = _strip_markdown_code_fences(candidate)
    encoding = str(raw.get("encoding", "")).strip().lower()
    if encoding == "base64":
        try:
            content = base64.b64decode(content).decode("utf-8")
        except Exception:
            return (None, source_key or "content")

    return (content, source_key or "content")


def _extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    # Strip markdown code fences
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:].strip()
    # Try direct parse first
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Try Python literal-style dicts (single quotes / trailing commas from LLMs)
    try:
        lit = ast.literal_eval(stripped)
        if isinstance(lit, dict):
            return lit
    except Exception:
        pass
    # Retry after sanitizing unescaped control characters (LLMs often embed
    # literal newlines inside "content" strings instead of using \n).
    try:
        return json.loads(_sanitize_json_control_chars(stripped))
    except json.JSONDecodeError:
        pass
    # Retry after repairing unescaped quotes in "content" fields.
    repaired = _escape_unescaped_quotes_in_content_fields(
        _sanitize_json_control_chars(stripped)
    )
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass

    # Find outermost JSON object via brace matching (try sanitized then repaired)
    candidates = [_sanitize_json_control_chars(stripped), repaired]
    for candidate_text in candidates:
        depth = 0
        obj_start = -1
        for i, ch in enumerate(candidate_text):
            if ch == "{":
                if depth == 0:
                    obj_start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and obj_start != -1:
                    candidate = candidate_text[obj_start : i + 1]
                    try:
                        parsed = json.loads(candidate)
                        if any(k in parsed for k in ("changes", "verdict", "summary", "feedback")):
                            return parsed
                    except json.JSONDecodeError:
                        try:
                            lit = ast.literal_eval(candidate)
                            if isinstance(lit, dict):
                                return lit
                        except Exception:
                            pass
                        continue

        start = candidate_text.find("{")
        end = candidate_text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(candidate_text[start : end + 1])
            except json.JSONDecodeError:
                try:
                    lit = ast.literal_eval(candidate_text[start : end + 1])
                    if isinstance(lit, dict):
                        return lit
                except Exception:
                    pass

    raise ValueError("LLM response did not contain valid JSON.")


def _collect_context_files(scan_data: dict[str, Any]) -> dict[str, str]:
    candidate_files = _list_candidate_files()
    candidate_set = set(candidate_files)

    vuln_paths: list[str] = []
    seen = set()
    for finding in scan_data.get("code_security", []):
        for occ in finding.get("occurrences", []):
            raw_path = str(occ.get("filename", "")).strip()
            resolved_path = _resolve_path_against_allowed(raw_path, candidate_set)
            if resolved_path and resolved_path not in seen:
                seen.add(resolved_path)
                vuln_paths.append(resolved_path)

    manifest_paths = [
        path for path in candidate_files if os.path.basename(path) in MANIFEST_FILES
    ]

    # Prioritize dependency manifests so supply-chain remediation can edit them.
    # If vulnerable code paths fill MAX_CONTEXT_FILES first, package manifests
    # would otherwise be dropped and then rejected by the editable allowlist.
    selected: list[str] = []
    for path in manifest_paths + vuln_paths:
        if path in selected:
            continue
        selected.append(path)
        if len(selected) >= MAX_CONTEXT_FILES:
            break

    contexts: dict[str, str] = {}
    for path in selected:
        content = _read_file(path)
        if content.strip():
            contexts[path] = content
    return contexts


def _build_prompt(
    scan_data: dict[str, Any],
    contexts: dict[str, str],
    cortex_context: str | None,
    agent_analysis: dict | None = None,
    shrink_level: int = 0,
) -> str:
    raw_code_findings = scan_data.get("code_security", [])
    raw_supply_findings = scan_data.get("supply_chain", [])

    code_limit = 40
    supply_limit = 60
    include_occurrences = True
    max_occ_per_finding = 3
    max_section_chars = 20000
    max_context_total_chars = 32000

    if shrink_level >= 1:
        code_limit = 24
        supply_limit = 36
        include_occurrences = False
        max_section_chars = 9000
        max_context_total_chars = 18000
    if shrink_level >= 2:
        code_limit = 12
        supply_limit = 16
        include_occurrences = False
        max_section_chars = 4500
        max_context_total_chars = 9000
    if shrink_level >= 3:
        code_limit = 4
        supply_limit = 6
        include_occurrences = False
        max_section_chars = 700
        max_context_total_chars = 1200

    code_findings: list[dict[str, Any]] = []
    for finding in raw_code_findings[:code_limit]:
        if not isinstance(finding, dict):
            continue
        item: dict[str, Any] = {
            "cwe_id": finding.get("cwe_id"),
            "severity": finding.get("severity"),
            "count": finding.get("count"),
            "title": finding.get("title") or finding.get("name") or finding.get("message"),
            "description": str(finding.get("description", ""))[:180],
            "primary_path": finding.get("primary_path"),
            "root_cause_key": finding.get("root_cause_key"),
            "root_cause_kind": finding.get("root_cause_kind"),
        }
        if include_occurrences:
            occ = finding.get("occurrences", [])
            compact_occ = []
            for o in occ[:max_occ_per_finding]:
                if isinstance(o, dict):
                    compact_occ.append(
                        {
                            "filename": o.get("filename"),
                            "line_number": o.get("line_number") or o.get("line"),
                            "code": str(o.get("code", ""))[:200],
                        }
                    )
            item["occurrences"] = compact_occ
        code_findings.append(item)

    supply_findings: list[dict[str, Any]] = []
    for finding in raw_supply_findings[:supply_limit]:
        if not isinstance(finding, dict):
            continue
        supply_findings.append(
            {
                "cve_id": finding.get("cve_id"),
                "severity": finding.get("severity"),
                "package": finding.get("package") or finding.get("name"),
                "installed_version": finding.get("installed_version") or finding.get("version"),
                "fix_version": finding.get("fix_version"),
                "description": str(finding.get("description", ""))[:140],
                "count": finding.get("count"),
                "related_cve_ids": (finding.get("related_cve_ids") or [])[:8],
                "root_cause_key": finding.get("root_cause_key"),
                "root_cause_kind": finding.get("root_cause_kind"),
            }
        )

    sections = []
    current_context_chars = 0
    for path, content in contexts.items():
        if current_context_chars >= max_context_total_chars:
            break
        trimmed = str(content or "")[:max_section_chars]
        remaining = max_context_total_chars - current_context_chars
        if remaining <= 0:
            break
        if len(trimmed) > remaining:
            trimmed = trimmed[:remaining]
        current_context_chars += len(trimmed)
        sections.append(f"### {path}\n```text\n{trimmed}\n```")

    # Knowledge graph analysis section
    biz_summary = (agent_analysis or {}).get("business_logic_summary", "").strip()
    vuln_context = (agent_analysis or {}).get("vulnerability_summary", "").strip()
    kg_section = ""
    if biz_summary or vuln_context:
        kg_section = f"""Knowledge Graph Analysis (static source-code analysis by a dedicated agent):

Business Logic:
{biz_summary or 'Not analyzed'}

Vulnerability Context:
{vuln_context or 'Not analyzed'}
"""

    prompt = f"""You are remediating security vulnerabilities in a real repository.

Use the scanner findings and file contexts to produce concrete code fixes.
Only return valid JSON (no markdown) with this exact schema:
{{
  "summary": "short summary",
  "changes": [
    {{
      "path": "relative/path.ext",
      "reason": "why this fix mitigates the vulnerability",
      "content": "full updated file content"
    }}
  ]
}}

Rules:
1. Provide only executable, syntactically correct code.
2. Keep changes minimal and targeted to vulnerabilities.
3. Do not add placeholders, TODOs, or pseudo-code.
4. Only modify paths present in the provided file contexts.
5. If no safe fix is possible, return an empty "changes" array and explain in summary.
6. Escape all JSON string characters correctly inside `content` (quotes/backslashes/newlines).

Security findings (Bearer + Grype):
{json.dumps({"code_security": code_findings, "supply_chain": supply_findings}, indent=2)}

Context from Cortex knowledge graph (optional):
{cortex_context or "None provided"}

{kg_section}Repository file contexts:
{chr(10).join(sections)}
"""

    if len(prompt) > MAX_PROMPT_CHARS:
        return prompt[:MAX_PROMPT_CHARS]
    return prompt


def _normalize_changes_with_report(
    parsed: dict[str, Any], allowed_paths: set[str]
) -> tuple[list[Change], list[RejectedChange]]:
    raw_changes = parsed.get("changes", [])
    if not isinstance(raw_changes, list):
        raise ValueError("Expected `changes` to be an array.")

    normalized: list[Change] = []
    rejected: list[RejectedChange] = []
    seen = set()

    for raw in raw_changes:
        if not isinstance(raw, dict):
            rejected.append(RejectedChange(path="", reason="Skipped non-object change payload"))
            continue
        raw_path = str(raw.get("path", "")).strip()
        reason = str(raw.get("reason", "")).strip()
        content, source_key = _coerce_change_content(raw)
        if not isinstance(content, str):
            rejected.append(
                RejectedChange(
                    path=raw_path,
                    reason=f"Skipped because change payload did not include string content (checked key: {source_key})",
                )
            )
            continue
        resolved_path = _resolve_path_against_allowed(raw_path, allowed_paths)
        if not resolved_path:
            normalized_path = _normalize_rel_path(raw_path)
            if not _is_safe_rel_path(normalized_path):
                rejected.append(RejectedChange(path=raw_path, reason="Rejected unsafe path"))
            else:
                rejected.append(
                    RejectedChange(
                        path=raw_path,
                        reason="Path not in editable allowlist for this remediation context",
                    )
                )
            continue
        if resolved_path in seen:
            rejected.append(RejectedChange(path=resolved_path, reason="Duplicate change path"))
            continue
        if len(content.encode("utf-8")) > 80_000:
            rejected.append(RejectedChange(path=resolved_path, reason="File content too large (>80KB)"))
            continue
        seen.add(resolved_path)
        normalized.append(Change(path=resolved_path, reason=reason, content=content))
        if len(normalized) >= MAX_PATCH_FILES:
            break

    return normalized, rejected


def _normalize_changes(parsed: dict[str, Any], allowed_paths: set[str]) -> list[Change]:
    normalized, _ = _normalize_changes_with_report(parsed, allowed_paths)
    return normalized


def _split_models(csv_or_single: str) -> list[str]:
    return [m.strip() for m in csv_or_single.split(",") if m.strip()]


def _unique_models(models: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for model in models:
        if model and model not in seen:
            seen.add(model)
            ordered.append(model)
    return ordered


def _is_connectivity_error(message: str) -> bool:
    lower = (message or "").lower()
    markers = (
        "timed out",
        "timeout",
        "name or service not known",
        "temporary failure in name resolution",
        "nodename nor servname provided",
        "network is unreachable",
        "connection refused",
        "connection reset",
        "ssl",
        "tls",
        "eof occurred",
    )
    return any(marker in lower for marker in markers)


def _openai_compatible_chat_completion(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    temperature: float,
    max_tokens: int,
    extra_headers: dict[str, str] | None = None,
) -> tuple[bool, str]:
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "deplai-agentic/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)

    req = urlrequest.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urlrequest.urlopen(req, timeout=OPENAI_COMPAT_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
    except urlerror.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        message = raw
        try:
            data = json.loads(raw)
            message = str(data.get("error", {}).get("message") or data)
        except Exception:
            pass
        return (False, f"HTTP {e.code}: {message}")
    except Exception as e:
        return (False, str(e))

    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        return (False, f"Malformed LLM response for model {model}")

    if not isinstance(content, str) or not content.strip():
        return (False, f"Empty LLM content for model {model}")

    return (True, content)


def _call_groq(prompt: str) -> tuple[bool, str]:
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        return (False, "Missing GROQ_API_KEY.")

    preferred = _split_models(os.getenv("REMEDIATION_GROQ_MODEL", "").strip())
    configured_fallbacks = _split_models(os.getenv("REMEDIATION_GROQ_MODEL_FALLBACKS", "").strip())
    models = _unique_models(preferred + configured_fallbacks + DEFAULT_GROQ_MODELS)
    if MAX_PROVIDER_MODELS > 0:
        models = models[:MAX_PROVIDER_MODELS]
    if not models:
        return (False, "No Groq models configured.")

    base_url = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    errors: list[str] = []

    for model in models:
        ok, result = _openai_compatible_chat_completion(
            base_url=base_url,
            api_key=api_key,
            model=model,
            prompt=prompt,
            temperature=0.1,
            max_tokens=MAX_COMPLETION_TOKENS,
        )
        if ok:
            return (True, result)
        errors.append(f"{model}: {result}")
        if _is_connectivity_error(result):
            return (False, "Groq connectivity failure; aborting model fallbacks: " + " | ".join(errors))

    return (False, "Groq completion failed across fallback models: " + " | ".join(errors))


def _call_claude_sdk(
    prompt: str,
    api_key: str | None = None,
    model: str | None = None,
    budget_tracker: ClaudeBudgetTracker | None = None,
    stage: str = "remediation",
) -> tuple[bool, str]:
    resolved_api_key = (
        str(api_key or "").strip()
        or os.getenv("ANTHROPIC_API_KEY", "").strip()
        or os.getenv("CLAUDE_API_KEY", "").strip()
    )
    if not resolved_api_key:
        return (False, "Missing ANTHROPIC_API_KEY for remediation.")

    resolved_model = str(model or "").strip() or DEFAULT_MODEL
    try:
        if budget_tracker is not None:
            budget_tracker.guard(
                model=resolved_model,
                prompt=prompt,
                max_tokens=MAX_COMPLETION_TOKENS,
                stage=stage,
            )
        client = Anthropic(api_key=resolved_api_key, timeout=OPENAI_COMPAT_TIMEOUT)
        response = client.messages.create(
            model=resolved_model,
            max_tokens=MAX_COMPLETION_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        if budget_tracker is not None:
            budget_tracker.record_response(
                model=resolved_model,
                prompt=prompt,
                stage=stage,
                response=response,
            )
    except Exception as e:
        return (False, str(e))

    text_parts: list[str] = []
    for block in getattr(response, "content", []):
        block_text = getattr(block, "text", None)
        if isinstance(block_text, str) and block_text.strip():
            text_parts.append(block_text)

    text = "\n".join(text_parts).strip()
    if not text:
        return (False, f"Claude SDK returned no text content for model {resolved_model}.")
    return (True, text)


def _call_openrouter(
    prompt: str,
    api_key: str | None = None,
    preferred_model: str | None = None,
) -> tuple[bool, str]:
    api_key = (api_key or os.getenv("OPENROUTER_API_KEY", "")).strip()
    if not api_key:
        return (False, "Missing OPENROUTER_API_KEY.")

    preferred = _split_models(os.getenv("REMEDIATION_OPENROUTER_MODEL", "").strip())
    if preferred_model and preferred_model.strip():
        preferred = [preferred_model.strip()] + preferred
    configured_fallbacks = _split_models(os.getenv("REMEDIATION_OPENROUTER_MODEL_FALLBACKS", "").strip())
    models = _unique_models(preferred + configured_fallbacks + DEFAULT_OPENROUTER_MODELS)
    if MAX_PROVIDER_MODELS > 0:
        models = models[:MAX_PROVIDER_MODELS]
    if not models:
        return (False, "No OpenRouter models configured.")

    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
    app_name = os.getenv("OPENROUTER_APP_NAME", "deplai-agentic")
    errors: list[str] = []

    for model in models:
        ok, result = _openai_compatible_chat_completion(
            base_url=base_url,
            api_key=api_key,
            model=model,
            prompt=prompt,
            temperature=0.1,
            max_tokens=MAX_COMPLETION_TOKENS,
            extra_headers={"HTTP-Referer": app_url, "X-Title": app_name},
        )
        if ok:
            return (True, result)
        errors.append(f"{model}: {result}")
        # Do not abort the entire provider chain on one model timeout/network issue;
        # continue trying remaining fallback models.

    return (False, "OpenRouter completion failed across fallback models: " + " | ".join(errors))


def _call_openai(prompt: str, api_key: str, model: str = "gpt-4o") -> tuple[bool, str]:
    """Call OpenAI with a user-supplied key and model."""
    if not api_key:
        return (False, "Missing OpenAI API key.")
    return _openai_compatible_chat_completion(
        base_url="https://api.openai.com/v1",
        api_key=api_key,
        model=model,
        prompt=prompt,
        temperature=0.1,
        max_tokens=MAX_COMPLETION_TOKENS,
    )


def _call_gemini(prompt: str, api_key: str, model: str = "gemini-2.5-pro") -> tuple[bool, str]:
    """Call Gemini via its OpenAI-compatible endpoint with a user-supplied key."""
    if not api_key:
        return (False, "Missing Gemini API key.")
    return _openai_compatible_chat_completion(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        api_key=api_key,
        model=model,
        prompt=prompt,
        temperature=0.1,
        max_tokens=MAX_COMPLETION_TOKENS,
    )


def _call_ollama(prompt: str, model: str | None = None) -> tuple[bool, str]:
    cloud_key = os.getenv("OLLAMA_API_KEY", "").strip()
    if not cloud_key:
        return (False, "cloud: Missing OLLAMA_API_KEY for Ollama Cloud.")

    configured = _split_models(os.getenv("REMEDIATION_OLLAMA_MODEL_FALLBACKS", "").strip())
    selected_model = (model or OLLAMA_MODEL).strip() or OLLAMA_MODEL
    models = _unique_models([selected_model] + configured + DEFAULT_OLLAMA_MODELS)
    if MAX_PROVIDER_MODELS > 0:
        models = models[:MAX_PROVIDER_MODELS]
    if not models:
        return (False, "cloud: No Ollama models configured.")

    errors: list[str] = []

    for selected in models:
        payload = {
            "model": selected,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": MAX_COMPLETION_TOKENS},
        }

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "deplai-agentic/1.0",
            "Authorization": f"Bearer {cloud_key}",
        }
        req = urlrequest.Request(
            OLLAMA_CLOUD_CHAT_ENDPOINT,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=OPENAI_COMPAT_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urlerror.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            msg = f"HTTP {e.code}: {raw}"
            errors.append(f"{selected}: {msg}")
            if _is_connectivity_error(msg):
                return (False, "cloud: connectivity failure: " + " | ".join(errors))
            continue
        except Exception as e:
            msg = str(e)
            errors.append(f"{selected}: {msg}")
            if _is_connectivity_error(msg):
                return (False, "cloud: connectivity failure: " + " | ".join(errors))
            continue

        content = str(data.get("message", {}).get("content", "")).strip()
        if content:
            return (True, content)
        errors.append(f"{selected}: Empty LLM content")

    return (False, "cloud: " + " | ".join(errors))


def _is_prompt_too_large_error(message: str) -> bool:
    lower = (message or "").lower()
    markers = (
        "reduce the length",
        "maximum context length",
        "context length",
        "prompt too long",
        "too many tokens",
        "max token",
        "request too large",
        "http 413",
        "tokens per minute",
        "tpm",
        "requested",
        "please reduce your message size",
    )
    return any(marker in lower for marker in markers)


def run_claude_remediation(
    scan_data: dict[str, Any],
    cortex_context: str | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    agent_analysis: dict | None = None,
    budget_tracker: ClaudeBudgetTracker | None = None,
) -> tuple[bool, dict[str, Any] | str]:
    """Generate and apply remediation edits in the codebase volume."""
    contexts = _collect_context_files(scan_data)
    if not contexts:
        return (False, "No readable source files were available for remediation.")

    def _run_chain(prompt: str) -> tuple[bool, str]:
        provider_lower = (llm_provider or "").strip().lower()
        effective_api_key = llm_api_key if provider_lower in ("", "claude") else None
        effective_model = llm_model if provider_lower in ("", "claude") else None

        ok, raw_text = _call_claude_sdk(
            prompt,
            effective_api_key,
            effective_model,
            budget_tracker=budget_tracker,
            stage="fallback_remediation",
        )
        if ok:
            return (True, raw_text)

        if provider_lower and provider_lower != "claude":
            return (
                False,
                f"Remediation only supports the Claude Agent SDK; ignored provider '{provider_lower}'. Claude SDK error: {raw_text}",
            )
        return (False, "Claude SDK remediation failed: " + raw_text)

    ok = False
    raw_text = ""
    chain_error = ""
    for shrink_level in range(0, 4):
        prompt = _build_prompt(
            scan_data,
            contexts,
            cortex_context,
            agent_analysis,
            shrink_level=shrink_level,
        )
        if shrink_level >= 3 and len(prompt) > 9000:
            prompt = prompt[:9000]
        ok, result = _run_chain(prompt)
        if ok:
            raw_text = result
            break
        chain_error = result
        if not _is_prompt_too_large_error(result):
            break

    if not ok:
        return (False, chain_error)

    try:
        parsed = _extract_json(raw_text)
    except Exception as e:
        return (False, f"Failed to parse Claude JSON response: {e}")

    summary = str(parsed.get("summary", "")).strip() or "Remediation completed."
    changes = _normalize_changes(parsed, set(contexts.keys()))

    changed_files: list[dict[str, str]] = []
    rejected_changes: list[dict[str, str]] = []
    for change in changes:
        try:
            before_content = _read_file(change.path, max_bytes=200_000)
            if before_content == change.content:
                rejected_changes.append(
                    {"path": change.path, "reason": "No-op change (content identical to current file)"}
                )
                continue
            ok_candidate, reason = _validate_change_candidate(change.path, before_content, change.content)
            if not ok_candidate:
                rejected_changes.append({"path": change.path, "reason": reason})
                continue
            file_diff = _build_unified_diff(change.path, before_content, change.content)
            _write_file(change.path, change.content)
            changed_files.append({"path": change.path, "reason": change.reason, "diff": file_diff})
        except Exception as e:
            return (False, f"Failed writing {change.path}: {e}")

    if not changed_files:
        if rejected_changes:
            top = rejected_changes[0]
            return (False, f"All proposed changes were rejected by safety checks. Example: {top.get('path')}: {top.get('reason')}")
        return (False, "No safe remediation changes were produced.")

    return (
        True,
        {
            "summary": summary,
            "changed_files": changed_files,
            "rejected_changes": rejected_changes,
            "files_considered": list(contexts.keys()),
            "llm_cost_usd": round(float(budget_tracker.total_usd), 6) if budget_tracker is not None else None,
        },
    )

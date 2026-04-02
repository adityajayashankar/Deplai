from __future__ import annotations

from pathlib import Path
import re
import subprocess
from typing import Any

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient


def log_file_modification(file_path: str, operation: str, details: str) -> None:
    log_agent("Modifier", f"Applied modification to {file_path}")
    log_agent("Modifier", f"Operation: {operation}")
    log_agent("Modifier", f"Details: {details}")


def _log_message(message: str) -> None:
    log_agent("Modifier", message)


def _value_to_js_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    string_value = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{string_value}"'


def _apply_set_object_property(content: str, property_name: str, value: Any) -> str:
    literal = _value_to_js_literal(value)
    escaped_property = re.escape(property_name)
    patterns = [
        rf'({escaped_property}\s*:\s*)"(?:\\.|[^"\\])*"',
        rf"({escaped_property}\s*:\s*)'(?:\\.|[^'\\])*'",
        rf'({escaped_property}\s*:\s*)(?:true|false)',
        rf'({escaped_property}\s*:\s*)-?\d+(?:\.\d+)?',
        rf'({escaped_property}\s*:\s*)null',
    ]
    for pattern in patterns:
        updated, count = re.subn(pattern, rf"\g<1>{literal}", content, count=1)
        if count:
            return updated
    return content


def _apply_change(content: str, change: dict) -> str:
    operation = change["operation"]
    raw_count = change.get("count", 1)
    try:
        count = int(raw_count)
    except (TypeError, ValueError):
        count = 1
    if count < 0:
        count = 1
    if operation == "replace_text":
        # count=0 means replace everywhere for parity with regex behavior.
        replace_count = -1 if count == 0 else count
        return content.replace(change["target"], change["replacement"], replace_count)
    if operation == "replace_all_text":
        return content.replace(change["target"], change["replacement"])
    if operation == "insert_before":
        return content.replace(change["target"], change["replacement"], 1)
    if operation == "replace_regex":
        replacement = str(change["replacement"])
        # Normalize $1/$2... capture refs to Python format for re.sub.
        replacement = re.sub(r"(?<!\\)\$(\d+)", r"\\g<\1>", replacement)
        return re.sub(change["pattern"], replacement, content, count=count)
    if operation == "set_object_property":
        return _apply_set_object_property(content, change["property"], change["value"])
    return content


def _describe_change(change: dict) -> str:
    operation = change["operation"]
    if operation in {"replace_text", "replace_all_text"}:
        return f'{change["target"]!r} -> {change["replacement"]!r}'
    if operation == "insert_before":
        return f'before {change["target"]!r} insert {change["replacement"]!r}'
    if operation == "replace_regex":
        return f'pattern {change["pattern"]!r} -> {change["replacement"]!r}'
    if operation == "set_object_property":
        return f'{change["property"]} -> {change["value"]!r}'
    return str(change)


def _has_unsafe_regex_placeholder(change: dict) -> bool:
    operation = change.get("operation")
    if operation not in {"replace_text", "replace_all_text"}:
        return False

    target = change.get("target")
    replacement = change.get("replacement")
    if not isinstance(target, str) or not isinstance(replacement, str):
        return False

    has_placeholder = re.search(r"(?<!\\)\$[1-9]\d*", replacement) is not None
    target_has_placeholder = re.search(r"(?<!\\)\$[1-9]\d*", target) is not None
    return has_placeholder and not target_has_placeholder


def _verify_change(updated_content: str, change: dict) -> bool:
    operation = change["operation"]
    if operation in {"replace_text", "replace_all_text", "replace_regex", "insert_before"}:
        return str(change["replacement"]) in updated_content
    if operation == "set_object_property":
        property_name = str(change["property"])
        literal = _value_to_js_literal(change["value"])
        escaped_property = re.escape(property_name)
        pattern = rf"{escaped_property}\s*:\s*{re.escape(literal)}"
        return re.search(pattern, updated_content) is not None
    return False


def _normalize_app_targets(raw_targets: object) -> list[str]:
    allowed = {"frontend", "admin-frontend", "expert", "corporates"}
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]
    normalized: list[str] = []
    for item in raw_targets:
        if not isinstance(item, str):
            continue
        candidate = item.strip().lower()
        if candidate in allowed and candidate not in normalized:
            normalized.append(candidate)
    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _is_ui_target_file(repo_path: Path, file_path: Path, app_targets: list[str]) -> bool:
    resolved = file_path.resolve()

    has_selected_ui_roots = any((repo_path / app_root).exists() for app_root in app_targets)
    if not has_selected_ui_roots:
        # Arbitrary-repo fallback: allow any file under repo root except backend/*.
        try:
            resolved.relative_to(repo_path.resolve())
        except ValueError:
            return False

        backend_root = (repo_path / "backend").resolve()
        try:
            resolved.relative_to(backend_root)
            return False
        except ValueError:
            return True

    for app_root in app_targets:
        root = (repo_path / app_root).resolve()
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _contains_jsx_syntax(content: str) -> bool:
    jsx_markers = ["</", "<div", "<span", "<Link", "<Head", "<>", "className="]
    return any(marker in content for marker in jsx_markers)


def _should_run_node_syntax_check(file_path: Path, content: str) -> bool:
    if file_path.suffix in {".jsx", ".tsx"}:
        return False
    if file_path.suffix in {".js", ".ts"} and _contains_jsx_syntax(content):
        return False
    return file_path.suffix in {".js", ".ts", ".mjs", ".cjs"}


def _excerpt_for_change(content: str, change: dict, radius: int = 300) -> str:
    anchor = str(change.get("target") or change.get("pattern") or change.get("property") or "")
    if anchor and anchor in content:
        start = max(content.index(anchor) - radius, 0)
        end = min(content.index(anchor) + len(anchor) + radius, len(content))
        return content[start:end]
    return content[:800]


def _normalize_review_change(change: object, original_change: dict, relative_path: str) -> dict:
    if not isinstance(change, dict):
        return original_change
    if change.get("file") != relative_path:
        return original_change
    operation = change.get("operation")
    if not isinstance(operation, str):
        return original_change
    normalized = {"file": relative_path, "operation": operation}
    for field_name in ["target", "replacement", "pattern", "property", "value", "count"]:
        if field_name in change:
            normalized[field_name] = change[field_name]
    return normalized


def _review_change_with_llm(client: ProjectLLMClient, manifest: dict, relative_path: str, original_content: str, change: dict) -> tuple[bool, dict, list[str]]:
    excerpt = _excerpt_for_change(original_content, change)
    system_prompt = (
        "You are a frontend customization modifier reviewer. Decide whether a proposed change is appropriate for the provided frontend excerpt. "
        "Return strict JSON only."
    )
    user_prompt = (
        "Manifest summary:\n"
        f"{manifest}\n\n"
        f"Target file: {relative_path}\n"
        f"Current excerpt:\n{excerpt}\n\n"
        "Proposed change:\n"
        f"{change}\n\n"
        "Return a JSON object with this shape:\n"
        "{\n"
        '  "approve": true,\n'
        '  "reasoning": ["short reasoning line"],\n'
        '  "revised_change": { }\n'
        "}\n\n"
        "Rules:\n"
        "- Approve only if the file is a frontend file and the change is consistent with the excerpt.\n"
        "- frontend/utils/data.js stores display text under companyData.text.<scope>.<key> (scopes: landing, topbar, footer, auth, all_sessions, contact, home, my_schedule, my_communities, search, browse_classes, cart_checkout, course_details, community_details, user_settings, all_sessions_live, all_sessions_videos, community_home, community_subscription, media_player, community_commerce, category_sessions, trainer_bio, user_portal, session_management, community_threads, student_registration) "
        "and visibility toggles under companyData.visibility.<scope>.<key>. "
        "set_object_property on data.js should target the leaf key name (e.g. 'hero_1', 'show_hero').\n"
        "- Style changes (colors, fonts, sizes) should modify JSX/Tailwind classes in component files, NOT data.js.\n"
        "- If the change needs adjustment, return approve=true and provide revised_change.\n"
        "- revised_change.replacement must be the exact code-ready text to write into the file, including quotes or braces when needed for valid JS/JSX syntax.\n"
        "- Never approve a change that would create invalid JavaScript or JSX.\n"
        "- If the change is unsafe or unrelated, return approve=false.\n"
        "- Keep reasoning concise."
    )
    result = client.complete_json(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=1000)
    reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
    normalized_reasoning = [line.strip() for line in reasoning if isinstance(line, str) and line.strip()] if isinstance(reasoning, list) else []
    approve = bool(result.get("approve")) if isinstance(result, dict) else False
    revised_change = _normalize_review_change(result.get("revised_change"), change, relative_path) if isinstance(result, dict) else change
    return approve, revised_change, normalized_reasoning


def apply_changes(state: dict) -> dict:
    repo_path = Path(state["repo_path"]).resolve()
    app_targets = _normalize_app_targets(state.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"]))
    modified_files = list(state.get("modified_files", []))
    errors = list(state.get("errors", []))
    records = list(state.get("modification_records", []))
    manifest_summary = state.get("manifest", {})
    client = ProjectLLMClient()

    for change in state.get("planned_changes", []):
        relative_path = change["file"]
        file_path = (repo_path / relative_path).resolve()
        if not file_path.exists():
            errors.append(f"Planned file does not exist: {relative_path}")
            continue
        if not _is_ui_target_file(repo_path, file_path, app_targets):
            errors.append(f"Refused to modify file outside selected UI targets: {relative_path}")
            _log_message(f"Skipped file outside selected UI targets: {relative_path}")
            continue

        if _has_unsafe_regex_placeholder(change):
            errors.append(
                f"Refused suspicious replacement for {relative_path}: regex placeholder token in plain text replacement"
            )
            _log_message(f"Skipped suspicious replacement for {relative_path} (contains $N placeholder in plain text op)")
            continue

        original = file_path.read_text(encoding="utf-8")
        reviewed_change = change
        if client.is_configured():
            try:
                approve, reviewed_change, reasoning = _review_change_with_llm(
                    client,
                    manifest_summary,
                    relative_path,
                    original,
                    change,
                )
                for line in reasoning:
                    _log_message(f"LLM review for {relative_path}: {line}")
                if not approve:
                    _log_message(f"LLM rejected modification for {relative_path}")
                    continue
            except Exception as exc:
                reviewed_change = change
                _log_message(
                    f"LLM review failed for {relative_path}; falling back to planned change: {exc}"
                )
        else:
            reviewed_change = change
            _log_message("LLM client is not configured; applying planned changes without review.")

        updated = _apply_change(original, reviewed_change)
        if updated != original:
            file_path.write_text(updated, encoding="utf-8")
            applied_content = file_path.read_text(encoding="utf-8")
            if _should_run_node_syntax_check(file_path, applied_content):
                syntax_check = subprocess.run(
                    ["node", "--check", str(file_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if syntax_check.returncode != 0:
                    file_path.write_text(original, encoding="utf-8")
                    errors.append(
                        f"Modifier reverted invalid syntax change in {relative_path}: {syntax_check.stderr.strip() or syntax_check.stdout.strip()}"
                    )
                    _log_message(f"Reverted invalid syntax change in {relative_path}")
                    continue
            else:
                _log_message(f"Skipped node syntax check for JSX-bearing file: {relative_path}")
            details = _describe_change(reviewed_change)
            if _verify_change(applied_content, reviewed_change):
                log_file_modification(relative_path, reviewed_change["operation"], details)
                records.append(
                    {
                        "file": relative_path,
                        "change": reviewed_change,
                        "before_excerpt": _excerpt_for_change(original, reviewed_change),
                        "after_excerpt": _excerpt_for_change(applied_content, reviewed_change),
                    }
                )
            else:
                warning = f"WARNING: Change may not have applied to {relative_path}"
                _log_message(warning)
                errors.append(warning)
            if relative_path not in modified_files:
                modified_files.append(relative_path)
        else:
            _log_message(f"No content change produced for {relative_path} using {reviewed_change['operation']}")

    state["modified_files"] = modified_files
    state["modification_records"] = records
    state["errors"] = errors
    return state

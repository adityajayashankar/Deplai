from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient


def _log_message(message: str) -> None:
    log_agent("BackendPlanner", message)


ALLOWED_OPERATIONS = {"replace_text", "replace_all_text", "replace_regex", "set_object_property", "insert_before"}


def _read_excerpt(repo_path: Path, relative_path: str, max_lines: int = 40) -> str:
    file_path = repo_path / relative_path
    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""
    lines = [line for line in content.splitlines()[:max_lines]]
    return "\n".join(lines)[:1400]


def _read_file_content(repo_path: Path, relative_path: str) -> str:
    file_path = repo_path / relative_path
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""


def _collect_target_contexts(repo_path: Path, backend_repo_map: dict[str, Any], limit: int = 28) -> list[dict[str, str]]:
    ordered_paths: list[str] = []
    for category_name in ["priority_targets", "config_targets", "api_targets", "service_targets"]:
        for path in backend_repo_map.get(category_name, []):
            if path not in ordered_paths:
                ordered_paths.append(path)

    contexts: list[dict[str, str]] = []
    for relative_path in ordered_paths[:limit]:
        excerpt = _read_excerpt(repo_path, relative_path)
        if excerpt:
            contexts.append({"path": relative_path, "excerpt": excerpt})
            _log_message(f"Found backend target: {relative_path}")
    return contexts


def _manifest_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    categories = manifest.get("categories", {})
    integrations = categories.get("integrations", {}) if isinstance(categories, dict) else {}
    domains = categories.get("domains", {}) if isinstance(categories, dict) else {}
    return {
        "integrations": integrations if isinstance(integrations, dict) else {},
        "domains": domains if isinstance(domains, dict) else {},
        "extensions": manifest.get("extensions", []),
    }


def _has_backend_intent(manifest: dict[str, Any]) -> bool:
    categories = manifest.get("categories", {})
    if isinstance(categories, dict):
        integrations = categories.get("integrations", {})
        if isinstance(integrations, dict) and any(value not in [None, "", [], {}] for value in integrations.values()):
            return True

    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return False
    for item in extensions:
        if not isinstance(item, dict):
            continue
        scope = str(item.get("scope", "")).lower()
        target = str(item.get("target", "")).lower()
        item_type = str(item.get("type", "")).lower()
        if scope == "backend":
            return True
        if any(token in target for token in ["api", "backend", "server", "auth", "db"]):
            return True
        if item_type in {"api", "backend_config", "server_logic"}:
            return True
    return False


def _should_plan_backend(backend_repo_map: dict[str, Any], manifest: dict[str, Any]) -> bool:
    if not _has_backend_intent(manifest):
        return False
    for key in ["config_targets", "api_targets", "service_targets"]:
        values = backend_repo_map.get(key, [])
        if isinstance(values, list) and any(isinstance(path, str) and path.strip() for path in values):
            return True
    return False


def _normalize_change(change: object, allowed_paths: set[str]) -> dict[str, Any] | None:
    if not isinstance(change, dict):
        return None

    file_path = change.get("file")
    operation = change.get("operation")
    if not isinstance(file_path, str) or file_path not in allowed_paths:
        return None
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        return None

    normalized: dict[str, Any] = {"file": file_path, "operation": operation}
    for field_name in ["target", "replacement", "pattern", "property", "value", "count"]:
        if field_name in change:
            normalized[field_name] = change[field_name]

    if operation == "set_object_property":
        property_name = normalized.get("property")
        value = normalized.get("value")
        if not isinstance(property_name, str) or not property_name.strip():
            return None
        if not isinstance(value, (str, int, float, bool)):
            return None

    return normalized


def _is_meaningful_change(change: dict[str, Any], file_content_by_path: dict[str, str]) -> bool:
    file_content = file_content_by_path.get(change["file"], "")
    operation = change["operation"]

    if operation in {"replace_text", "replace_all_text"}:
        target = str(change.get("target", ""))
        replacement = str(change.get("replacement", ""))
        return bool(target and replacement and target != replacement and target in file_content)

    if operation == "replace_regex":
        pattern = str(change.get("pattern", ""))
        replacement = change.get("replacement")
        if not pattern or replacement is None:
            return False
        try:
            return re.search(pattern, file_content) is not None
        except re.error:
            return False

    if operation == "set_object_property":
        property_name = str(change.get("property", ""))
        value = str(change.get("value", ""))
        return bool(property_name and value and property_name in file_content and value not in file_content)

    if operation == "insert_before":
        target = str(change.get("target", ""))
        replacement = str(change.get("replacement", ""))
        return bool(target and replacement and target in file_content and replacement not in file_content)

    return False


def _dedupe_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for change in changes:
        fingerprint = json.dumps(change, sort_keys=True)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        deduped.append(change)
    return deduped


def plan_backend_changes(state: dict) -> dict:
    repo_path = Path(state["repo_path"])
    backend_repo_map = state.get("backend_repo_map", {})
    manifest = state.get("manifest", {})
    errors = list(state.get("errors", []))
    existing_changes = list(state.get("planned_changes", []))

    if not _should_plan_backend(backend_repo_map, manifest):
        _log_message("No backend intent/classified targets detected; skipped backend planning.")
        state["planned_changes"] = existing_changes
        state["errors"] = errors
        return state

    target_contexts = _collect_target_contexts(repo_path, backend_repo_map)
    allowed_paths = {context["path"] for context in target_contexts}

    if not target_contexts:
        _log_message("No backend targets detected for planning.")
        state["planned_changes"] = existing_changes
        state["errors"] = errors
        return state

    file_content_by_path = {
        relative_path: _read_file_content(repo_path, relative_path)
        for relative_path in allowed_paths
    }

    client = ProjectLLMClient()
    planned_backend_changes: list[dict[str, Any]] = []
    if not client.is_configured():
        _log_message("Backend planner LLM is not configured; no backend plan generated.")
    else:
        system_prompt = (
            "You are a backend customization planner. Use manifest summary and backend code excerpts to generate safe backend file changes. "
            "Return strict JSON only. Only generate changes for provided backend files."
        )
        user_prompt = (
            "Manifest summary:\n"
            f"{json.dumps(_manifest_summary(manifest), indent=2)}\n\n"
            "Backend repo map:\n"
            f"{json.dumps(backend_repo_map, indent=2)}\n\n"
            "Candidate backend excerpts:\n"
            f"{json.dumps(target_contexts, indent=2)}\n\n"
            "Return a JSON object with this shape:\n"
            "{\n"
            '  "reasoning": ["short reasoning line"],\n'
            '  "planned_changes": [\n'
            "    {\n"
            '      "file": "backend/...",\n'
            '      "operation": "replace_text|replace_all_text|replace_regex|set_object_property|insert_before",\n'
            '      "target": "string if required",\n'
            '      "pattern": "regex if required",\n'
            '      "replacement": "replacement if required",\n'
            '      "count": "optional, use 0 for global regex replace",\n'
            '      "property": "object property name if using set_object_property",\n'
            '      "value": "value if using set_object_property"\n'
            "    }\n"
            "  ]\n"
            "}\n\n"
            "Rules:\n"
            "- Only modify backend files from the provided candidate list.\n"
            "- Prefer API/config/service files selected by backend scanner map categories.\n"
            "- Do not propose frontend file edits.\n"
            "- Keep replacements exact to manifest-driven values when provided.\n"
            "- Propose only meaningful edits where target/pattern is present in excerpt.\n"
            "- If no safe backend change is possible, return an empty planned_changes list with concise reasoning."
        )

        try:
            result = client.complete_json(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=1400)
            reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
            for line in reasoning if isinstance(reasoning, list) else []:
                if isinstance(line, str) and line.strip():
                    _log_message(line.strip())
            for raw_change in result.get("planned_changes", []) if isinstance(result, dict) else []:
                normalized = _normalize_change(raw_change, allowed_paths)
                if normalized and _is_meaningful_change(normalized, file_content_by_path):
                    planned_backend_changes.append(normalized)
                    _log_message(f"Generated backend modification: {normalized}")
                elif normalized:
                    _log_message(f"Skipping backend no-op change: {normalized}")
        except Exception as exc:
            errors.append(f"Backend planner LLM failed: {exc}")
            _log_message(f"Backend planner failed: {exc}")

    merged_changes = _dedupe_changes([*existing_changes, *planned_backend_changes])
    _log_message(f"Backend planner summary: targets={len(target_contexts)} planned={len(planned_backend_changes)}")

    state["planned_changes"] = merged_changes
    state["errors"] = errors
    return state

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient

def log_planner(message: str) -> None:
    log_agent("Planner", message)


ALLOWED_OPERATIONS = {"replace_text", "replace_all_text", "replace_regex", "set_object_property", "insert_before"}

ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}

ALL_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}


def _normalize_extension_scope(scope: object) -> str:
    if not isinstance(scope, str):
        return ""
    return scope.strip().lower().replace("_", "-").replace(" ", "")


def _extension_scope_targets(scope: object) -> set[str]:
    normalized = _normalize_extension_scope(scope)
    if not normalized or normalized in {"frontend", "front", "client", "web", "ui"}:
        return set(ALL_APP_TARGETS)
    if normalized in {"admin", "admin-frontend", "adminfrontend", "adminfront"}:
        return {"admin-frontend"}
    if normalized in {"expert", "expert-frontend", "expertfrontend", "expertfront"}:
        return {"expert"}
    if normalized in {"corporates", "corporate", "corporate-frontend", "corporatefrontend", "corporatefront"}:
        return {"corporates"}
    if normalized in {
        "all",
        "both",
        "ui",
        "allfrontend",
        "all-frontend",
        "frontend+admin-frontend",
        "frontend-admin-frontend",
    }:
        return set(ALL_APP_TARGETS)
    return set(ALL_APP_TARGETS)


def _normalize_app_targets(raw_targets: object) -> list[str]:
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]

    normalized: list[str] = []
    for item in raw_targets:
        if not isinstance(item, str):
            continue
        candidate = item.strip().lower()
        if candidate in ALLOWED_APP_TARGETS and candidate not in normalized:
            normalized.append(candidate)

    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _is_data_file_path(file_path: str) -> bool:
    return any(file_path == f"{app_root}/utils/data.js" for app_root in ALLOWED_APP_TARGETS)


def _is_literal_replacement_target(file_path: str, app_targets: list[str]) -> bool:
    if not isinstance(file_path, str) or not file_path:
        return False

    js_like_suffixes = (".js", ".jsx", ".ts", ".tsx")
    for app_root in app_targets:
        if file_path == f"{app_root}/utils/data.js":
            return True
        if file_path.startswith(f"{app_root}/pages/") and file_path.endswith(js_like_suffixes):
            return True
        if file_path.startswith(f"{app_root}/components/") and file_path.endswith(js_like_suffixes):
            return True
        if file_path.startswith(f"{app_root}/public/") and file_path.endswith(".html"):
            return True

    # Static-site fallback: allow literal replacements in root HTML/JS/CSS files.
    if "/" not in file_path and file_path.endswith((".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss")):
        return True

    # Generic framework fallback for repositories without canonical app roots.
    if file_path.endswith((".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss")):
        if file_path.startswith(("src/", "app/", "pages/", "public/")):
            return True
        if any(token in file_path.lower() for token in ["index.", "main.", "app.", "home."]):
            return True

    if file_path.endswith((".html", ".htm")):
        return True
    return False


def _get_branding_value(manifest: dict[str, Any], field_name: str) -> str:
    categories = manifest.get("categories", {})
    branding = categories.get("branding", {})
    if not isinstance(branding, dict):
        return ""
    value = branding.get(field_name)
    if isinstance(value, str):
        return value.strip()
    return ""


def _get_theme_value(manifest: dict[str, Any], field_name: str) -> str:
    categories = manifest.get("categories", {})
    theme = categories.get("theme", {})
    if not isinstance(theme, dict):
        return ""
    value = theme.get(field_name)
    if isinstance(value, str):
        return value.strip()
    return ""


def _has_bold_instruction(manifest: dict[str, Any]) -> bool:
    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return False
    for item in extensions:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "")).strip().lower() != "nl_instruction":
            continue
        instruction = str(item.get("value", "")).strip().lower()
        if "bold" in instruction:
            return True
    return False


def _css_var_has_value(file_content: str, var_name: str, value: str) -> bool:
    pattern = rf"{re.escape(var_name)}\s*:\s*{re.escape(value)}\s*;"
    return re.search(pattern, file_content, flags=re.IGNORECASE) is not None


def _get_home_headline_value(manifest: dict[str, Any]) -> str:
    """Return hero headline value from nl_key_value extensions (or legacy ui_copy)."""
    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return ""
    for item in extensions:
        if not isinstance(item, dict):
            continue
        entry_type = str(item.get("type", "")).strip().lower()
        if entry_type == "nl_key_value":
            target_raw = str(item.get("target_raw", "")).strip().lower()
            if target_raw in {"landing.hero_1", "landing.hero_headline"}:
                value = item.get("value")
                if isinstance(value, str) and value.strip():
                    return value.strip()
        elif entry_type == "ui_copy":
            # Legacy backward compat.
            if item.get("scope") != "home":
                continue
            target = str(item.get("target", "")).strip().lower()
            if target not in {"headline", "hero_headline", "headline_line_1", "hero_1"}:
                continue
            value = item.get("value")
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


_STYLE_QUALIFIERS = (" color", " font", " size", " background", " border")


def _get_nl_key_value_extensions(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract nl_key_value extensions as [{target_raw, value, scope_key[0], scope_key[1]}].

    Skips style-qualified targets (those need JSX changes, not data.js).
    """
    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return []
    results: list[dict[str, Any]] = []
    for item in extensions:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "")).strip().lower() != "nl_key_value":
            continue
        app_targets = _extension_scope_targets(item.get("scope", "frontend"))
        target_raw = str(item.get("target_raw", "")).strip().lower()
        value = item.get("value")
        if not target_raw or not isinstance(value, (str, bool, int, float)):
            continue
        if any(q in target_raw for q in _STYLE_QUALIFIERS):
            continue
        parts = target_raw.split(".", 1)
        if len(parts) != 2 or not parts[0] or not parts[1]:
            continue
        normalized_value: Any = value
        if isinstance(value, str):
            normalized_value = value.strip()
        results.append({
            "target_raw": target_raw,
            "scope": parts[0],
            "key": parts[1],
            "value": normalized_value,
            "app_targets": sorted(app_targets),
        })
    return results


def _get_literal_replace_extensions(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract exact literal replacement intents from nl_key_value extensions.

    target_raw values without a scope.key shape are treated as exact old text,
    with value as exact new text.
    """
    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return []

    results: list[dict[str, Any]] = []
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    for item in extensions:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "")).strip().lower() != "nl_key_value":
            continue
        app_targets = _extension_scope_targets(item.get("scope", "frontend"))
        if not app_targets:
            continue

        target_raw = str(item.get("target_raw", "")).strip()
        replacement = item.get("value")
        if not target_raw or not isinstance(replacement, str):
            continue
        if "." in target_raw:
            continue

        old_text = target_raw.strip()
        new_text = replacement.strip()
        if not old_text or not new_text or old_text == new_text:
            continue

        key = (old_text, new_text, tuple(sorted(app_targets)))
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "find": old_text,
            "replace": new_text,
            "app_targets": sorted(app_targets),
        })

    return results


def _manifest_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    categories = manifest.get("categories", {})
    summary: dict[str, Any] = {}
    for section_name in ["branding", "theme", "domains", "portals", "integrations"]:
        section = categories.get(section_name, {})
        if isinstance(section, dict):
            summary[section_name] = {key: value for key, value in section.items() if value not in [None, "", [], {}]}
    if manifest.get("extensions"):
        summary["extensions"] = manifest.get("extensions")
    return summary


def _log_manifest_fields(manifest: dict[str, Any]) -> int:
    summary = _manifest_summary(manifest)
    processed = 0
    log_planner("Manifest fields detected:")
    for section_name, section in summary.items():
        if not section:
            continue
        if isinstance(section, dict):
            for key, value in section.items():
                if value not in [None, "", [], {}]:
                    processed += 1
                    log_planner(f"{section_name}.{key}")
            continue
        if isinstance(section, list):
            for index, item in enumerate(section):
                if item in [None, "", [], {}]:
                    continue
                processed += 1
                if isinstance(item, dict):
                    item_type = item.get("type") if isinstance(item.get("type"), str) else None
                    suffix = f"[{index}].{item_type}" if item_type else f"[{index}]"
                else:
                    suffix = f"[{index}]"
                log_planner(f"{section_name}{suffix}")
            continue
        processed += 1
        log_planner(section_name)
    return processed


def _read_excerpt(repo_path: Path, relative_path: str, max_lines: int = 30) -> str:
    file_path = repo_path / relative_path
    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""
    lines = [line for line in content.splitlines()[:max_lines]]
    return "\n".join(lines)[:1200]


def _read_file_content(repo_path: Path, relative_path: str) -> str:
    file_path = repo_path / relative_path
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""


def _collect_target_contexts(repo_path: Path, repo_map: dict[str, Any], limit: int = 36) -> list[dict[str, str]]:
    ordered_paths: list[str] = []
    for path in repo_map.get("priority_targets", []):
        if path not in ordered_paths:
            ordered_paths.append(path)
    for category_name in ["branding_targets", "theme_targets", "api_targets"]:
        for path in repo_map.get(category_name, []):
            if path not in ordered_paths:
                ordered_paths.append(path)
    contexts: list[dict[str, str]] = []
    for relative_path in ordered_paths[:limit]:
        excerpt = _read_excerpt(repo_path, relative_path)
        if excerpt:
            contexts.append({"path": relative_path, "excerpt": excerpt})
            log_planner(f"Found potential target: {relative_path}")
    return contexts


def _normalize_change(change: object, allowed_paths: set[str]) -> dict[str, Any] | None:
    if not isinstance(change, dict):
        return None
    file_path = change.get("file")
    operation = change.get("operation")
    if not isinstance(file_path, str) or file_path not in allowed_paths:
        return None
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        return None

    # Avoid high-risk freeform rewrites in central config object file.
    if _is_data_file_path(file_path) and operation in {"replace_text", "replace_all_text", "replace_regex", "insert_before"}:
        return None

    normalized: dict[str, Any] = {"file": file_path, "operation": operation}
    for field_name in ["target", "replacement", "pattern", "property", "value", "count"]:
        if field_name in change:
            normalized[field_name] = change[field_name]

    # Guardrail: models sometimes emit regex backref placeholders like "$1" in
    # plain text replacements, which corrupts CSS/HTML/JS files.
    if operation in {"replace_text", "replace_all_text"}:
        replacement = normalized.get("replacement")
        target = normalized.get("target")
        if isinstance(replacement, str) and isinstance(target, str):
            has_regex_placeholder = re.search(r"(?<!\\)\$[1-9]\d*", replacement) is not None
            target_has_placeholder = re.search(r"(?<!\\)\$[1-9]\d*", target) is not None
            if has_regex_placeholder and not target_has_placeholder:
                return None

    # Normalize OpenAI-style "$1" capture references into Python re.sub form.
    if operation == "replace_regex":
        replacement = normalized.get("replacement")
        if isinstance(replacement, str):
            normalized["replacement"] = re.sub(r"(?<!\\)\$(\d+)", r"\\g<\1>", replacement)

    # Modifier supports scalar set_object_property values only.
    if operation == "set_object_property":
        property_name = normalized.get("property")
        value = normalized.get("value")
        if not isinstance(property_name, str) or not property_name.strip():
            return None
        if not isinstance(value, (str, int, float, bool)):
            return None
    return normalized


def _normalize_replacement_text(value: str) -> str:
    return value.replace("\\", r"\\")


def _rewrite_split_jsx_change(change: dict[str, Any], manifest: dict[str, Any], file_content_by_path: dict[str, str]) -> dict[str, Any]:
    if change.get("operation") != "replace_text":
        return change
    relative_path = str(change.get("file", ""))
    if not relative_path.endswith((".js", ".jsx", ".ts", ".tsx")):
        return change
    if not any(
        marker in relative_path
        for marker in [
            "frontend/components/landing/",
            "frontend/pages/index",
            "frontend/pages/home/",
            "admin-frontend/components/landing/",
            "admin-frontend/pages/index",
            "admin-frontend/pages/home/",
            "expert/components/landing/",
            "expert/pages/index",
            "expert/pages/home/",
            "corporates/components/landing/",
            "corporates/pages/index",
            "corporates/pages/home/",
        ]
    ):
        return change

    file_content = file_content_by_path.get(relative_path, "")
    target = str(change.get("target", ""))
    if target and target in file_content:
        return change

    home_headline_value = _get_home_headline_value(manifest)
    replacement = str(change.get("replacement", ""))
    if not home_headline_value or replacement != home_headline_value:
        return change
    if not re.search(r"<h1\b[^>]*>[\s\S]*?</h1>", file_content):
        return change

    indentation = " " * 10
    return {
        "file": relative_path,
        "operation": "replace_regex",
        "pattern": r"(<h1\b[^>]*>)([\s\S]*?)(</h1>)",
        "replacement": f"\\g<1>\n{indentation}{_normalize_replacement_text(home_headline_value)}\n{indentation[:-2]}\\g<3>",
    }


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
        return bool(property_name and value and f"{property_name}" in file_content and value not in file_content)
    if operation == "insert_before":
        target = str(change.get("target", ""))
        replacement = str(change.get("replacement", ""))
        return bool(target and replacement and target in file_content and replacement not in file_content)
    return False


def _build_deterministic_changes(
    manifest: dict[str, Any],
    allowed_paths: set[str],
    file_content_by_path: dict[str, str],
    app_targets: list[str],
) -> list[dict[str, Any]]:
    planned_changes: list[dict[str, Any]] = []
    has_selected_ui_roots = any(
        any(path.startswith(f"{app_root}/") for path in allowed_paths)
        for app_root in app_targets
    )

    def add_change(change: dict[str, Any]) -> None:
        normalized = _normalize_change(change, allowed_paths)
        if normalized:
            normalized = _rewrite_split_jsx_change(normalized, manifest, file_content_by_path)
        if normalized and _is_meaningful_change(normalized, file_content_by_path):
            planned_changes.append(normalized)
            log_planner(f"Generated fallback modification: {normalized}")

    home_headline_value = _get_home_headline_value(manifest)
    if home_headline_value:
        for app_root in app_targets:
            landing_path = f"{app_root}/components/landing/index.jsx"
            if landing_path not in allowed_paths:
                continue
            add_change(
                {
                    "file": landing_path,
                    "operation": "replace_regex",
                    "pattern": r"<h1\b[^>]*>[\s\S]*?</h1>",
                    "replacement": (
                        '<h1 className="lg:text-[64px] mb-5 font-bold text-left md:text-[54px] text-[48px] leading-tight">'
                        f"{home_headline_value}"
                        "</h1>"
                    ),
                }
            )

        # Static-site fallback: rewrite the first <h1> in root HTML entry files.
        if not has_selected_ui_roots:
            entry_candidates = [
                "index.html", "index.htm", "index.html.html",
                "index.js", "index.jsx", "index.ts", "index.tsx",
                "src/index.js", "src/index.jsx", "src/index.ts", "src/index.tsx",
                "src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx",
                "src/App.js", "src/App.jsx", "src/App.ts", "src/App.tsx",
                "app/page.js", "app/page.jsx", "app/page.ts", "app/page.tsx",
                "pages/index.js", "pages/index.jsx", "pages/index.ts", "pages/index.tsx",
            ]
            for entry_path in entry_candidates:
                if entry_path not in allowed_paths:
                    continue
                add_change(
                    {
                        "file": entry_path,
                        "operation": "replace_regex",
                        "pattern": r"(<h1\\b[^>]*>)([\\s\\S]*?)(</h1>)",
                        "replacement": rf"\\g<1>{_normalize_replacement_text(home_headline_value)}\\g<3>",
                    }
                )

    # Apply nl_key_value text/visibility extensions as set_object_property on data.js.
    for app_root in app_targets:
        data_path = f"{app_root}/utils/data.js"
        if data_path not in allowed_paths:
            continue
        for ext in _get_nl_key_value_extensions(manifest):
            if app_root not in ext.get("app_targets", ["frontend"]):
                continue
            leaf_key = ext["key"]
            value = ext["value"]
            # For visibility keys, convert string "true"/"false" to boolean.
            if leaf_key.startswith("show_") and isinstance(value, str):
                if value.lower() in {"true", "1", "yes"}:
                    value = True
                elif value.lower() in {"false", "0", "no"}:
                    value = False
            add_change(
                {
                    "file": data_path,
                    "operation": "set_object_property",
                    "property": leaf_key,
                    "value": value,
                }
            )

    company_name = _get_branding_value(manifest, "company_name")
    title = _get_branding_value(manifest, "title")
    contact_email = _get_branding_value(manifest, "contact_email")
    for app_root in app_targets:
        data_path = f"{app_root}/utils/data.js"
        if data_path not in allowed_paths:
            continue
        if company_name:
            add_change(
                {
                    "file": data_path,
                    "operation": "set_object_property",
                    "property": "companyName",
                    "value": company_name,
                }
            )
        if title:
            add_change(
                {
                    "file": data_path,
                    "operation": "set_object_property",
                    "property": "title",
                    "value": title,
                }
            )
        if contact_email:
            add_change(
                {
                    "file": data_path,
                    "operation": "set_object_property",
                    "property": "email",
                    "value": contact_email,
                }
            )

    # Apply exact literal replacement extensions across selected frontend roots.
    literal_replacements = _get_literal_replace_extensions(manifest)
    if literal_replacements:
        literal_root_constrained = has_selected_ui_roots
        for relative_path in sorted(allowed_paths):
            if not _is_literal_replacement_target(relative_path, app_targets):
                continue

            file_content = file_content_by_path.get(relative_path, "")
            if not file_content:
                continue

            for replacement in literal_replacements:
                if literal_root_constrained and not any(relative_path.startswith(f"{app}/") for app in replacement.get("app_targets", ["frontend"])):
                    continue
                if replacement["find"] not in file_content:
                    continue
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_all_text",
                        "target": replacement["find"],
                        "replacement": replacement["replace"],
                    }
                )

    # Theme/style deterministic fallback for static and heterogeneous repositories.
    # This ensures we still produce safe CSS edits when LLM planning fails.
    theme_primary = _get_theme_value(manifest, "primary")
    theme_secondary = _get_theme_value(manifest, "secondary")
    theme_accent = _get_theme_value(manifest, "accent")
    bold_requested = _has_bold_instruction(manifest)

    css_candidates = sorted(
        path for path in allowed_paths
        if path.endswith((".css", ".scss"))
    )

    for relative_path in css_candidates:
        file_content = file_content_by_path.get(relative_path, "")
        if not file_content:
            continue

        if theme_primary:
            for var_name in ["--primary", "--teal", "--red"]:
                if f"{var_name}:" not in file_content:
                    continue
                if _css_var_has_value(file_content, var_name, theme_primary):
                    continue
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_regex",
                        "pattern": rf"({re.escape(var_name)}\\s*:\\s*)[^;]+;",
                        "replacement": rf"\\g<1>{theme_primary};",
                        "count": 0,
                    }
                )

        if theme_secondary:
            for var_name in ["--secondary", "--secondary-brand", "--cyan", "--edge"]:
                if f"{var_name}:" not in file_content:
                    continue
                if _css_var_has_value(file_content, var_name, theme_secondary):
                    continue
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_regex",
                        "pattern": rf"({re.escape(var_name)}\\s*:\\s*)[^;]+;",
                        "replacement": rf"\\g<1>{theme_secondary};",
                        "count": 0,
                    }
                )

        if theme_accent:
            for var_name in ["--accent", "--ink-soft"]:
                if f"{var_name}:" not in file_content:
                    continue
                if _css_var_has_value(file_content, var_name, theme_accent):
                    continue
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_regex",
                        "pattern": rf"({re.escape(var_name)}\\s*:\\s*)[^;]+;",
                        "replacement": rf"\\g<1>{theme_accent};",
                        "count": 0,
                    }
                )

        if (theme_primary or theme_secondary or theme_accent) and ":root" in file_content and "--shadow:" in file_content and "--primary:" not in file_content:
            injected_lines: list[str] = []
            if theme_primary:
                injected_lines.append(f"  --primary: {theme_primary};")
            if theme_secondary:
                injected_lines.append(f"  --secondary: {theme_secondary};")
            if theme_accent:
                injected_lines.append(f"  --accent: {theme_accent};")
            if injected_lines:
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_text",
                        "target": "--shadow:",
                        "replacement": "\\n".join(injected_lines) + "\\n  --shadow:",
                    }
                )

        if bold_requested:
            add_change(
                {
                    "file": relative_path,
                    "operation": "replace_regex",
                    "pattern": r"(font-weight:\\s*)(300|400|500|600)\\b",
                    "replacement": r"\\g<1>700",
                    "count": 0,
                }
            )
            if "font-weight: 700" not in file_content:
                add_change(
                    {
                        "file": relative_path,
                        "operation": "replace_regex",
                        "pattern": r"(body\\s*\\{[\\s\\S]*?font-family:[^;]+;)",
                        "replacement": r"\\g<1>\\n  font-weight: 700;",
                    }
                )

    return planned_changes


def plan_frontend_changes(state: dict) -> dict:
    manifest = state["manifest"]
    app_targets = _normalize_app_targets(state.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"]))
    repo_map = state.get("repo_map", {})
    planned_changes: list[dict[str, Any]] = []
    processed_fields = _log_manifest_fields(manifest)
    repo_path = Path(state["repo_path"])
    errors = list(state.get("errors", []))
    validator_feedback = [
        item for item in errors if isinstance(item, str) and item.startswith("Validator issue")
    ]
    target_contexts = _collect_target_contexts(repo_path, repo_map)
    allowed_paths = {context["path"] for context in target_contexts}
    file_content_by_path = {
        relative_path: _read_file_content(repo_path, relative_path)
        for relative_path in allowed_paths
    }

    all_frontend_files_raw = repo_map.get("all_frontend_files", [])
    all_frontend_files = [
        path
        for path in all_frontend_files_raw
        if isinstance(path, str)
        and any(path.startswith(f"{app_root}/") for app_root in app_targets)
    ]
    if not all_frontend_files:
        all_frontend_files = sorted(allowed_paths)
    deterministic_allowed_paths = set(all_frontend_files)
    deterministic_file_content_by_path = {
        relative_path: _read_file_content(repo_path, relative_path)
        for relative_path in deterministic_allowed_paths
    }

    client = ProjectLLMClient()
    if not client.is_configured():
        log_planner("Planner LLM client is not configured. Using deterministic fallback planner.")
        planned_changes = _build_deterministic_changes(
            manifest,
            deterministic_allowed_paths,
            deterministic_file_content_by_path,
            app_targets,
        )
        state["planned_changes"] = planned_changes
        state["errors"] = errors
        return state

    if not target_contexts:
        log_planner("WARNING: No UI components or frontend targets detected for planning.")

    system_prompt = (
        "You are a frontend customization planner. Use the manifest summary and small file excerpts to dynamically design a safe modification plan. "
        "Return strict JSON only. Only generate changes for provided frontend files."
    )
    user_prompt = (
        "Manifest summary:\n"
        f"{json.dumps(_manifest_summary(manifest), indent=2)}\n\n"
        "Repo map from scanner:\n"
        f"{json.dumps(repo_map, indent=2)}\n\n"
        "Complete frontend file inventory (selected app roots):\n"
        f"{json.dumps(repo_map.get('all_frontend_files', []), indent=2)}\n\n"
        "Candidate file excerpts:\n"
        f"{json.dumps(target_contexts, indent=2)}\n\n"
        "Prior validator issues from previous pass:\n"
        f"{json.dumps(validator_feedback, indent=2)}\n\n"
        "Return a JSON object with this shape:\n"
        "{\n"
        '  "reasoning": ["short reasoning line"],\n'
        '  "planned_changes": [\n'
        "    {\n"
        '      "file": "path/from/repo/root",\n'
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
        "- Repositories are heterogeneous: static HTML/CSS/JS, React (src/*.tsx), Next.js (app/* or pages/*), or custom structures. Plan only against files that exist in provided candidates.\n"
        "- Selected UI app roots may include frontend, admin-frontend, expert, and corporates. Each root can store display text in <app-root>/utils/data.js under companyData.text.<scope>.<key> "
        "(scopes: landing, topbar, footer, auth, all_sessions, contact, home, my_schedule, my_communities, search, browse_classes, cart_checkout, course_details, community_details, user_settings, all_sessions_live, all_sessions_videos, community_home, community_subscription, media_player, community_commerce, category_sessions, trainer_bio, user_portal, session_management, community_threads, student_registration) and visibility toggles under companyData.visibility.<scope>.<key>.\n"
        "- For nl_key_value extensions with target_raw like '<scope>.<key>':\n"
        "  * TEXT changes (e.g. landing.hero_1): if suitable data.js exists, use set_object_property on <app-root>/utils/data.js with property = leaf key name (e.g. 'hero_1'). If data.js does not exist, update visible text directly in HTML/JSX/TSX entry files.\n"
        "  * VISIBILITY changes (key starts with 'show_', e.g. landing.show_hero): use set_object_property on <app-root>/utils/data.js with property = leaf key (e.g. 'show_hero') and value = boolean.\n"
        "- For nl_key_value entries whose target_raw is NOT scope.key (generic literal text), plan JSX replace_text/replace_all_text updates in frontend pages/components using exact old/new text.\n"
        "  * STYLE changes (target_raw contains 'color', 'font', 'size', 'background'): modify the JSX component file (e.g. frontend/components/landing/index.jsx) using replace_text or replace_regex on Tailwind classes or inline styles. Do NOT modify data.js for style changes.\n"
        "- Only set_object_property is allowed on <app-root>/utils/data.js. Do not use replace_text, replace_all_text, replace_regex, or insert_before on data.js.\n"
        "- Prefer visible UI files, metadata files, and branding-rendering components when branding fields are present.\n"
        "- For JSX headings or paragraphs split across line breaks or tags, prefer replace_regex on the enclosing <h1>, <h2>, or <p> block instead of plain replace_text.\n"
        "- When changing repeated Tailwind classes or repeated JSX labels, use replace_regex with count=0 to update all matches.\n"
        "- Prefer theme or style files when theme fields are present.\n"
        "- Prefer URL/config files when domain fields are present.\n"
        "- For branding, theme, domain, and extension-driven copy changes, replacements must exactly match manifest values or extension values. Do not paraphrase or normalize strings.\n"
        "- Prior validator issues are high-priority repair targets. Prefer precise, minimal fixes that resolve those issues without introducing new regressions.\n"
        "- Propose only meaningful edits. If the desired value already appears in the excerpt, omit that change.\n"
        "- Do not invent files or operations.\n"
        "- Do not modify backend files.\n"
        "- Use concise reasoning.\n"
        "- If no safe change is possible, return an empty planned_changes array and explain why."
    )

    try:
        result = client.complete_json(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=1800)
        reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
        for line in reasoning if isinstance(reasoning, list) else []:
            if isinstance(line, str) and line.strip():
                log_planner(line.strip())
        for raw_change in result.get("planned_changes", []) if isinstance(result, dict) else []:
            normalized = _normalize_change(raw_change, allowed_paths)
            if normalized:
                normalized = _rewrite_split_jsx_change(normalized, manifest, file_content_by_path)
            if normalized and _is_meaningful_change(normalized, file_content_by_path):
                planned_changes.append(normalized)
                log_planner(f"Generated modification: {normalized}")
            elif normalized:
                log_planner(f"Skipping no-op change: {normalized}")
    except Exception as exc:
        log_planner(f"Planner LLM failed. Using deterministic fallback planner: {exc}")
        planned_changes = _build_deterministic_changes(
            manifest,
            deterministic_allowed_paths,
            deterministic_file_content_by_path,
            app_targets,
        )

    # Always merge deterministic safety-net changes so static repositories
    # (for example root index.html + styles.css) are not skipped when LLM
    # planning succeeds but misses key nl_key_value intents.
    deterministic_safety_net = _build_deterministic_changes(
        manifest,
        deterministic_allowed_paths,
        deterministic_file_content_by_path,
        app_targets,
    )
    if deterministic_safety_net:
        existing_signatures = {
            json.dumps(change, sort_keys=True, default=str)
            for change in planned_changes
        }
        merged_count = 0
        for change in deterministic_safety_net:
            signature = json.dumps(change, sort_keys=True, default=str)
            if signature in existing_signatures:
                continue
            planned_changes.append(change)
            existing_signatures.add(signature)
            merged_count += 1
        if merged_count > 0:
            log_planner(f"Merged {merged_count} deterministic safety-net change(s).")

    if not planned_changes:
        no_modifications_error = "Planner produced no modifications."
        log_planner(f"ERROR: {no_modifications_error}")
        if no_modifications_error not in errors:
            errors.append(no_modifications_error)

    log_planner("Planner Summary")
    log_planner(f"Manifest fields processed: {processed_fields}")
    log_planner(f"Targets discovered: {len(target_contexts)}")
    log_planner(f"Planned modifications: {len(planned_changes)}")

    state["planned_changes"] = planned_changes
    state["errors"] = errors
    return state


def plan_changes(state: dict) -> dict:
    """Backward-compatible alias for older imports."""
    return plan_frontend_changes(state)

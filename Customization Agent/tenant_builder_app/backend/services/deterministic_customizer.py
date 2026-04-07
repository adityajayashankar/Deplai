from __future__ import annotations

from pathlib import Path
import re
from typing import Any

from services.agent_logger import log_agent


ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}

ALL_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}

IGNORED_WALK_DIRECTORIES = {
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".git",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
}


def _log(message: str) -> None:
    log_agent("DeterministicCustomizer", message)


def _normalize_app_targets(raw_targets: object) -> list[str]:
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]

    normalized: list[str] = []
    for target in raw_targets:
        if not isinstance(target, str):
            continue
        candidate = target.strip().lower()
        if candidate in ALLOWED_APP_TARGETS and candidate not in normalized:
            normalized.append(candidate)

    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _assert_tenant_repo(repo_root: Path) -> None:
    if not repo_root.name.startswith("SubSpace-"):
        raise ValueError(f"Refusing to modify non-tenant repository: {repo_root}")


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string_or_default(value: object, default: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def _safe_css_value(value: str, fallback: str) -> str:
    cleaned = value.strip().replace("\n", " ").replace("\r", " ")
    cleaned = re.sub(r"[^#a-zA-Z0-9_\-\s,.'\"]", "", cleaned)
    return cleaned or fallback


def _safe_js_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


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


def _path_is_ignored(path: Path) -> bool:
    return any(part in IGNORED_WALK_DIRECTORIES for part in path.parts)


def _tailwind_arbitrary_color(primary: str) -> str:
    """Return a safe color token for Tailwind arbitrary values like bg-[...]."""
    return primary.strip().replace(" ", "")


def _hex_to_rgb_tuple(value: str) -> tuple[int, int, int] | None:
    token = value.strip().lstrip("#")
    if len(token) == 3 and re.fullmatch(r"[0-9a-fA-F]{3}", token):
        token = "".join(ch * 2 for ch in token)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", token):
        return None
    return int(token[0:2], 16), int(token[2:4], 16), int(token[4:6], 16)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _write_text(path: Path, content: str, modified: list[str], repo_root: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    rel = path.relative_to(repo_root).as_posix()
    if rel not in modified:
        modified.append(rel)


def _replace_regex(path: Path, pattern: str, replacement: str, modified: list[str], repo_root: Path, count: int = 1) -> bool:
    if not path.exists():
        return False
    original = path.read_text(encoding="utf-8")
    updated, changed = re.subn(pattern, replacement, original, count=count)
    if changed and updated != original:
        _write_text(path, updated, modified, repo_root)
        return True
    return False


def _js_literal(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return f'"{_safe_js_string(str(value))}"'


def _set_object_property(content: str, property_name: str, value: object) -> str:
    literal = _js_literal(value)
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


def _find_matching_brace(content: str, open_index: int) -> int:
    depth = 0
    in_single = False
    in_double = False
    escaped = False
    for index in range(open_index, len(content)):
        ch = content[index]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if not in_double and ch == "'":
            in_single = not in_single
            continue
        if not in_single and ch == '"':
            in_double = not in_double
            continue
        if in_single or in_double:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _set_scoped_data_property(content: str, section: str, scope: str, key: str, value: object) -> str:
    section_match = re.search(rf"\b{re.escape(section)}\s*:\s*\{{", content)
    if not section_match:
        return content

    section_open = content.find("{", section_match.start())
    section_close = _find_matching_brace(content, section_open)
    if section_open == -1 or section_close == -1:
        return content

    scope_block = content[section_open: section_close + 1]
    scope_match = re.search(rf"\b{re.escape(scope)}\s*:\s*\{{", scope_block)
    if not scope_match:
        return content

    scope_open = scope_block.find("{", scope_match.start())
    scope_close = _find_matching_brace(scope_block, scope_open)
    if scope_open == -1 or scope_close == -1:
        return content

    scope_content = scope_block[scope_open: scope_close + 1]
    updated_scope_content = _set_object_property(scope_content, key, value)
    if updated_scope_content == scope_content:
        return content

    updated_scope_block = (
        scope_block[:scope_open]
        + updated_scope_content
        + scope_block[scope_close + 1:]
    )
    return (
        content[:section_open]
        + updated_scope_block
        + content[section_close + 1:]
    )


def _canonical_data_scope(scope: str) -> str:
    normalized = scope.strip().lower()
    aliases = {
        "home": "landing",
        "homepage": "landing",
        "index": "landing",
        "navbar": "topbar",
        "header": "topbar",
        "nav": "topbar",
        "legal": "footer",
        "login": "auth",
        "signup": "auth",
        "register": "auth",
        "onboarding": "auth",
        "onboard": "auth",
    }
    return aliases.get(normalized, normalized)


def _set_object_property_by_prefix(content: str, key_prefix: str, value: str) -> str:
    """
    Update the first string property whose key starts with a given prefix.
    Example: key_prefix='part_21_' matches part_21_section_title_line_1.
    """
    escaped = _safe_js_string(value)
    patterns = [
        rf'(({re.escape(key_prefix)}[a-zA-Z0-9_]*)\s*:\s*")(.*?)(")',
        rf"(({re.escape(key_prefix)}[a-zA-Z0-9_]*)\s*:\s*')(.*?)(')",
    ]
    for pattern in patterns:
        updated, count = re.subn(pattern, rf"\g<1>{escaped}\g<4>", content, count=1)
        if count:
            return updated
    return content


def _iter_text_extensions(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract text/visibility extensions from manifest.

    Handles both the new ``nl_key_value`` format (``target_raw`` =
    ``<scope>.<key>``) and legacy ``ui_copy`` entries for backward
    compatibility.  Style-qualified targets (containing " color", " font",
    " size") are skipped — those need JSX changes handled by the LLM
    modifier, not deterministic property patching.
    """
    extensions = manifest.get("extensions")
    if not isinstance(extensions, list):
        return []

    _STYLE_QUALIFIERS = (" color", " font", " size", " background", " border")

    items: list[dict[str, Any]] = []
    for entry in extensions:
        if not isinstance(entry, dict):
            continue

        entry_type = str(entry.get("type", "")).strip().lower()

        if entry_type == "nl_key_value":
            target_raw = str(entry.get("target_raw", "")).strip().lower()
            has_value = "value" in entry
            value = entry.get("value", "")
            if not target_raw:
                continue
            if value is None:
                value = ""
            elif not isinstance(value, (str, bool, int, float)):
                if has_value:
                    continue
                value = ""
            app_targets = _extension_scope_targets(entry.get("scope", "frontend"))
            # Skip style-qualified targets — they require JSX changes.
            if any(q in target_raw for q in _STYLE_QUALIFIERS):
                continue
            # Split "<scope>.<key>" into scope and leaf key.
            parts = target_raw.split(".", 1)
            if len(parts) != 2 or not parts[0] or not parts[1]:
                continue
            scope, key = parts
            coerced_value: object = value
            if isinstance(value, str):
                normalized_value = value.strip()
                if key.startswith("show_"):
                    lowered = normalized_value.lower()
                    if lowered in {"true", "1", "yes"}:
                        coerced_value = True
                    elif lowered in {"false", "0", "no"}:
                        coerced_value = False
                    else:
                        continue
                else:
                    coerced_value = normalized_value
            items.append({
                "scope": scope,
                "key": key,
                "value": coerced_value,
                "app_targets": sorted(app_targets),
            })

        elif entry_type == "ui_copy":
            # Legacy backward compat — convert to scope/key form.
            scope = str(entry.get("scope", "")).strip().lower()
            target = str(entry.get("target", "")).strip().lower()
            value = entry.get("value")
            if not isinstance(value, str) or not value.strip():
                continue
            if not scope or not target:
                continue
            items.append({
                "scope": scope,
                "key": target,
                "value": value.strip(),
                "app_targets": ["frontend", "admin-frontend", "expert", "corporates"],
            })

    return items


def _iter_literal_replace_extensions(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract generic literal replacement intents from extensions.

    Supports nl_key_value entries where target_raw is not scope.key. These are
    treated as exact frontend text replacement requests for deterministic
    fallback coverage when a semantic key is unavailable.
    """
    extensions = manifest.get("extensions")
    if not isinstance(extensions, list):
        return []

    items: list[dict[str, Any]] = []
    for entry in extensions:
        if not isinstance(entry, dict):
            continue
        entry_type = str(entry.get("type", "")).strip().lower()
        if entry_type != "nl_key_value":
            continue
        app_targets = _extension_scope_targets(entry.get("scope", "frontend"))
        if not app_targets:
            continue

        target_raw = str(entry.get("target_raw", "")).strip()
        replacement = entry.get("value")
        if not target_raw or not isinstance(replacement, str):
            continue

        # If target_raw looks like scope.key, it belongs to data.js patching.
        if "." in target_raw:
            continue

        find_text = target_raw.strip()
        replace_text = replacement.strip()
        if not find_text or find_text == replace_text:
            continue

        items.append({
            "find": find_text,
            "replace": replace_text,
            "app_targets": sorted(app_targets),
        })

    # Preserve order, dedupe exact pairs.
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        pair = (item["find"], item["replace"], tuple(item["app_targets"]))
        if pair in seen:
            continue
        seen.add(pair)
        deduped.append(item)
    return deduped


def _replace_literal_in_content(content: str, find_text: str, replace_text: str) -> tuple[str, int]:
    """Apply conservative literal replacements in JSX/text and string contexts."""
    updated = content
    changed = 0

    escaped_find = re.escape(find_text)
    escaped_double_repl = replace_text.replace("\\", "\\\\").replace('"', '\\"')
    escaped_single_repl = replace_text.replace("\\", "\\\\").replace("'", "\\'")

    # JSX text nodes: >Old Text<
    updated, count = re.subn(
        rf">\s*{escaped_find}\s*<",
        f">{replace_text}<",
        updated,
    )
    changed += count

    # JSX text nodes containing the target as a substring.
    def _replace_jsx_substring(match: re.Match[str]) -> str:
        chunk = match.group(1)
        if find_text not in chunk:
            return match.group(0)
        return f">{chunk.replace(find_text, replace_text)}<"

    updated, count = re.subn(
        r">([^<{}]*?)<",
        _replace_jsx_substring,
        updated,
    )
    changed += count

    # Double-quoted string literals.
    updated, count = re.subn(
        rf'"{escaped_find}"',
        f'"{escaped_double_repl}"',
        updated,
    )
    changed += count

    # Single-quoted string literals.
    updated, count = re.subn(
        rf"'{escaped_find}'",
        f"'{escaped_single_repl}'",
        updated,
    )
    changed += count

    # Replace occurrences inside quoted string literals (substring replacement).
    def _replace_double_literal(match: re.Match[str]) -> str:
        literal_body = match.group(1)
        if find_text not in literal_body:
            return match.group(0)
        replaced = literal_body.replace(find_text, escaped_double_repl)
        return f'"{replaced}"'

    updated, count = re.subn(r'"((?:\\.|[^"\\])*)"', _replace_double_literal, updated)
    changed += count

    def _replace_single_literal(match: re.Match[str]) -> str:
        literal_body = match.group(1)
        if find_text not in literal_body:
            return match.group(0)
        replaced = literal_body.replace(find_text, escaped_single_repl)
        return f"'{replaced}'"

    updated, count = re.subn(r"'((?:\\.|[^'\\])*)'", _replace_single_literal, updated)
    changed += count

    return updated, changed


def _patch_frontend_literal_replacements(
    repo_root: Path,
    manifest: dict[str, Any],
    modified: list[str],
    app_root: str,
) -> None:
    """Apply generic literal replacements across frontend files.

    This deterministic fallback enables customization for arbitrary UI copy
    that has not yet been mapped to semantic companyData.text keys.
    """
    replacements = _iter_literal_replace_extensions(manifest)
    if not replacements:
        return

    app_replacements = [
        item for item in replacements if app_root in item.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"])
    ]
    if not app_replacements:
        return

    frontend_root = repo_root / app_root
    if not frontend_root.exists():
        return

    search_roots = [frontend_root / "pages", frontend_root / "components", frontend_root / "public"]
    allowed_suffixes = {".js", ".jsx", ".ts", ".tsx", ".html"}

    candidate_files: list[Path] = []
    for root in search_roots:
        if not root.exists():
            continue
        for file_path in root.rglob("*"):
            if _path_is_ignored(file_path):
                continue
            if not file_path.is_file() or file_path.suffix not in allowed_suffixes:
                continue
            candidate_files.append(file_path)

    data_js = frontend_root / "utils" / "data.js"
    if data_js.exists() and data_js.is_file() and not _path_is_ignored(data_js):
        candidate_files.append(data_js)

    seen_files: set[str] = set()
    for file_path in candidate_files:
        rel = file_path.relative_to(repo_root).as_posix()
        if rel in seen_files:
            continue
        seen_files.add(rel)

        original = _read_text(file_path)
        if not original:
            continue

        updated = original
        total_changed = 0
        for replacement in app_replacements:
            updated, changed = _replace_literal_in_content(
                updated,
                replacement["find"],
                replacement["replace"],
            )
            total_changed += changed

        if total_changed and updated != original:
            _write_text(file_path, updated, modified, repo_root)


def _text_key_candidates(scope: str, key: str) -> list[str]:
    """Return candidate property names to search for in data.js.

    With the new ``text``/``visibility`` structure the leaf key names in
    ``data.js`` already match the semantic keys (e.g. ``hero_1``,
    ``nav_home``, ``show_hero``).  So the primary candidate is always the
    key itself.

    A small alias map is kept per scope for common natural-language
    variations that users or the LLM might produce (e.g. ``"headline"``
    → ``"hero_1"``).  The old ``part_*`` aliases are removed — those keys
    no longer exist in the refactored ``data.js``.
    """
    normalized = key.replace("-", "_").replace(" ", "_").strip("_").lower()
    candidates: list[str] = []

    # Scope-specific aliases for common natural-language synonyms.
    if scope in {"home", "homepage", "landing", "index"}:
        alias_map = {
            "headline": ["hero_1"],
            "hero_headline": ["hero_1"],
            "headline_line_1": ["hero_1"],
            "headline_line_2": ["hero_2"],
            "headline_highlight": ["hero_3"],
            "description": ["hero_description"],
            "cta": ["hero_cta"],
        }
        candidates.extend(alias_map.get(normalized, []))

    if scope in {"topbar", "navbar", "header", "nav"}:
        alias_map = {
            "home": ["nav_home"],
            "schedule": ["nav_schedule"],
            "communities": ["nav_communities"],
            "login": ["cta_login"],
            "logout": ["cta_logout"],
        }
        candidates.extend(alias_map.get(normalized, []))

    if scope in {"footer", "legal"}:
        alias_map = {
            "privacy": ["privacy_policy"],
            "terms": ["terms_of_service"],
        }
        candidates.extend(alias_map.get(normalized, []))

    if scope in {"auth", "onboard", "onboarding", "login", "signup", "register"}:
        alias_map = {
            "welcome": ["welcome_message"],
            "sign_in": ["sign_in_title"],
            "create_account": ["create_account_title"],
        }
        candidates.extend(alias_map.get(normalized, []))

    # Always include the key as-is as final candidate.
    if normalized:
        candidates.append(normalized)

    # Preserve order, drop duplicates.
    seen: set[str] = set()
    deduped: list[str] = []
    for k in candidates:
        if k and k not in seen:
            seen.add(k)
            deduped.append(k)
    return deduped


def _parts_to_feature_flags(parts: set[int], initial: bool) -> dict[str, bool]:
    flags: dict[str, bool] = {}
    if any(6 <= value <= 10 for value in parts):
        flags["landing_provide"] = initial
    if any(12 <= value <= 12 for value in parts):
        flags["landing_hangout"] = initial
    if any(13 <= value <= 14 for value in parts):
        flags["landing_experts"] = initial
    if any(16 <= value <= 17 for value in parts):
        flags["communities"] = initial
    if any(18 <= value <= 20 for value in parts):
        flags["sessions"] = initial
    return flags


def _parse_int_parts(value: object) -> set[int]:
    if not isinstance(value, list):
        return set()
    parts: set[int] = set()
    for item in value:
        if isinstance(item, int):
            parts.add(item)
        elif isinstance(item, str) and item.strip().isdigit():
            parts.add(int(item.strip()))
    return parts


def _feature_overrides_from_extensions(manifest: dict[str, Any]) -> dict[str, bool]:
    overrides: dict[str, bool] = {}
    extensions = manifest.get("extensions")
    if not isinstance(extensions, list):
        return overrides

    for entry in extensions:
        if not isinstance(entry, dict):
            continue

        extension_type = str(entry.get("type", "")).strip().lower()

        if extension_type == "landing_config":
            disabled_parts = _parse_int_parts(entry.get("disabled_parts"))
            enabled_parts = _parse_int_parts(entry.get("enabled_parts"))
            overrides.update(_parts_to_feature_flags(disabled_parts, initial=False))
            overrides.update(_parts_to_feature_flags(enabled_parts, initial=True))

        if extension_type == "ui_customization":
            scope = str(entry.get("scope", "")).strip().lower()
            target = str(entry.get("target", "")).strip().lower()
            value = str(entry.get("value", "")).strip().lower()
            if scope in {"login", "auth", "onboard"}:
                hide_image_targets = {"remove_image", "hide_image", "login_image", "hero_image"}
                hide_image_values = {"remove", "hide", "none", "off", "false", "disable"}
                if target in hide_image_targets and (not value or value in hide_image_values):
                    overrides["auth_hide_image"] = True

    return overrides


def _write_tenant_theme_css(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    theme = _as_dict(categories.get("theme"))

    primary = _safe_css_value(_string_or_default(theme.get("primary"), "#3b82f6"), "#3b82f6")
    secondary = _safe_css_value(_string_or_default(theme.get("secondary"), "#1f2937"), "#1f2937")
    accent = _safe_css_value(_string_or_default(theme.get("accent"), primary), primary)
    font_heading = _safe_css_value(_string_or_default(theme.get("font_heading"), "Maven Pro"), "Maven Pro")
    font_body = _safe_css_value(_string_or_default(theme.get("font_body"), "Maven Pro"), "Maven Pro")

    radius_lookup = {
        "none": "0px",
        "sm": "4px",
        "md": "8px",
        "lg": "12px",
        "xl": "16px",
        "2xl": "24px",
        "full": "9999px",
    }
    border_radius_raw = _string_or_default(theme.get("border_radius"), "md").lower()
    border_radius = radius_lookup.get(border_radius_raw, "8px")

    content = (
        ":root {\n"
        f"  --tenant-primary: {primary};\n"
        f"  --tenant-secondary: {secondary};\n"
        f"  --tenant-accent: {accent};\n"
        f"  --tenant-font-heading: '{font_heading}', sans-serif;\n"
        f"  --tenant-font-body: '{font_body}', sans-serif;\n"
        f"  --tenant-radius: {border_radius};\n"
        "}\n\n"
        "* {\n"
        "  font-family: var(--tenant-font-body);\n"
        "}\n\n"

        "body {\n"
        "  color: var(--tenant-secondary);\n"
        "}\n\n"

        "h1, h2, h3, h4, h5, h6 {\n"
        "  font-family: var(--tenant-font-heading);\n"
        "}\n\n"
        ".gradient_background {\n"
        "  background: var(--tenant-primary) !important;\n"
        "}\n\n"
        ".gradient_text {\n"
        "  background: var(--tenant-primary) !important;\n"
        "}\n\n"
        ".square-blue-border-button {\n"
        "  border-color: var(--tenant-primary) !important;\n"
        "  color: var(--tenant-primary) !important;\n"
        "  border-radius: var(--tenant-radius) !important;\n"
        "}\n\n"
        ".pill-button-active {\n"
        "  background: var(--tenant-primary) !important;\n"
        "}\n\n"
        "input, textarea, select, button, .button, .input {\n"
        "  border-radius: var(--tenant-radius) !important;\n"
        "}\n\n"
        "input {\n"
        "  accent-color: var(--tenant-primary) !important;\n"
        "}\n\n"

        "::-webkit-scrollbar {\n"
        "  width: 10px;\n"
        "  height: 10px;\n"
        "}\n\n"

        "::-webkit-scrollbar-thumb {\n"
        "  background: var(--tenant-primary);\n"
        "  border-radius: 9999px;\n"
        "}\n\n"

        "::-webkit-scrollbar-track {\n"
        "  background: color-mix(in srgb, var(--tenant-secondary) 10%, white);\n"
        "}\n"
    )

    theme_path = repo_root / app_root / "styles" / "tenant-theme.css"
    _write_text(theme_path, content, modified, repo_root)


def _patch_hardcoded_tailwind_primary(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    """
    Replace hardcoded Tailwind arbitrary primary color classes such as
    bg-[#3b82f6] / text-[#3b82f6] with the manifest primary color.
    """
    categories = _as_dict(manifest.get("categories"))
    theme = _as_dict(categories.get("theme"))
    primary_raw = _string_or_default(theme.get("primary"), "#3b82f6")
    primary = _tailwind_arbitrary_color(_safe_css_value(primary_raw, "#3b82f6"))
    if not primary:
        return

    frontend_root = repo_root / app_root
    if not frontend_root.exists():
        return

    # Common legacy/default blues found in hardcoded Tailwind arbitrary classes.
    old_primary_hex_tokens = [
        "#3b82f6",
        "#2563eb",
        "#1d4ed8",
    ]
    old_primary_rgb_tokens = [
        (59, 130, 246),
        (37, 99, 235),
        (29, 78, 216),
    ]
    primary_rgb = _hex_to_rgb_tuple(primary)

    utility_prefixes = "(?:bg|text|border|from|to|via|ring|outline|decoration|fill|stroke)"
    old_primary_alt = "|".join(re.escape(token) for token in old_primary_hex_tokens)
    tailwind_class_pattern = re.compile(
        rf"({utility_prefixes}-)\\[\\s*(?:{old_primary_alt})\\s*\\]",
        flags=re.IGNORECASE,
    )

    for file_path in frontend_root.rglob("*"):
        if _path_is_ignored(file_path):
            continue
        if not file_path.is_file():
            continue
        if file_path.suffix not in {".js", ".jsx", ".ts", ".tsx", ".css", ".scss"}:
            continue

        original = _read_text(file_path)
        if not original:
            continue

        updated = original
        changed = 0

        updated, count = tailwind_class_pattern.subn(rf"\g<1>[{primary}]", updated)
        changed += count

        # Replace plain hex color literals used in inline styles or JS objects.
        for token in old_primary_hex_tokens:
            updated, count = re.subn(re.escape(token), primary, updated, flags=re.IGNORECASE)
            changed += count

        # Replace rgb()/rgba() blue literals used in inline style attributes.
        for r, g, b in old_primary_rgb_tokens:
            rgb_pattern = rf"rgb\(\s*{r}\s*,\s*{g}\s*,\s*{b}\s*\)"
            updated, count = re.subn(rgb_pattern, primary, updated, flags=re.IGNORECASE)
            changed += count

            rgba_pattern = rf"rgba\(\s*{r}\s*,\s*{g}\s*,\s*{b}\s*,\s*([0-9]*\.?[0-9]+)\s*\)"
            if primary_rgb:
                pr, pg, pb = primary_rgb
                updated, count = re.subn(
                    rgba_pattern,
                    rf"rgba({pr}, {pg}, {pb}, \g<1>)",
                    updated,
                    flags=re.IGNORECASE,
                )
            else:
                updated, count = re.subn(rgba_pattern, primary, updated, flags=re.IGNORECASE)
            changed += count

        if changed and updated != original:
            _write_text(file_path, updated, modified, repo_root)


def _patch_hardcoded_secondary_text(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    """
    Replace commonly hardcoded secondary text colors with manifest theme.secondary.
    Targets text-[#hex] classes and explicit color declarations.
    """
    categories = _as_dict(manifest.get("categories"))
    theme = _as_dict(categories.get("theme"))
    secondary = _safe_css_value(_string_or_default(theme.get("secondary"), "#1f2937"), "#1f2937")
    if not secondary:
        return

    secondary_rgb = _hex_to_rgb_tuple(secondary)

    frontend_root = repo_root / app_root
    if not frontend_root.exists():
        return

    old_secondary_hex_tokens = [
        "#797979",
        "#989899",
        "#c9c9c9",
        "#444",
        "#777",
    ]
    old_secondary_rgb_tokens = [
        (121, 121, 121),
        (152, 152, 153),
        (201, 201, 201),
        (68, 68, 68),
        (119, 119, 119),
    ]

    text_hex_alt = "|".join(re.escape(token) for token in old_secondary_hex_tokens)
    text_class_pattern = re.compile(rf"(text-)\\[\\s*(?:{text_hex_alt})\\s*\\]", flags=re.IGNORECASE)

    for file_path in frontend_root.rglob("*"):
        if _path_is_ignored(file_path):
            continue
        if not file_path.is_file():
            continue
        if file_path.suffix not in {".js", ".jsx", ".ts", ".tsx", ".css", ".scss"}:
            continue

        original = _read_text(file_path)
        if not original:
            continue

        updated = original
        changed = 0

        updated, count = text_class_pattern.subn(rf"\g<1>[{secondary}]", updated)
        changed += count

        for token in old_secondary_hex_tokens:
            updated, count = re.subn(
                rf"(color\\s*:\\s*)(['\"]?){re.escape(token)}(['\"]?)",
                rf"\g<1>\g<2>{secondary}\g<3>",
                updated,
                flags=re.IGNORECASE,
            )
            changed += count

        for r, g, b in old_secondary_rgb_tokens:
            rgb_pattern = rf"(color\\s*:\\s*)rgb\\(\\s*{r}\\s*,\\s*{g}\\s*,\\s*{b}\\s*\\)"
            updated, count = re.subn(rgb_pattern, rf"\g<1>{secondary}", updated, flags=re.IGNORECASE)
            changed += count

            rgba_pattern = rf"(color\\s*:\\s*)rgba\\(\\s*{r}\\s*,\\s*{g}\\s*,\\s*{b}\\s*,\\s*([0-9]*\\.?[0-9]+)\\s*\\)"
            if secondary_rgb:
                sr, sg, sb = secondary_rgb
                updated, count = re.subn(
                    rgba_pattern,
                    rf"\g<1>rgba({sr}, {sg}, {sb}, \g<2>)",
                    updated,
                    flags=re.IGNORECASE,
                )
            else:
                updated, count = re.subn(rgba_pattern, rf"\g<1>{secondary}", updated, flags=re.IGNORECASE)
            changed += count

        if changed and updated != original:
            _write_text(file_path, updated, modified, repo_root)


def _write_tenant_feature_file(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    features = _as_dict(categories.get("features"))

    def f(name: str, default: bool = True) -> str:
        value = features.get(name)
        if isinstance(value, bool):
            return "true" if value else "false"
        return "true" if default else "false"

    resolved_features: dict[str, bool] = {
        "communities": f("communities") == "true",
        "sessions": f("sessions") == "true",
        "landing_provide": f("landing_provide") == "true",
        "landing_experts": f("landing_experts") == "true",
        "landing_hangout": f("landing_hangout") == "true",
        "auth_hide_image": f("auth_hide_image", default=False) == "true",
        "forms": f("forms", default=False) == "true",
        "rewards": f("rewards", default=False) == "true",
        "blog": f("blog", default=False) == "true",
    }
    resolved_features.update(_feature_overrides_from_extensions(manifest))

    content = (
        "const tenantFeatures = {\n"
        f"  communities: {'true' if resolved_features['communities'] else 'false'},\n"
        f"  sessions: {'true' if resolved_features['sessions'] else 'false'},\n"
        f"  landing_provide: {'true' if resolved_features['landing_provide'] else 'false'},\n"
        f"  landing_experts: {'true' if resolved_features['landing_experts'] else 'false'},\n"
        f"  landing_hangout: {'true' if resolved_features['landing_hangout'] else 'false'},\n"
        f"  auth_hide_image: {'true' if resolved_features['auth_hide_image'] else 'false'},\n"
        f"  forms: {'true' if resolved_features['forms'] else 'false'},\n"
        f"  rewards: {'true' if resolved_features['rewards'] else 'false'},\n"
        f"  blog: {'true' if resolved_features['blog'] else 'false'},\n"
        "};\n\n"
        "export default tenantFeatures;\n"
    )

    path = repo_root / app_root / "utils" / "tenantFeatures.js"
    _write_text(path, content, modified, repo_root)


def _write_tenant_branding_file(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    branding = _as_dict(categories.get("branding"))
    domains = _as_dict(categories.get("domains"))

    company_name = _safe_js_string(_string_or_default(branding.get("company_name"), "Tenant"))
    contact_email = _safe_js_string(_string_or_default(branding.get("contact_email"), ""))
    title = _safe_js_string(_string_or_default(branding.get("title"), company_name))
    description = _safe_js_string(_string_or_default(branding.get("description"), ""))
    site_url = _safe_js_string(_string_or_default(domains.get("site_url"), ""))

    content = (
        "const tenantBranding = {\n"
        f"  companyName: \"{company_name}\",\n"
        f"  title: \"{title}\",\n"
        f"  supportEmail: \"{contact_email}\",\n"
        f"  description: \"{description}\",\n"
        f"  siteUrl: \"{site_url}\",\n"
        "};\n\n"
        "export default tenantBranding;\n"
    )

    path = repo_root / app_root / "utils" / "tenantBranding.js"
    _write_text(path, content, modified, repo_root)


def _patch_data_file(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    branding = _as_dict(categories.get("branding"))
    domains = _as_dict(categories.get("domains"))

    path = repo_root / app_root / "utils" / "data.js"
    if not path.exists():
        return

    original = _read_text(path)
    updated = original

    company_name = _string_or_default(branding.get("company_name"), "")
    title = _string_or_default(branding.get("title"), "")
    contact_email = _string_or_default(branding.get("contact_email"), "")
    contact_phone = _string_or_default(branding.get("contact_phone"), "")
    description = _string_or_default(branding.get("description"), "")
    site_url = _string_or_default(domains.get("site_url"), "")

    if company_name:
        updated = _set_object_property(updated, "companyName", company_name)
    if title:
        updated = _set_object_property(updated, "title", title)
    if contact_email:
        updated = _set_object_property(updated, "email", contact_email)
    if contact_phone:
        updated = _set_object_property(updated, "phone", contact_phone)
    if description:
        updated = _set_object_property(updated, "description", description)
    if site_url:
        updated = _set_object_property(updated, "url", site_url)

    # Apply text / visibility extensions stored under manifest.extensions.
    for entry in _iter_text_extensions(manifest):
        entry_app_targets = entry.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"])
        if app_root not in entry_app_targets:
            continue
        extension_scope = _canonical_data_scope(str(entry["scope"]))
        extension_key = entry["key"]
        extension_value = entry["value"]
        section = "visibility" if str(extension_key).startswith("show_") else "text"

        for candidate_key in _text_key_candidates(extension_scope, extension_key):
            next_content = _set_scoped_data_property(
                updated,
                section=section,
                scope=extension_scope,
                key=candidate_key,
                value=extension_value,
            )
            if next_content != updated:
                updated = next_content
                break

    if updated != original:
        _write_text(path, updated, modified, repo_root)


def _patch_domain_and_api_config(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    domains = _as_dict(categories.get("domains"))

    site_url = _string_or_default(domains.get("site_url"), "")
    api_base = _string_or_default(domains.get("api_base_url"), "")

    if site_url:
        domain_path = repo_root / app_root / "utils" / "domainConfig.js"
        _replace_regex(
            domain_path,
            r'(test\s*:\s*")(.*?)(")',
            rf"\g<1>{_safe_js_string(site_url)}\g<3>",
            modified,
            repo_root,
        )
        _replace_regex(
            domain_path,
            r'(development\s*:\s*")(.*?)(")',
            rf"\g<1>{_safe_js_string(site_url)}\g<3>",
            modified,
            repo_root,
        )
        _replace_regex(
            domain_path,
            r'(production\s*:\s*")(.*?)(")',
            rf"\g<1>{_safe_js_string(site_url)}\g<3>",
            modified,
            repo_root,
        )

    if api_base:
        api_setup = repo_root / app_root / "utils" / "apiSetup.js"
        escaped = _safe_js_string(api_base)
        _replace_regex(api_setup, r'(test\s*:\s*")(.*?)(")', rf"\g<1>{escaped}\g<3>", modified, repo_root)
        _replace_regex(api_setup, r'(development\s*:\s*")(.*?)(")', rf"\g<1>{escaped}\g<3>", modified, repo_root)
        _replace_regex(api_setup, r'(production\s*:\s*")(.*?)(")', rf"\g<1>{escaped}\g<3>", modified, repo_root)
        _replace_regex(api_setup, r'(baseURL\s*:\s*")(.*?)(")', rf"\g<1>{escaped}\g<3>", modified, repo_root)


def _patch_meta_and_titles(repo_root: Path, manifest: dict[str, Any], modified: list[str], app_root: str) -> None:
    categories = _as_dict(manifest.get("categories"))
    branding = _as_dict(categories.get("branding"))

    company_name = _string_or_default(branding.get("company_name"), "")
    title = _string_or_default(branding.get("title"), "")
    support_email = _string_or_default(branding.get("contact_email"), "")

    if company_name:
        _replace_regex(
            repo_root / app_root / "pages" / "_document.js",
            r'(property="og:site_name"\s+content=")(.*?)(")',
            rf"\g<1>{_safe_js_string(company_name)}\g<3>",
            modified,
            repo_root,
        )

    if title:
        _replace_regex(
            repo_root / app_root / "pages" / "index.js",
            r"(<title>)(.*?)(</title>)",
            rf"\g<1>{_safe_js_string(title)}\g<3>",
            modified,
            repo_root,
        )
        _replace_regex(
            repo_root / app_root / "pages" / "home" / "index.jsx",
            r"(<title>)(.*?)(</title>)",
            rf"\g<1>{_safe_js_string(title)} - Home\g<3>",
            modified,
            repo_root,
        )

    footer_path = repo_root / app_root / "components" / "footer" / "index.jsx"
    if footer_path.exists():
        footer = _read_text(footer_path)
        updated = footer
        if 'import companyData from "@/utils/data";' not in updated:
            updated = updated.replace(
                'import LinkedInIcon from "@mui/icons-material/LinkedIn";\n',
                'import LinkedInIcon from "@mui/icons-material/LinkedIn";\nimport companyData from "@/utils/data";\n',
            )
        marker = '<ul className="flex text-xs whitespace-nowrap m-0 p-0 pt-[15px] md:pt-[5px] border-t-[1px] border-black  gap-x-[15px] md:gap-x-[30px]">'
        if marker in updated and "Support:" not in updated:
            support_line = (
                '        <p className="text-[#777] text-sm mb-2">\n'
                f'          {company_name or ""} {"|" if company_name and support_email else ""} {("Support: " + support_email) if support_email else ""}\n'
                "        </p>\n"
            )
            updated = updated.replace(marker, support_line + marker)

        if updated != footer:
            _write_text(footer_path, updated, modified, repo_root)


def _patch_feature_toggles(repo_root: Path, modified: list[str], app_root: str) -> None:
    app_path = repo_root / app_root / "pages" / "_app.js"
    if app_path.exists():
        app = _read_text(app_path)
        updated = app

        if 'import { useRouter } from "next/router";' not in updated and "import { useRouter } from 'next/router';" not in updated:
            updated = updated.replace(
                "import { useEffect } from 'react';\n",
                "import { useEffect } from 'react';\nimport { useRouter } from 'next/router';\n",
            )
        if "import tenantFeatures from '@/utils/tenantFeatures';" not in updated:
            updated = updated.replace(
                "import '../styles/globals.css';\n",
                "import '../styles/globals.css';\nimport '../styles/tenant-theme.css';\nimport tenantFeatures from '@/utils/tenantFeatures';\n",
            )
        if "const router = useRouter();" not in updated:
            updated = updated.replace(
                "function MyApp({ Component, pageProps }) {\n",
                "function MyApp({ Component, pageProps }) {\n    const router = useRouter();\n",
            )

        guard_marker = "__tenant_feature_guard__"
        if guard_marker not in updated:
            updated = updated.replace(
                "    useEffect(() => { }, []);\n",
                "    useEffect(() => {\n"
                "        // __tenant_feature_guard__\n"
                "        const disabledRoutePrefixes = [\n"
                "            ...(tenantFeatures.sessions ? [] : ['/allSessions', '/mySchedule', '/session', '/catSessions', '/classDetails', '/playVideo']),\n"
                "            ...(tenantFeatures.communities ? [] : ['/myCommunities', '/communityDetails', '/communitySub', '/comHome', '/comThreads', '/commerce', '/catchup']),\n"
                "            ...(tenantFeatures.blog ? [] : ['/blog']),\n"
                "            ...(tenantFeatures.forms ? [] : ['/forms']),\n"
                "            ...(tenantFeatures.rewards ? [] : ['/rewards']),\n"
                "        ];\n"
                "        const currentPath = router.asPath || '/';\n"
                "        const blocked = disabledRoutePrefixes.some((prefix) => currentPath.startsWith(prefix));\n"
                "        if (blocked) {\n"
                "            router.replace('/');\n"
                "        }\n"
                "    }, [router.asPath]);\n",
            )

        if updated != app:
            _write_text(app_path, updated, modified, repo_root)

    landing_path = repo_root / app_root / "components" / "landing" / "index.jsx"
    if landing_path.exists():
        landing = _read_text(landing_path)
        updated = landing
        if 'import tenantFeatures from "@/utils/tenantFeatures";' not in updated:
            updated = updated.replace(
                "import {\n  selectAllCommunities,\n  setCommunities,\n} from \"@/store/features/communitySlice\";\n",
                "import {\n  selectAllCommunities,\n  setCommunities,\n} from \"@/store/features/communitySlice\";\nimport tenantFeatures from \"@/utils/tenantFeatures\";\n",
            )
        updated = updated.replace(
            "    dispatch(setSessions({ take: 1000, skip: 0 }));",
            "    if (tenantFeatures.sessions) dispatch(setSessions({ take: 1000, skip: 0 }));",
        )
        updated = updated.replace(
            "    dispatch(setCommunities({ take: 1000, skip: 0 }));",
            "    if (tenantFeatures.communities) dispatch(setCommunities({ take: 1000, skip: 0 }));",
        )
        updated = updated.replace(
            "      <CommunitySection community={community} />",
            "      {tenantFeatures.communities && <CommunitySection community={community} />}",
        )
        updated = updated.replace(
            "      <SessionSection\n        sessions={sessions?.filter(\n          (data) => !data.isCourse && !data.isVideoChannel\n        )}\n      />",
            "      {tenantFeatures.sessions && (\n      <SessionSection\n        sessions={sessions?.filter(\n          (data) => !data.isCourse && !data.isVideoChannel\n        )}\n      />\n      )}",
        )
        if updated != landing:
            _write_text(landing_path, updated, modified, repo_root)

    home_path = repo_root / app_root / "pages" / "home" / "index.jsx"
    if home_path.exists():
        home = _read_text(home_path)
        updated = home
        if 'import tenantFeatures from "@/utils/tenantFeatures";' not in updated:
            updated = updated.replace(
                "import CarouselComponent from \"@/components/slider/Carousel\";\n",
                "import CarouselComponent from \"@/components/slider/Carousel\";\nimport tenantFeatures from \"@/utils/tenantFeatures\";\n",
            )
        updated = updated.replace(
            "        {userSessions?.length >0 && <SessionCardList Sessions={userSessions}  />}",
            "        {tenantFeatures.sessions && userSessions?.length >0 && <SessionCardList Sessions={userSessions}  />}",
        )
        updated = updated.replace(
            "        {communities?.length>0 &&<CommunityCardList type=\"yours\" enroll={true} />}",
            "        {tenantFeatures.communities && communities?.length>0 &&<CommunityCardList type=\"yours\" enroll={true} />}",
        )
        updated = updated.replace(
            "        <SessionCardList Sessions={recommendedSessions} recommended />",
            "        {tenantFeatures.sessions && <SessionCardList Sessions={recommendedSessions} recommended />}",
        )
        updated = updated.replace(
            "        <CommunityCardList type=\"recommended\" enroll={false} />",
            "        {tenantFeatures.communities && <CommunityCardList type=\"recommended\" enroll={false} />}",
        )
        if updated != home:
            _write_text(home_path, updated, modified, repo_root)

    topbar_path = repo_root / app_root / "components" / "topbar" / "Topbar.jsx"
    if topbar_path.exists():
        topbar = _read_text(topbar_path)
        updated = topbar
        if 'import tenantFeatures from "@/utils/tenantFeatures";' not in updated:
            updated = updated.replace(
                "import api from \"@/utils/apiSetup\";\n",
                "import api from \"@/utils/apiSetup\";\nimport tenantFeatures from \"@/utils/tenantFeatures\";\n",
            )
        updated = updated.replace(
            "    currentUser?.id && getRewards()",
            "    tenantFeatures.rewards && currentUser?.id && getRewards()",
        )
        updated = updated.replace(
            "            {currentUser && (\n              <Link href={\"/mySchedule\"}>",
            "            {currentUser && tenantFeatures.sessions && (\n              <Link href={\"/mySchedule\"}>",
        )
        updated = updated.replace(
            "            {currentUser && (\n              <Link href={\"/myCommunities\"}>",
            "            {currentUser && tenantFeatures.communities && (\n              <Link href={\"/myCommunities\"}>",
        )
        if updated != topbar:
            _write_text(topbar_path, updated, modified, repo_root)


def _resolve_static_root_headline_override(manifest: dict[str, Any]) -> str | None:
    for entry in _iter_text_extensions(manifest):
        app_targets = entry.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"])
        if "frontend" not in app_targets:
            continue
        scope = _canonical_data_scope(str(entry.get("scope", "")))
        key = str(entry.get("key", "")).strip().lower()
        if scope not in {"landing", "home"}:
            continue
        if key not in {"hero_1", "hero_headline", "headline", "headline_line_1"}:
            continue
        value = entry.get("value")
        if isinstance(value, str):
            return value
        if isinstance(value, (bool, int, float)):
            return str(value)
        return ""
    return None


def _patch_static_root_headline(repo_root: Path, manifest: dict[str, Any], modified: list[str]) -> None:
    override = _resolve_static_root_headline_override(manifest)
    if override is None:
        return

    entry_candidates = [
        repo_root / "index.html",
        repo_root / "index.htm",
        repo_root / "index.html.html",
    ]

    for entry_path in entry_candidates:
        if not entry_path.exists() or not entry_path.is_file():
            continue
        original = _read_text(entry_path)
        if not original:
            continue
        updated, count = re.subn(
            r"(<h1\b[^>]*>)([\s\S]*?)(</h1>)",
            lambda match: f"{match.group(1)}{override}{match.group(3)}",
            original,
            count=1,
        )
        if count > 0 and updated != original:
            _write_text(entry_path, updated, modified, repo_root)
            break


def apply_deterministic_customizations(
    manifest: dict[str, Any],
    repo_path: str,
    app_targets: list[str] | None = None,
) -> list[str]:
    repo_root = Path(repo_path).resolve()
    _assert_tenant_repo(repo_root)

    modified: list[str] = []

    # Static repositories keep landing copy in root HTML instead of app-root folders.
    _patch_static_root_headline(repo_root, manifest, modified)

    for app_root in _normalize_app_targets(app_targets):
        if not (repo_root / app_root).exists():
            continue
        _write_tenant_theme_css(repo_root, manifest, modified, app_root)
        _write_tenant_feature_file(repo_root, manifest, modified, app_root)
        _write_tenant_branding_file(repo_root, manifest, modified, app_root)
        _patch_data_file(repo_root, manifest, modified, app_root)
        _patch_domain_and_api_config(repo_root, manifest, modified, app_root)
        _patch_meta_and_titles(repo_root, manifest, modified, app_root)
        _patch_hardcoded_tailwind_primary(repo_root, manifest, modified, app_root)
        _patch_hardcoded_secondary_text(repo_root, manifest, modified, app_root)
        _patch_feature_toggles(repo_root, modified, app_root)
        _patch_frontend_literal_replacements(repo_root, manifest, modified, app_root)

    _log(f"Deterministic customization complete. Files affected: {modified}")
    return modified

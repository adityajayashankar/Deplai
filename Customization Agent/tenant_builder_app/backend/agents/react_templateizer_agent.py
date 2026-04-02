from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

from services.agent_logger import log_agent


IGNORED_DIRECTORIES = {
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

REACT_EXTENSIONS = {".jsx", ".tsx", ".js", ".ts"}


@dataclass
class TemplatizeResult:
    file_path: str
    modified: bool
    keys_added: list[str]
    rewrites: int


def _log(message: str) -> None:
    log_agent("ReactTemplateizer", message)


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


def _marker_path(repo_path: Path, app_root: str) -> Path:
    marker_name = app_root.replace("/", "-")
    return repo_path / ".deplai" / f"react_templateizer_v1.{marker_name}.json"


def _discover_react_files(repo_path: Path, app_root: str) -> list[Path]:
    app_path = repo_path / app_root
    if not app_path.exists():
        return []

    files: list[Path] = []
    for file_path in sorted(app_path.rglob("*")):
        if any(part in IGNORED_DIRECTORIES for part in file_path.parts):
            continue
        if not file_path.is_file():
            continue
        if file_path.suffix not in REACT_EXTENSIONS:
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        # For .js/.ts, only keep files that appear to contain JSX.
        if file_path.suffix in {".js", ".ts"} and "<" not in content:
            continue
        files.append(file_path)
    return files


def _infer_scope(relative_path: str) -> str:
    normalized = relative_path.lower()
    scope_markers: list[tuple[str, str]] = [
        ("components/landing", "landing"),
        ("components/topbar", "topbar"),
        ("components/footer", "footer"),
        ("pages/onboard", "auth"),
        ("pages/home", "home"),
        ("pages/search", "search"),
        ("pages/contact", "contact"),
        ("pages/allsessions", "all_sessions"),
    ]
    for marker, scope in scope_markers:
        if marker in normalized:
            return scope
    return "home"


def _build_key(base_text: str, scope: str, used_keys: set[str]) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9\s]", " ", base_text).strip().lower()
    words = [word for word in normalized.split() if word]
    words = words[:4]
    if not words:
        stem = f"{scope}_text"
    else:
        stem = "_".join(words)
    if len(stem) > 36:
        stem = stem[:36].rstrip("_")
    key = stem
    suffix = 1
    while key in used_keys:
        suffix += 1
        key = f"{stem}_{suffix}"
    used_keys.add(key)
    return key


def _escape_js_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _relative_tenant_config_import(repo_path: Path, file_path: Path, app_root: str) -> str:
    app_root_path = repo_path / app_root
    target = app_root_path / "utils" / "tenantConfig"
    if not target.exists():
        return ""
    rel = Path(".") / target.relative_to(file_path.parent)
    rel_str = rel.as_posix()
    if not rel_str.startswith("."):
        rel_str = f"./{rel_str}"
    return rel_str


def _ensure_import(content: str, import_path: str) -> str:
    if "getTenantText" in content and "tenantConfig" in content:
        return content

    lines = content.splitlines()
    insert_at = 0
    for index, line in enumerate(lines):
        if line.strip().startswith("import "):
            insert_at = index + 1

    lines.insert(insert_at, f'import {{ getTenantText }} from "{import_path}";')
    return "\n".join(lines)


def _templatize_file(repo_path: Path, file_path: Path, app_root: str) -> TemplatizeResult:
    relative_path = file_path.relative_to(repo_path).as_posix()
    scope = _infer_scope(relative_path)
    content = file_path.read_text(encoding="utf-8")

    used_keys: set[str] = set()
    keys_added: list[str] = []

    # Matches plain text nodes between JSX tags.
    text_pattern = re.compile(r">([^<>{\n][^<>{}]*)<")

    rewrites = 0

    def replace_text(match: re.Match[str]) -> str:
        nonlocal rewrites
        raw_text = match.group(1)
        text = raw_text.strip()
        if len(text) < 3:
            return match.group(0)
        if "{" in text or "}" in text or "$" in text:
            return match.group(0)
        # Skip numbers-only or punctuation-heavy chunks.
        if not re.search(r"[A-Za-z]", text):
            return match.group(0)

        key = _build_key(text, scope, used_keys)
        keys_added.append(f"{scope}.{key}")
        rewrites += 1

        escaped = _escape_js_string(text)
        replacement = f">{{getTenantText(\"{scope}\", \"{key}\", \"{escaped}\")}}<"
        return replacement

    updated = text_pattern.sub(replace_text, content)

    if rewrites == 0:
        return TemplatizeResult(file_path=relative_path, modified=False, keys_added=[], rewrites=0)

    import_path = _relative_tenant_config_import(repo_path, file_path, app_root)
    if not import_path:
        return TemplatizeResult(file_path=relative_path, modified=False, keys_added=[], rewrites=0)
    updated = _ensure_import(updated, import_path)

    if updated != content:
        file_path.write_text(updated, encoding="utf-8")
        return TemplatizeResult(
            file_path=relative_path,
            modified=True,
            keys_added=keys_added,
            rewrites=rewrites,
        )

    return TemplatizeResult(file_path=relative_path, modified=False, keys_added=[], rewrites=0)


def run_react_templateizer(state: dict[str, Any]) -> dict[str, Any]:
    repo_path = Path(state["repo_path"]).resolve()
    run_flag = bool(state.get("run_templatizer", False))
    app_targets = _normalize_app_targets(state.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"]))
    errors = list(state.get("errors", []))
    modified_files = list(state.get("modified_files", []))

    if not run_flag:
        report = {
            "requested": False,
            "status": "skipped_by_user",
            "app_targets": app_targets,
            "files_scanned": 0,
            "files_modified": 0,
            "rewrites": 0,
            "keys_added": [],
            "per_app": {},
        }
        state["templateizer_report"] = report
        return state

    per_app: dict[str, Any] = {}
    all_files_scanned = 0
    all_files_modified: list[str] = []
    all_keys_added: list[str] = []
    all_rewrites = 0

    for app_root in app_targets:
        marker = _marker_path(repo_path, app_root)
        if marker.exists():
            per_app[app_root] = {
                "status": "skipped_by_marker",
                "marker_path": str(marker),
                "files_scanned": 0,
                "files_modified": 0,
                "rewrites": 0,
                "keys_added": [],
            }
            continue

        react_files = _discover_react_files(repo_path, app_root)
        app_results: list[TemplatizeResult] = []
        for file_path in react_files:
            try:
                result = _templatize_file(repo_path, file_path, app_root)
                app_results.append(result)
            except Exception as exc:  # keep pipeline resilient for mixed repos
                relative_path = file_path.relative_to(repo_path).as_posix()
                errors.append(f"Templateizer failed for {relative_path}: {exc}")

        app_files_modified = [result.file_path for result in app_results if result.modified]
        app_rewrites = sum(result.rewrites for result in app_results)
        app_keys_added: list[str] = []
        for result in app_results:
            app_keys_added.extend(result.keys_added)

        for path in app_files_modified:
            if path not in modified_files:
                modified_files.append(path)

        marker.parent.mkdir(parents=True, exist_ok=True)
        marker_payload = {
            "status": "executed",
            "app_root": app_root,
            "files_modified": app_files_modified,
            "rewrites": app_rewrites,
            "keys_added": app_keys_added,
        }
        marker.write_text(json.dumps(marker_payload, indent=2), encoding="utf-8")

        per_app[app_root] = {
            "status": "executed",
            "marker_path": str(marker),
            "files_scanned": len(react_files),
            "files_modified": len(app_files_modified),
            "rewrites": app_rewrites,
            "keys_added": app_keys_added,
        }

        all_files_scanned += len(react_files)
        all_files_modified.extend(app_files_modified)
        all_keys_added.extend(app_keys_added)
        all_rewrites += app_rewrites

    overall_status = "executed"
    if per_app and all(details.get("status") == "skipped_by_marker" for details in per_app.values()):
        overall_status = "skipped_by_marker"

    unique_files_modified = sorted(set(all_files_modified))
    unique_keys_added = sorted(set(all_keys_added))

    report = {
        "requested": True,
        "status": overall_status,
        "app_targets": app_targets,
        "files_scanned": all_files_scanned,
        "files_modified": len(unique_files_modified),
        "rewrites": all_rewrites,
        "keys_added": unique_keys_added,
        "per_app": per_app,
    }
    _log(
        f"Templateizer summary: scanned={report['files_scanned']} modified={report['files_modified']} rewrites={report['rewrites']}"
    )

    state["modified_files"] = modified_files
    state["errors"] = errors
    state["templateizer_report"] = report
    return state

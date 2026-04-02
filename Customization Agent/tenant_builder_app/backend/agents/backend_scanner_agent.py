from __future__ import annotations

import json
from pathlib import Path
from typing import Any, TypedDict

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient


class BackendRepoMap(TypedDict):
    config_targets: list[str]
    api_targets: list[str]
    service_targets: list[str]
    priority_targets: list[str]
    all_backend_files: list[str]


IGNORED_SCAN_DIRECTORIES = {
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


def _list_backend_files(repo_path: Path, backend_path: Path) -> list[str]:
    file_paths: list[str] = []
    for file_path in sorted(backend_path.rglob("*")):
        if any(part in IGNORED_SCAN_DIRECTORIES for part in file_path.parts):
            continue
        if not file_path.is_file():
            continue
        if file_path.suffix not in {".py", ".js", ".ts", ".json", ".yaml", ".yml", ".env"}:
            continue
        file_paths.append(file_path.relative_to(repo_path).as_posix())
    return file_paths


def _collect_candidate_summaries(repo_path: Path, all_backend_files: list[str], limit: int = 60) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    for relative_path in all_backend_files[:limit]:
        file_path = repo_path / relative_path
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        lines = [line.strip() for line in content.splitlines() if line.strip()][:16]
        excerpt = "\n".join(lines)[:800]
        candidates.append({"path": relative_path, "excerpt": excerpt})
    return candidates


def _manifest_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    categories = manifest.get("categories", {})
    integrations = categories.get("integrations", {}) if isinstance(categories, dict) else {}
    domains = categories.get("domains", {}) if isinstance(categories, dict) else {}
    return {
        "integrations": integrations if isinstance(integrations, dict) else {},
        "domains": domains if isinstance(domains, dict) else {},
        "extensions": manifest.get("extensions", []),
    }


def _normalize_paths(paths: object, allowed_paths: set[str]) -> list[str]:
    normalized: list[str] = []
    if not isinstance(paths, list):
        return normalized
    for path in paths:
        if isinstance(path, str) and path in allowed_paths and path not in normalized:
            normalized.append(path)
    return normalized


def _needs_backend_scan(manifest: dict[str, Any]) -> bool:
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


def scan_backend_repo(state: dict) -> dict:
    repo_path = Path(state["repo_path"])
    backend_path = repo_path / "backend"
    errors = list(state.get("errors", []))

    backend_repo_map: BackendRepoMap = {
        "config_targets": [],
        "api_targets": [],
        "service_targets": [],
        "priority_targets": [],
        "all_backend_files": [],
    }

    if not backend_path.exists():
        state["backend_repo_map"] = backend_repo_map
        return state

    all_backend_files = _list_backend_files(repo_path, backend_path)
    backend_repo_map["all_backend_files"] = all_backend_files
    backend_repo_map["priority_targets"] = [
        path
        for path in all_backend_files
        if path.endswith(("backend/index.js", "backend/main.py", "backend/app.py"))
    ]

    if not _needs_backend_scan(state.get("manifest", {})):
        log_agent("BackendScanner", "No backend customization intent detected; skipped LLM backend scan.")
        state["backend_repo_map"] = backend_repo_map
        state["errors"] = errors
        return state

    client = ProjectLLMClient()
    if not client.is_configured():
        log_agent("BackendScanner", "LLM not configured; returning backend inventory without target classification.")
        state["backend_repo_map"] = backend_repo_map
        state["errors"] = errors
        return state

    candidates = _collect_candidate_summaries(repo_path, all_backend_files)
    allowed_paths = {candidate["path"] for candidate in candidates}

    system_prompt = (
        "You analyze backend repository summaries and classify files relevant to tenant customization. "
        "Return strict JSON only. Only choose file paths from provided candidates."
    )
    user_prompt = (
        "Manifest summary:\n"
        f"{json.dumps(_manifest_summary(state.get('manifest', {})), indent=2)}\n\n"
        "Backend file inventory:\n"
        f"{json.dumps(all_backend_files, indent=2)}\n\n"
        "Candidate backend excerpts:\n"
        f"{json.dumps(candidates, indent=2)}\n\n"
        "Return:\n"
        "{\n"
        '  "config_targets": ["backend/..."],\n'
        '  "api_targets": ["backend/..."],\n'
        '  "service_targets": ["backend/..."],\n'
        '  "reasoning": ["short reasoning"]\n'
        "}\n"
    )

    try:
        result = client.complete_json(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=1200)
        reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
        for line in reasoning if isinstance(reasoning, list) else []:
            if isinstance(line, str) and line.strip():
                log_agent("BackendScanner", line.strip())
        backend_repo_map["config_targets"] = _normalize_paths(result.get("config_targets"), allowed_paths)
        backend_repo_map["api_targets"] = _normalize_paths(result.get("api_targets"), allowed_paths)
        backend_repo_map["service_targets"] = _normalize_paths(result.get("service_targets"), allowed_paths)
    except Exception as exc:
        errors.append(f"Backend scanner LLM failed: {exc}")
        log_agent("BackendScanner", f"LLM scan failed: {exc}")

    state["backend_repo_map"] = backend_repo_map
    state["errors"] = errors
    return state

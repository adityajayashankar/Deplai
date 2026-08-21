from __future__ import annotations

import json
import os
import re
from pathlib import Path

from planning_runtime import repo_root


class RepositorySourceResolutionError(FileNotFoundError):
    """Raised when the requested repository source directory cannot be resolved."""


_SAFE_SNAPSHOT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def resolve_snapshot_source_override(source_override: object, *, project_id: str) -> Path:
    raw = (
        source_override.model_dump()
        if hasattr(source_override, "model_dump")
        else dict(source_override)  # type: ignore[arg-type]
    )
    if raw.get("kind") != "customization_snapshot":
        raise RepositorySourceResolutionError("Unsupported repository source override.")

    snapshot_id = str(raw.get("snapshot_id") or "").strip()
    tenant_id = str(raw.get("tenant_id") or "").strip()
    source_project_id = str(raw.get("project_id") or "").strip()
    source_tree_hash = str(raw.get("source_tree_hash") or "").strip()
    if source_project_id != project_id:
        raise RepositorySourceResolutionError("Snapshot source project does not match the scan project.")
    if not _SAFE_SNAPSHOT_ID.fullmatch(snapshot_id) or not _SAFE_SNAPSHOT_ID.fullmatch(tenant_id):
        raise RepositorySourceResolutionError("Snapshot source identity is invalid.")
    if not source_tree_hash:
        raise RepositorySourceResolutionError("Snapshot source integrity metadata is missing.")

    source = Path(str(raw.get("source_root") or "")).resolve()
    allowed_roots = [
        root.resolve()
        for project_type in ("local", "github")
        for root in _candidate_roots(project_type)
        if root.exists()
    ]
    if not any(source == root or root in source.parents for root in allowed_roots):
        raise RepositorySourceResolutionError("Snapshot source is outside configured repository mounts.")

    if tuple(source.parts[-3:]) != (".deplai-snapshots", tenant_id, snapshot_id):
        raise RepositorySourceResolutionError("Snapshot source path does not match its identity.")
    if not source.is_dir():
        raise RepositorySourceResolutionError("Snapshot source directory is unavailable.")

    metadata_path = source / "snapshot.metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RepositorySourceResolutionError("Snapshot source metadata is unavailable.") from exc
    if (
        str(metadata.get("snapshot_id") or "") != snapshot_id
        or str(metadata.get("tenant_id") or "") != tenant_id
        or str(metadata.get("status") or "") != "immutable"
        or str(metadata.get("source_tree_hash") or "") != source_tree_hash
    ):
        raise RepositorySourceResolutionError("Snapshot source metadata failed validation.")
    return source


def _candidate_roots(project_type: str) -> list[Path]:
    env_var = "DEPLAI_LOCAL_PROJECTS_ROOT" if project_type == "local" else "DEPLAI_GITHUB_REPOS_ROOT"
    configured_root = str(os.environ.get(env_var) or "").strip()

    candidates: list[Path] = []
    if configured_root:
        candidates.append(Path(configured_root))

    root = repo_root()
    if project_type == "local":
        candidates.extend([root / "Connector" / "tmp" / "local-projects", Path("/local-projects")])
    else:
        candidates.extend([root / "Connector" / "tmp" / "repos", Path("/repos")])

    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def resolve_repository_source(
    *,
    project_id: str,
    project_type: str,
    user_id: str | None = None,
    repo_full_name: str | None = None,
) -> Path:
    project_type = str(project_type or "").strip().lower()
    candidate_paths: list[Path] = []

    if project_type == "local":
        if not user_id:
            raise RepositorySourceResolutionError("user_id is required to resolve a local project path")
        for base in _candidate_roots(project_type):
            candidate_paths.append(base / str(user_id).strip() / str(project_id).strip())
    elif project_type == "github":
        repo_name = str(repo_full_name or "").strip()
        if "/" not in repo_name:
            raise RepositorySourceResolutionError("repo_full_name is required to resolve a GitHub repository path")
        owner, repo = repo_name.split("/", 1)
        for base in _candidate_roots(project_type):
            candidate_paths.append(base / owner / repo)
    else:
        raise RepositorySourceResolutionError(f"Unsupported project_type: {project_type}")

    for path in candidate_paths:
        if path.exists() and path.is_dir():
            return path

    attempted = ", ".join(str(path) for path in candidate_paths) or "<none>"
    raise RepositorySourceResolutionError(f"Repository source directory not found. Attempted: {attempted}")

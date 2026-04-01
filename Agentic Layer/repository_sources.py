from __future__ import annotations

import os
from pathlib import Path

from planning_runtime import repo_root


class RepositorySourceResolutionError(FileNotFoundError):
    """Raised when the requested repository source directory cannot be resolved."""


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

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def runtime_root() -> Path:
    return repo_root() / "runtime"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def slugify(value: str, default: str = "workspace") -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-._").lower()
    return normalized[:80] or default


def analyzer_workspace_root(workspace: str) -> Path:
    return ensure_dir(runtime_root() / "repo-analyzer" / slugify(workspace))


def decision_workspace_root(workspace: str) -> Path:
    return ensure_dir(runtime_root() / "arch-decision" / slugify(workspace))


def analyzer_context_path(workspace: str) -> Path:
    return analyzer_workspace_root(workspace) / "context.json"


def analyzer_context_md_path(workspace: str) -> Path:
    return analyzer_workspace_root(workspace) / "context.md"


def decision_answers_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "answers.json"


def decision_review_payload_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "review_payload.json"


def decision_claude_usage_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "claude_usage.json"


def decision_profile_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "deployment_profile.json"


def decision_architecture_view_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "architecture_view.json"


def decision_approval_payload_path(workspace: str) -> Path:
    return decision_workspace_root(workspace) / "approval_payload.json"


def write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def runtime_paths_for_workspace(workspace: str) -> dict[str, str]:
    return {
        "context_json": str(analyzer_context_path(workspace)),
        "context_md": str(analyzer_context_md_path(workspace)),
        "review_payload_json": str(decision_review_payload_path(workspace)),
        "claude_usage_json": str(decision_claude_usage_path(workspace)),
        "answers_json": str(decision_answers_path(workspace)),
        "deployment_profile_json": str(decision_profile_path(workspace)),
        "architecture_view_json": str(decision_architecture_view_path(workspace)),
        "approval_payload_json": str(decision_approval_payload_path(workspace)),
    }

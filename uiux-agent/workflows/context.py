"""Parse trusted execution context embedded in workflow input messages."""

from __future__ import annotations

import re
from dataclasses import dataclass


_TRUSTED_MARKER = "--- trusted execution context ---"
_REPO_ROOT_RE = re.compile(r"^repo_root:\s*(.+)$", re.MULTILINE)
_PROJECT_ID_RE = re.compile(r"^project_id:\s*(.+)$", re.MULTILINE)


@dataclass(frozen=True)
class RunContext:
    """User instruction plus server-side repo context from the Connector proxy."""

    user_message: str
    repo_root: str
    project_id: str


def split_user_message(raw_input: str) -> tuple[str, str]:
    """Return ``(user_message, trusted_block)`` from a workflow input string."""
    text = (raw_input or "").strip()
    if _TRUSTED_MARKER not in text:
        return text, ""
    user_part, trusted_part = text.split(_TRUSTED_MARKER, 1)
    return user_part.strip(), trusted_part.strip()


def parse_run_context(raw_input: str, fallback_repo_root: str = "") -> RunContext:
    """Extract the user instruction and trusted repo metadata from input."""
    user_message, trusted_block = split_user_message(raw_input)
    repo_root = fallback_repo_root.strip()
    project_id = ""

    for block in (trusted_block, raw_input or ""):
        repo_match = _REPO_ROOT_RE.search(block)
        if repo_match:
            repo_root = repo_match.group(1).strip()
        project_match = _PROJECT_ID_RE.search(block)
        if project_match:
            project_id = project_match.group(1).strip()

    return RunContext(
        user_message=user_message,
        repo_root=repo_root,
        project_id=project_id,
    )

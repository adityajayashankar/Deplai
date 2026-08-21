"""Persistence helpers for infra advisor sessions."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from planning_runtime import ensure_dir, read_json_optional, runtime_root, slugify, write_json


def advisor_workspace_root(workspace: str) -> Path:
    return ensure_dir(runtime_root() / "infra-advisor" / slugify(workspace))


def advisor_state_path(workspace: str) -> Path:
    return advisor_workspace_root(workspace) / "state.json"


def advisor_transcript_path(workspace: str) -> Path:
    return advisor_workspace_root(workspace) / "transcript.json"


def advisor_decision_path(workspace: str) -> Path:
    return advisor_workspace_root(workspace) / "latest_decision.json"


def load_advisor_state(workspace: str) -> dict[str, Any]:
    return read_json_optional(advisor_state_path(workspace)) or {}


def persist_advisor_state(
    *,
    workspace: str,
    state: dict[str, Any],
) -> None:
    key = slugify(workspace)
    messages = list(state.get("messages") or [])
    decision = dict(state.get("decision") or {})
    write_json(
        advisor_transcript_path(key),
        {"messages": messages, "updated_at": datetime.now(timezone.utc).isoformat()},
    )
    if decision:
        write_json(advisor_decision_path(key), decision)
    payload = {
        "workspace": key,
        "turn_count": int(state.get("turn_count") or 0),
        "budget_cap_usd": state.get("budget_cap_usd"),
        "selected_tier": state.get("selected_tier") or "recommended",
        "requirements": dict(state.get("requirements") or {}),
        "ready": bool(state.get("ready")),
        "open_questions": list(state.get("open_questions") or []),
        "upgrade_suggestions": list(state.get("upgrade_suggestions") or []),
        "budget_gate": dict(state.get("budget_gate") or {}),
        "cost_estimate": dict(state.get("cost_estimate") or {}),
        "decision": decision,
        "repo_detection_summary": state.get("repo_detection_summary") or "",
        "source": state.get("source") or "infra_advisor",
    }
    write_json(advisor_state_path(key), payload)

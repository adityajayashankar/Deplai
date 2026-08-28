"""DAST audit events. Never log credentials or verification tokens."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from dast_agent import store
from dast_agent.codes import POLICY_VERSION


def emit(
    *,
    scan_id: str,
    action: str,
    decision: str,
    reason: str = "",
    project_id: str = "",
    actor: str = "",
    target: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event = {
        "action": action,
        "decision": decision,
        "reason": reason,
        "project_id": project_id,
        "actor": actor,
        "target": target,
        "scan_id": scan_id,
        "policy_version": POLICY_VERSION,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "correlation_id": scan_id,
    }
    if extra:
        event.update(extra)
    if scan_id:
        store.append_audit(scan_id, event)
    return event

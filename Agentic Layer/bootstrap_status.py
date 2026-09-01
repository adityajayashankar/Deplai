"""Read-only EC2 bootstrap status via SSM."""

from __future__ import annotations

import json
import time
from typing import Any

from deploy_exec.adapters.ssm import SSMExecutionAdapter
from deploy_exec.operations import render_operation

BOOTSTRAP_STATUS_PATH = "/var/log/deplai-bootstrap-status.json"
TERMINAL_SUCCESS_PHASES = frozenset({"COMPLETED", "READY", "HEALTH_CHECK_PASSED"})
TERMINAL_FAILURE_PHASES = frozenset({"FAILED", "HEALTH_CHECK_FAILED"})
_STATUS_FIELDS = frozenset({"phase", "status", "error_code", "exit_code", "timestamp"})


def _safe_status_payload(payload: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in _STATUS_FIELDS:
        value = payload.get(key)
        if value is None:
            continue
        if key == "exit_code":
            try:
                safe[key] = int(value)
            except (TypeError, ValueError):
                safe[key] = 1
            continue
        safe[key] = str(value)[:160]
    return safe


def _parse_status(stdout: str) -> dict[str, Any]:
    raw = str(stdout or "").strip()
    if not raw or raw == "{}":
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return _safe_status_payload(payload) if isinstance(payload, dict) else {}


def read_bootstrap_status_once(
    *,
    instance_id: str,
    credentials: dict[str, Any],
    status_path: str = BOOTSTRAP_STATUS_PATH,
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    adapter = SSMExecutionAdapter(credentials=credentials, region=str(credentials.get("aws_region") or ""))
    try:
        reachable = adapter.ping(instance_id)
    except Exception as exc:
        return {
            "ok": False,
            "reachable": False,
            "status": "unknown",
            "bootstrap_status": None,
            "message": "Unable to query bootstrap status through SSM.",
            "error_code": str(getattr(exc, "code", "SSM_STATUS_UNAVAILABLE"))[:80],
        }
    if not reachable:
        return {
            "ok": False,
            "reachable": False,
            "status": "unknown",
            "bootstrap_status": None,
            "message": "SSM agent is not online for the target instance.",
        }
    commands = render_operation(
        "read_bootstrap_status",
        {"status_path": status_path},
    )
    try:
        result = adapter.execute(
            instance_id,
            commands,
            timeout_seconds=timeout_seconds,
            metadata={"operation": "read_bootstrap_status"},
        )
    except Exception as exc:
        return {
            "ok": False,
            "reachable": True,
            "status": "unknown",
            "bootstrap_status": None,
            "message": "Unable to read bootstrap status through SSM.",
            "error_code": str(getattr(exc, "code", "SSM_STATUS_UNAVAILABLE"))[:80],
        }
    payload = _parse_status(result.stdout)
    phase = str(payload.get("phase") or "").strip()
    status = str(payload.get("status") or phase or "").strip().lower()
    failed = status == "failed" or phase.upper() in TERMINAL_FAILURE_PHASES
    succeeded = status in {"success", "succeeded", "completed"} or phase.upper() in TERMINAL_SUCCESS_PHASES
    return {
        "ok": succeeded and not failed,
        "reachable": True,
        "status": "failed" if failed else ("completed" if succeeded else "running"),
        "bootstrap_status": payload,
        "message": None if payload else "Bootstrap status file is not available or is not valid JSON yet.",
    }


def wait_for_bootstrap_status(
    *,
    instance_id: str,
    credentials: dict[str, Any],
    timeout_seconds: int = 900,
    interval_seconds: int = 15,
    status_path: str = BOOTSTRAP_STATUS_PATH,
) -> dict[str, Any]:
    deadline = time.time() + max(30, int(timeout_seconds))
    interval = max(5, int(interval_seconds))
    last: dict[str, Any] = {
        "ok": False,
        "reachable": False,
        "status": "timeout",
        "bootstrap_status": None,
        "message": "Timed out waiting for bootstrap status.",
    }
    while time.time() < deadline:
        last = read_bootstrap_status_once(
            instance_id=instance_id,
            credentials=credentials,
            status_path=status_path,
        )
        if last.get("status") == "failed":
            return last
        if last.get("ok"):
            return last
        if not last.get("reachable"):
            # EC2 may still be launching SSM — keep polling.
            pass
        time.sleep(interval)
    return {
        **last,
        "ok": False,
        "status": "timeout",
        "message": "Timed out waiting for bootstrap status.",
    }

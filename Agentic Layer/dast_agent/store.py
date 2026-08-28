"""JSON checkpoint, cancel flags, and DAST concurrency locks."""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STORE_ROOT = Path(__file__).resolve().parent.parent / ".deplai_runtime" / "dast"
_LOCK = threading.Lock()
_ACTIVE: dict[str, float] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def scan_dir(scan_id: str) -> Path:
    safe = "".join(ch for ch in str(scan_id) if ch.isalnum() or ch in {"-", "_"})
    path = STORE_ROOT / "scans" / (safe or "unknown")
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_checkpoint(scan_id: str, name: str, payload: dict[str, Any]) -> str:
    folder = scan_dir(scan_id)
    body = {
        "checkpoint": name,
        "recorded_at": _now(),
        "state": _redact(payload),
    }
    path = folder / f"{name}.json"
    path.write_text(json.dumps(body, indent=2), encoding="utf-8")
    latest = folder / "latest.json"
    latest.write_text(json.dumps(body, indent=2), encoding="utf-8")
    return str(path)


def read_latest(scan_id: str) -> dict[str, Any] | None:
    path = scan_dir(scan_id) / "latest.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def append_audit(scan_id: str, event: dict[str, Any]) -> None:
    path = scan_dir(scan_id) / "audit.jsonl"
    line = json.dumps({**_redact(event), "timestamp": event.get("timestamp") or _now()})
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def read_audit(scan_id: str) -> list[dict[str, Any]]:
    path = scan_dir(scan_id) / "audit.jsonl"
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def request_cancel(scan_id: str) -> None:
    (scan_dir(scan_id) / "cancel.flag").write_text(_now(), encoding="utf-8")


def is_cancelled(scan_id: str) -> bool:
    return (scan_dir(scan_id) / "cancel.flag").is_file()


def max_concurrent() -> int:
    try:
        return max(1, int(os.getenv("DAST_MAX_CONCURRENT", "3")))
    except ValueError:
        return 3


def acquire_slot(project_id: str) -> bool:
    key = str(project_id or "")
    now = time.time()
    with _LOCK:
        stale = [item for item, started in _ACTIVE.items() if now - started > 3600]
        for item in stale:
            _ACTIVE.pop(item, None)
        if key in _ACTIVE:
            return False
        if len(_ACTIVE) >= max_concurrent():
            return False
        _ACTIVE[key] = now
        return True


def release_slot(project_id: str) -> None:
    with _LOCK:
        _ACTIVE.pop(str(project_id or ""), None)


def _redact(payload: dict[str, Any]) -> dict[str, Any]:
    blocked = {
        "verification_token", "token", "aws_secret_access_key", "aws_session_token",
        "github_token", "password", "secret", "api_key",
    }
    cleaned: dict[str, Any] = {}
    for key, value in payload.items():
        if str(key).lower() in blocked:
            continue
        if isinstance(value, dict):
            cleaned[key] = _redact(value)
        else:
            cleaned[key] = value
    return cleaned

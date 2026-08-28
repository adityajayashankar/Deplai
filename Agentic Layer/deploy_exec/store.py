"""JSON checkpoints, cancel flags, and environment locks."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from deploy_exec.redact import redact

STORE_ROOT = Path(__file__).resolve().parent.parent / ".deplai_runtime" / "deploy_exec"
_LOCK = threading.Lock()
_ENV_LOCKS: dict[str, tuple[str, float]] = {}
LOCK_TTL_SECONDS = 180


def write_snapshot(deployment_id: str, payload: dict[str, Any]) -> str:
    path = deploy_dir(deployment_id) / "snapshot.json"
    path.write_text(json.dumps({"recorded_at": _now(), "snapshot": redact(payload)}, indent=2), encoding="utf-8")
    return str(path)


def read_snapshot(deployment_id: str) -> dict[str, Any] | None:
    path = deploy_dir(deployment_id) / "snapshot.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    snapshot = data.get("snapshot") if isinstance(data, dict) else None
    return snapshot if isinstance(snapshot, dict) else None


def write_pending_command(deployment_id: str, payload: dict[str, Any]) -> None:
    path = deploy_dir(deployment_id) / "pending_command.json"
    path.write_text(json.dumps({"recorded_at": _now(), **redact(payload)}, indent=2), encoding="utf-8")


def read_pending_command(deployment_id: str) -> dict[str, Any] | None:
    path = deploy_dir(deployment_id) / "pending_command.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def clear_pending_command(deployment_id: str) -> None:
    path = deploy_dir(deployment_id) / "pending_command.json"
    if path.is_file():
        path.unlink()


def list_inflight() -> list[str]:
    root = STORE_ROOT / "deployments"
    if not root.is_dir():
        return []
    terminal = {"FAILED", "CANCELLED", "COMPLETED", "ROLLED_BACK"}
    found: list[str] = []
    for folder in root.iterdir():
        latest = read_latest(folder.name)
        if not latest:
            continue
        body = latest.get("state") or latest
        status = str(body.get("status") or "")
        if status and status not in terminal:
            found.append(folder.name)
    return found


def _lock_path(environment_key: str) -> Path:
    safe = "".join(ch if ch.isalnum() else "_" for ch in str(environment_key or ""))
    folder = STORE_ROOT / "locks"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{safe or 'unknown'}.json"


def _read_lock_file(environment_key: str) -> dict[str, Any] | None:
    path = _lock_path(environment_key)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def acquire_env_lock(environment_key: str, deployment_id: str, ttl: int = LOCK_TTL_SECONDS) -> bool:
    key = str(environment_key or "").strip()
    if not key:
        return False
    now = time.time()
    with _LOCK:
        stale = [item for item, (_owner, started) in _ENV_LOCKS.items() if now - started > ttl]
        for item in stale:
            _ENV_LOCKS.pop(item, None)
        recorded = _read_lock_file(key)
        if recorded:
            expires = float(recorded.get("expires_at") or 0)
            owner = str(recorded.get("deployment_id") or "")
            if expires > now and owner and owner != str(deployment_id):
                _ENV_LOCKS[key] = (owner, now)
                return False
        current = _ENV_LOCKS.get(key)
        if current and current[0] != deployment_id:
            owner_file = _read_lock_file(key)
            if owner_file and float(owner_file.get("expires_at") or 0) > now and owner_file.get("deployment_id") != deployment_id:
                return False
        payload = {
            "environment_key": key,
            "deployment_id": str(deployment_id),
            "locked_at": _now(),
            "heartbeat_at": _now(),
            "expires_at": now + ttl,
        }
        _lock_path(key).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        _ENV_LOCKS[key] = (str(deployment_id), now)
        return True


def heartbeat_env_lock(environment_key: str, deployment_id: str, ttl: int = LOCK_TTL_SECONDS) -> bool:
    return acquire_env_lock(environment_key, deployment_id, ttl=ttl)


def release_env_lock(environment_key: str, deployment_id: str) -> None:
    key = str(environment_key or "").strip()
    with _LOCK:
        current = _ENV_LOCKS.get(key)
        if current and current[0] == str(deployment_id):
            _ENV_LOCKS.pop(key, None)
        recorded = _read_lock_file(key)
        if recorded and str(recorded.get("deployment_id") or "") == str(deployment_id):
            path = _lock_path(key)
            if path.is_file():
                path.unlink()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def deploy_dir(deployment_id: str) -> Path:
    safe = "".join(ch for ch in str(deployment_id) if ch.isalnum() or ch in {"-", "_"})
    path = STORE_ROOT / "deployments" / (safe or "unknown")
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_checkpoint(deployment_id: str, name: str, payload: dict[str, Any]) -> str:
    folder = deploy_dir(deployment_id)
    body = {
        "checkpoint": name,
        "recorded_at": _now(),
        "state": redact(payload),
    }
    path = folder / f"{name}.json"
    path.write_text(json.dumps(body, indent=2), encoding="utf-8")
    (folder / "latest.json").write_text(json.dumps(body, indent=2), encoding="utf-8")
    return str(path)


def read_latest(deployment_id: str) -> dict[str, Any] | None:
    path = deploy_dir(deployment_id) / "latest.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def append_event(deployment_id: str, event: dict[str, Any]) -> None:
    path = deploy_dir(deployment_id) / "events.jsonl"
    line = json.dumps({**redact(event), "timestamp": event.get("timestamp") or _now()})
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def read_events(deployment_id: str) -> list[dict[str, Any]]:
    path = deploy_dir(deployment_id) / "events.jsonl"
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


def append_log(deployment_id: str, text: str) -> None:
    path = deploy_dir(deployment_id) / "logs.jsonl"
    from deploy_exec.redact import redact_text

    line = json.dumps({"timestamp": _now(), "text": redact_text(text)})
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def read_logs(deployment_id: str) -> list[dict[str, Any]]:
    path = deploy_dir(deployment_id) / "logs.jsonl"
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


def request_cancel(deployment_id: str) -> None:
    (deploy_dir(deployment_id) / "cancel.flag").write_text(_now(), encoding="utf-8")


def is_cancelled(deployment_id: str) -> bool:
    return (deploy_dir(deployment_id) / "cancel.flag").is_file()


def lock_owner(environment_key: str) -> str | None:
    key = str(environment_key or "").strip()
    now = time.time()
    with _LOCK:
        current = _ENV_LOCKS.get(key)
        if current:
            return current[0]
    recorded = _read_lock_file(key)
    if recorded and float(recorded.get("expires_at") or 0) > now:
        owner = str(recorded.get("deployment_id") or "").strip()
        return owner or None
    return None

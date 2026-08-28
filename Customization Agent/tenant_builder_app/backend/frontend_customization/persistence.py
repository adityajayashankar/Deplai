"""Durable run persistence. Graph state stays compact; artifacts live on disk."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def runtime_root(backend_dir: Path) -> Path:
    root = backend_dir / "runtime" / "frontend_customization"
    root.mkdir(parents=True, exist_ok=True)
    return root


def run_dir(backend_dir: Path, run_id: str) -> Path:
    path = runtime_root(backend_dir) / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_run(backend_dir: Path, state: dict[str, Any]) -> None:
    run_id = str(state.get("run_id") or "").strip()
    if not run_id:
        raise ValueError("run_id is required to persist state.")
    payload = dict(state)
    if isinstance(payload.get("llm_config"), dict):
        redacted = dict(payload["llm_config"])
        redacted.pop("api_key", None)
        redacted.pop("apiKey", None)
        payload["llm_config"] = redacted
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    target = run_dir(backend_dir, run_id) / "run.json"
    tmp = target.with_suffix(".tmp")
    with _LOCK:
        tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        tmp.replace(target)


def load_run(backend_dir: Path, run_id: str) -> dict[str, Any]:
    target = run_dir(backend_dir, run_id) / "run.json"
    if not target.exists():
        raise FileNotFoundError(f"Customization run {run_id} was not found.")
    return json.loads(target.read_text(encoding="utf-8"))


def write_artifact(backend_dir: Path, run_id: str, name: str, payload: Any) -> str:
    folder = run_dir(backend_dir, run_id) / "artifacts"
    folder.mkdir(parents=True, exist_ok=True)
    artifact_id = f"{name}.json"
    path = folder / artifact_id
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return artifact_id


def read_artifact(backend_dir: Path, run_id: str, artifact_id: str) -> Any:
    path = run_dir(backend_dir, run_id) / "artifacts" / artifact_id
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def append_event(state: dict[str, Any], stage: str, summary: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    events = list(state.get("events") or [])
    events.append(
        {
            "stage": stage,
            "summary": summary,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            **(extra or {}),
        }
    )
    state["events"] = events[-80:]
    state["current_stage"] = stage
    return state

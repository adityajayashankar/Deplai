from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STORE_ROOT = Path(__file__).resolve().parent / ".deplai_runtime" / "terraform_runs"


def _safe_slug(value: str, fallback: str = "default") -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value or "").strip())
    slug = re.sub(r"-{2,}", "-", slug).strip("-._")
    return slug[:80] or fallback


def save_terraform_run(
    *,
    workspace: str,
    files: list[dict[str, Any]],
    metadata: dict[str, Any] | None = None,
) -> str:
    run_id = f"tf_{uuid.uuid4().hex}"
    safe_workspace = _safe_slug(workspace)
    run_dir = STORE_ROOT / safe_workspace / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    payload = {
        "run_id": run_id,
        "workspace": safe_workspace,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "metadata": metadata or {},
    }
    (run_dir / "run.json").write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return run_id


def load_terraform_run(*, workspace: str, run_id: str) -> dict[str, Any] | None:
    safe_workspace = _safe_slug(workspace)
    safe_run_id = _safe_slug(run_id)
    if safe_run_id != str(run_id or "").strip():
        return None
    path = STORE_ROOT / safe_workspace / safe_run_id / "run.json"
    if not path.exists() or not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else None

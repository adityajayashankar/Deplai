from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


AWS_PROVIDER_SOURCE = "registry.terraform.io/hashicorp/aws"
DEFAULT_PROVIDER_CONSTRAINT = "~> 5.40"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def runtime_root() -> Path:
    return repo_root() / "runtime" / "terraform-agent"


def knowledge_root() -> Path:
    return runtime_root() / "knowledge" / "aws"


def runs_root() -> Path:
    return runtime_root() / "runs"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def slugify(value: str, default: str = "workspace") -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-._").lower()
    return normalized[:80] or default


def new_run_id() -> str:
    return f"tfrun-{uuid.uuid4().hex[:12]}"


def workspace_root(workspace: str) -> Path:
    return ensure_dir(runs_root() / slugify(workspace))


def run_dir(workspace: str, run_id: str) -> Path:
    return ensure_dir(workspace_root(workspace) / run_id)


def artifacts_dir(workspace: str, run_id: str) -> Path:
    return ensure_dir(run_dir(workspace, run_id) / "artifacts")


def bundle_dir(workspace: str, run_id: str) -> Path:
    return ensure_dir(run_dir(workspace, run_id) / "bundle")


def state_path(workspace: str, run_id: str) -> Path:
    return run_dir(workspace, run_id) / "state.json"


def save_state(workspace: str, run_id: str, payload: dict[str, Any]) -> None:
    path = state_path(workspace, run_id)
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def load_state(workspace: str, run_id: str) -> dict[str, Any]:
    path = state_path(workspace, run_id)
    if not path.exists():
        raise FileNotFoundError(f"Terraform run state not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def write_text_files(root: Path, files: dict[str, str]) -> list[dict[str, str]]:
    root = ensure_dir(root)
    written: list[dict[str, str]] = []
    for rel_path, content in files.items():
        safe_rel = rel_path.replace("\\", "/").lstrip("/")
        full_path = root / safe_rel
        ensure_dir(full_path.parent)
        full_path.write_text(content, encoding="utf-8")
        written.append({"path": safe_rel, "content": content})
    return written


def replace_tree(target: Path, files: dict[str, str]) -> list[dict[str, str]]:
    if target.exists():
        shutil.rmtree(target)
    ensure_dir(target)
    return write_text_files(target, files)


def extract_provider_version(lock_text: str, provider_source: str = AWS_PROVIDER_SOURCE) -> str:
    pattern = rf'provider "{re.escape(provider_source)}"\s*\{{(?P<body>.*?)\n\}}'
    match = re.search(pattern, lock_text, flags=re.DOTALL)
    if not match:
        raise ValueError(f"Provider {provider_source} not found in lock file")
    body = match.group("body")
    version_match = re.search(r'version\s*=\s*"([^"]+)"', body)
    if not version_match:
        raise ValueError(f"Version for provider {provider_source} not found in lock file")
    return str(version_match.group(1)).strip()

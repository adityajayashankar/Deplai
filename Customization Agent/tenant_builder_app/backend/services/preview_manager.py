from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import time
from typing import Any
from urllib import request

from services.repo_service import get_tenant_repo_path


APP_ROOTS = ("frontend", "admin-frontend", "expert", "corporates")
BASE_PORT = int(os.getenv("CUSTOMIZATION_PREVIEW_BASE_PORT", "3200") or "3200")
HOST = os.getenv("CUSTOMIZATION_PREVIEW_HOST", "127.0.0.1")
START_TIMEOUT_SECONDS = int(os.getenv("CUSTOMIZATION_PREVIEW_START_TIMEOUT", "25") or "25")

_PREVIEW_PROCESSES: dict[str, dict[str, Any]] = {}


def _static_preview(kind: str = "static_file", status: str = "unavailable", detail: str = "") -> dict[str, Any]:
    return {
        "kind": kind,
        "status": status,
        "detail": detail,
    }


def _is_port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((HOST, port)) == 0


def _find_free_port() -> int:
    for port in range(BASE_PORT, BASE_PORT + 200):
        if not _is_port_open(port):
            return port
    raise RuntimeError("No free preview port available.")


def _read_package_json(root: Path) -> dict[str, Any]:
    try:
        return json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _find_app_root(repo_path: Path, app_targets: list[str] | None = None) -> Path | None:
    targets = app_targets or list(APP_ROOTS)
    for app_root in targets:
        candidate = repo_path / app_root
        if (candidate / "package.json").exists():
            return candidate
    if (repo_path / "package.json").exists():
        return repo_path
    return None


def _dev_command(root: Path, port: int) -> list[str]:
    package_json = _read_package_json(root)
    scripts = package_json.get("scripts") if isinstance(package_json, dict) else {}
    dev_script = scripts.get("dev", "") if isinstance(scripts, dict) else ""
    lowered = str(dev_script).lower()
    if "next dev" in lowered:
        return ["npm", "run", "dev", "--", "-p", str(port), "-H", HOST]
    if "vite" in lowered:
        return ["npm", "run", "dev", "--", "--host", HOST, "--port", str(port)]
    return ["npm", "run", "dev"]


def _healthcheck(url: str, timeout_seconds: int = START_TIMEOUT_SECONDS) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except Exception:
            time.sleep(0.75)
    return False


def _process_running(entry: dict[str, Any]) -> bool:
    process = entry.get("process")
    return isinstance(process, subprocess.Popen) and process.poll() is None


def _entry_payload(entry: dict[str, Any], status: str = "ready", detail: str = "") -> dict[str, Any]:
    return {
        "kind": "live_server",
        "status": status,
        "url": entry.get("url"),
        "detail": detail,
        "pid": entry.get("process").pid if _process_running(entry) else None,
        "app_root": entry.get("app_root"),
        "port": entry.get("port"),
    }


def start_preview(
    *,
    tenant_id: str,
    base_repo_path: str,
    app_targets: list[str] | None = None,
) -> dict[str, Any]:
    tenant_repo = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)).resolve()
    if not tenant_repo.exists() or not tenant_repo.is_dir():
        return _static_preview(detail=f"Tenant repo does not exist: {tenant_repo}")

    existing = _PREVIEW_PROCESSES.get(str(tenant_repo))
    if existing and _process_running(existing):
        return _entry_payload(existing)

    app_root = _find_app_root(tenant_repo, app_targets)
    if app_root is None:
        return _static_preview(status="unavailable", detail="No package.json found; use static preview fallback.")

    package_json = _read_package_json(app_root)
    scripts = package_json.get("scripts") if isinstance(package_json, dict) else {}
    if not isinstance(scripts, dict) or not isinstance(scripts.get("dev"), str):
        return _static_preview(status="unavailable", detail=f"No dev script found in {app_root / 'package.json'}.")

    port = _find_free_port()
    url = f"http://{HOST}:{port}"
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["HOST"] = HOST

    log_path = tenant_repo / ".deplai-preview.log"
    log_handle = log_path.open("a", encoding="utf-8")
    process = subprocess.Popen(
        _dev_command(app_root, port),
        cwd=str(app_root),
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    entry = {
        "process": process,
        "url": url,
        "app_root": str(app_root),
        "port": port,
        "log_path": str(log_path),
    }
    _PREVIEW_PROCESSES[str(tenant_repo)] = entry

    if _healthcheck(url):
        return _entry_payload(entry)

    if process.poll() is not None:
        return _entry_payload(entry, status="failed", detail=f"Preview process exited early. See {log_path}.")
    return _entry_payload(entry, status="failed", detail=f"Preview did not become ready within {START_TIMEOUT_SECONDS}s. See {log_path}.")


def preview_status(
    *,
    tenant_id: str,
    base_repo_path: str,
    app_targets: list[str] | None = None,
) -> dict[str, Any]:
    tenant_repo = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)).resolve()
    entry = _PREVIEW_PROCESSES.get(str(tenant_repo))
    if entry and _process_running(entry):
        url = str(entry.get("url"))
        if _healthcheck(url, timeout_seconds=2):
            return _entry_payload(entry)
        return _entry_payload(entry, status="failed", detail="Preview process is running but healthcheck failed.")

    app_root = _find_app_root(tenant_repo, app_targets) if tenant_repo.exists() else None
    if app_root is None:
        return _static_preview(status="unavailable", detail="No live preview server is running; static preview fallback may be available.")
    return _static_preview(status="unavailable", detail="Live preview server is not running.")


def stop_preview(*, tenant_id: str, base_repo_path: str) -> dict[str, Any]:
    tenant_repo = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)).resolve()
    entry = _PREVIEW_PROCESSES.pop(str(tenant_repo), None)
    if not entry or not _process_running(entry):
        return {"kind": "live_server", "status": "unavailable", "detail": "No live preview process was running."}

    process = entry["process"]
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
    return {"kind": "live_server", "status": "stopped", "url": entry.get("url")}

from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time
from typing import Any
import uuid
from urllib.error import HTTPError
from urllib import request

from services.repo_service import get_tenant_repo_path


APP_ROOTS = ("frontend", "admin-frontend", "expert", "corporates")
BASE_PORT = int(os.getenv("CUSTOMIZATION_PREVIEW_BASE_PORT", "3200") or "3200")
# Preview servers are loopback-only. The Connector remains the authenticated
# gateway and no preview process may bind to an externally reachable host.
HOST = "127.0.0.1"
# Framework dev servers (Next.js especially) compile on first request, so the
# default startup budget is generous. Plain static sites become ready instantly.
START_TIMEOUT_SECONDS = int(os.getenv("CUSTOMIZATION_PREVIEW_START_TIMEOUT", "150") or "150")
# Automatically install node_modules when missing so framework previews work
# without a manual `npm install` step.
AUTO_INSTALL = os.getenv("CUSTOMIZATION_PREVIEW_AUTO_INSTALL", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
INSTALL_TIMEOUT_SECONDS = int(os.getenv("CUSTOMIZATION_PREVIEW_INSTALL_TIMEOUT", "600") or "600")
PREVIEW_LOG_TAIL_CHARS = 12000
PREVIEW_LOG_MAX_BYTES = 2 * 1024 * 1024

_PREVIEW_PROCESSES: dict[str, dict[str, Any]] = {}
_PREVIEW_LOCK = threading.Lock()


def _static_preview(status: str = "ready", detail: str = "") -> dict[str, Any]:
    return {
        "kind": "static_file",
        "status": status,
        "url": None,
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


def _read_next_major(root: Path) -> int | None:
    package_json = _read_package_json(root)
    dependencies = package_json.get("dependencies") if isinstance(package_json, dict) else {}
    dev_dependencies = package_json.get("devDependencies") if isinstance(package_json, dict) else {}
    raw_version = ""
    if isinstance(dependencies, dict):
        raw_version = str(dependencies.get("next") or "")
    if not raw_version and isinstance(dev_dependencies, dict):
        raw_version = str(dev_dependencies.get("next") or "")
    match = re.search(r"(\d+)", raw_version)
    return int(match.group(1)) if match else None


def _patch_legacy_next_config(root: Path, log_handle) -> None:
    """Patch tenant copies of old Next apps for modern Node ESM resolution."""
    next_major = _read_next_major(root)
    if next_major is None or next_major > 12:
        return

    config_path = root / "next.config.js"
    if not config_path.exists() or not config_path.is_file():
        return

    try:
        config_text = config_path.read_text(encoding="utf-8")
    except OSError:
        return

    if "esmExternals" in config_text:
        return

    patched_text = ""
    if re.search(r"experimental\s*:\s*\{", config_text):
        patched_text = re.sub(
            r"(experimental\s*:\s*\{)",
            "\\1\n    esmExternals: false,",
            config_text,
            count=1,
        )
    else:
        object_match = re.search(r"const\s+nextConfig\s*=\s*\{", config_text)
        if object_match:
            insert_at = object_match.end()
            patched_text = (
                f"{config_text[:insert_at]}\n"
                "  experimental: { esmExternals: false },"
                f"{config_text[insert_at:]}"
            )

    if not patched_text or patched_text == config_text:
        return

    try:
        config_path.write_text(patched_text, encoding="utf-8")
        next_cache = root / ".next"
        if next_cache.exists():
            shutil.rmtree(next_cache, ignore_errors=True)
        log_handle.write(
            "\n[deplai-preview] Patched legacy Next.js config with experimental.esmExternals=false "
            "and cleared .next cache.\n"
        )
        log_handle.flush()
    except OSError as exc:
        log_handle.write(f"\n[deplai-preview] Could not patch legacy Next.js config: {exc}\n")
        log_handle.flush()


def _npm_executable() -> str:
    return shutil.which("npm") or shutil.which("npm.cmd") or "npm"


def _dependency_install_hint(root: Path) -> str:
    if (root / "node_modules").exists():
        return ""
    if (root / "package-lock.json").exists():
        return f"Dependencies are not installed in {root}. Run npm install in that app root, then start preview again."
    if (root / "pnpm-lock.yaml").exists():
        return f"Dependencies are not installed in {root}. Run pnpm install in that app root, then start preview again."
    if (root / "yarn.lock").exists():
        return f"Dependencies are not installed in {root}. Run yarn install in that app root, then start preview again."
    return f"Dependencies are not installed in {root}. Install the package dependencies, then start preview again."


def _install_command(root: Path) -> list[str]:
    """Pick the install command for the lockfile present in the app root."""
    if (root / "pnpm-lock.yaml").exists():
        pnpm = shutil.which("pnpm") or shutil.which("pnpm.cmd")
        if pnpm:
            return [pnpm, "install", "--prefer-offline"]
    if (root / "yarn.lock").exists():
        yarn = shutil.which("yarn") or shutil.which("yarn.cmd")
        if yarn:
            return [yarn, "install"]
    # npm handles both a clean install and lockfile drift gracefully.
    return [_npm_executable(), "install", "--no-audit", "--no-fund"]


def _ensure_dependencies(root: Path, log_handle) -> tuple[bool, str]:
    """Install node_modules when missing so the dev server can boot.

    Returns (ok, detail). On success detail is empty. When auto-install is
    disabled, returns the manual install hint so the caller can surface it.
    """
    if (root / "node_modules").exists():
        return (True, "")
    if not AUTO_INSTALL:
        return (False, _dependency_install_hint(root))

    command = _install_command(root)
    log_handle.write(
        f"\n[deplai-preview] Installing dependencies in {root}: {' '.join(command)}\n"
    )
    log_handle.flush()
    try:
        completed = subprocess.run(
            command,
            cwd=str(root),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=INSTALL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return (False, f"Dependency install timed out after {INSTALL_TIMEOUT_SECONDS}s in {root}.")
    except OSError as exc:
        return (False, f"Failed to launch dependency install in {root}: {exc}")

    if completed.returncode != 0:
        return (
            False,
            f"Dependency install failed (exit {completed.returncode}) in {root}. See preview log.",
        )
    if not (root / "node_modules").exists():
        return (False, f"Dependency install completed but node_modules is missing in {root}.")
    return (True, "")


def _find_app_root(repo_path: Path, app_targets: list[str] | None = None) -> Path | None:
    targets = app_targets or list(APP_ROOTS)
    for app_root in targets:
        candidate = repo_path / app_root
        if _has_runnable_dev_script(candidate):
            return candidate
    if _has_runnable_dev_script(repo_path):
        return repo_path
    return None


def _has_runnable_dev_script(root: Path) -> bool:
    package_json = _read_package_json(root)
    scripts = package_json.get("scripts") if isinstance(package_json, dict) else {}
    dev_script = scripts.get("dev") if isinstance(scripts, dict) else None
    return isinstance(dev_script, str) and bool(dev_script.strip())


def _dev_command(root: Path, port: int) -> list[str]:
    package_json = _read_package_json(root)
    scripts = package_json.get("scripts") if isinstance(package_json, dict) else {}
    dev_script = scripts.get("dev", "") if isinstance(scripts, dict) else ""
    lowered = str(dev_script).lower()
    if "next dev" in lowered:
        return [_npm_executable(), "run", "dev", "--", "-p", str(port), "-H", HOST]
    if "vite" in lowered:
        return [_npm_executable(), "run", "dev", "--", "--host", HOST, "--port", str(port)]
    # PORT and HOST are also provided for custom scripts without CLI flags.
    return [_npm_executable(), "run", "dev"]


def _healthcheck(
    url: str,
    timeout_seconds: int = START_TIMEOUT_SECONDS,
    should_continue: Any | None = None,
) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if should_continue is not None and not should_continue():
            return False
        try:
            with request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except HTTPError as exc:
            if exc.code >= 500:
                return True
        except Exception:
            pass
        time.sleep(0.75)
    return False


def _tail_preview_log_summary(log_path: Path | str | None) -> str:
    if not log_path:
        return ""
    path = Path(str(log_path))
    if not path.exists() or not path.is_file():
        return ""
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - PREVIEW_LOG_TAIL_CHARS), os.SEEK_SET)
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""

    marker = "[deplai-preview]"
    marker_index = text.rfind(marker)
    if marker_index >= 0:
        text = text[marker_index:]

    patterns = (
        "ERR_UNSUPPORTED_DIR_IMPORT",
        "Module not found",
        "SyntaxError",
        "TypeError",
        "ReferenceError",
        "Error:",
        "error -",
    )
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index]
        if any(pattern in line for pattern in patterns):
            return " ".join(lines[index:index + 3])[:900]
    return ""


def _terminate_process(entry: dict[str, Any]) -> None:
    if not _process_running(entry):
        return
    process = entry["process"]
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass


def _process_running(entry: dict[str, Any]) -> bool:
    process = entry.get("process")
    return isinstance(process, subprocess.Popen) and process.poll() is None


def _thread_alive(entry: dict[str, Any]) -> bool:
    thread = entry.get("thread")
    return isinstance(thread, threading.Thread) and thread.is_alive()


def _entry_is_current(tenant_key: str, token: str) -> bool:
    with _PREVIEW_LOCK:
        entry = _PREVIEW_PROCESSES.get(tenant_key)
        return bool(
            entry
            and entry.get("token") == token
            and entry.get("status") != "stopped"
        )


def _update_entry(tenant_key: str, token: str | None = None, **fields: Any) -> bool:
    with _PREVIEW_LOCK:
        entry = _PREVIEW_PROCESSES.get(tenant_key)
        if entry is None or (token is not None and entry.get("token") != token):
            return False
        if entry.get("status") == "stopped" and fields.get("status") != "stopped":
            return False
        entry.update(fields)
        return True


def _entry_payload(entry: dict[str, Any], status: str | None = None, detail: str | None = None) -> dict[str, Any]:
    resolved_status = status or str(entry.get("status") or "ready")
    resolved_detail = detail if detail is not None else str(entry.get("detail") or "")
    return {
        "kind": str(entry.get("kind") or "live_server"),
        "status": resolved_status,
        "detail": resolved_detail,
        "pid": entry.get("process").pid if _process_running(entry) else None,
        "app_root": entry.get("app_root"),
    }


def _prepare_log(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if log_path.exists() and log_path.stat().st_size > PREVIEW_LOG_MAX_BYTES:
            previous = log_path.with_suffix(".log.previous")
            previous.unlink(missing_ok=True)
            log_path.replace(previous)
    except OSError:
        pass


def _boot_preview_worker(
    tenant_key: str,
    token: str,
    log_path: Path,
    app_root: Path,
    port: int,
    url: str,
) -> None:
    """Install dependencies and launch the dev server in the background.

    Runs off the request thread so callers (the implement endpoint) return
    immediately while a framework app installs and compiles. Progress is exposed
    through the entry's ``status`` field, polled by ``preview_status``.
    """
    _prepare_log(log_path)
    try:
        log_handle = log_path.open("a", encoding="utf-8")
    except OSError as exc:
        _update_entry(tenant_key, token, status="failed", detail=f"Could not open preview log: {exc}")
        return

    try:
        _update_entry(tenant_key, token, status="starting", detail="Checking preview dependencies...")
        deps_ok, deps_detail = _ensure_dependencies(app_root, log_handle)
        if not _entry_is_current(tenant_key, token):
            return
        if not deps_ok:
            _update_entry(
                tenant_key,
                token,
                kind="static_file",
                status="ready",
                url=None,
                process=None,
                detail=f"{deps_detail} Serving the static preview fallback.",
            )
            return
        _update_entry(tenant_key, token, status="starting", detail="Preparing framework compatibility...")
        _patch_legacy_next_config(app_root, log_handle)
        if not _entry_is_current(tenant_key, token):
            return

        env = os.environ.copy()
        env["PORT"] = str(port)
        env["HOST"] = HOST
        env["HOSTNAME"] = HOST
        _update_entry(tenant_key, token, status="starting", detail="Launching dev server...")
        try:
            process = subprocess.Popen(
                _dev_command(app_root, port),
                cwd=str(app_root),
                env=env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
            )
        except OSError as exc:
            _update_entry(
                tenant_key,
                token,
                status="failed",
                detail=f"Failed to start preview process: {exc}",
            )
            return

        if not _update_entry(
            tenant_key,
            token,
            process=process,
            status="starting",
            detail="Waiting for dev server to compile...",
        ):
            _terminate_process({"process": process})
            return

        if _healthcheck(
            url,
            should_continue=lambda: _entry_is_current(tenant_key, token) and process.poll() is None,
        ):
            _update_entry(tenant_key, token, status="ready", detail="")
            return
        if not _entry_is_current(tenant_key, token):
            _terminate_process({"process": process})
            return
        log_summary = _tail_preview_log_summary(log_path)
        if process.poll() is not None:
            detail = f"Preview process exited early. See {log_path}."
            if log_summary:
                detail = f"{detail} Latest error: {log_summary}"
            _update_entry(tenant_key, token, status="failed", detail=detail)
        else:
            detail = f"Preview did not become ready within {START_TIMEOUT_SECONDS}s. See {log_path}."
            if log_summary:
                detail = f"{detail} Latest error: {log_summary}"
            _terminate_process({"process": process})
            _update_entry(
                tenant_key,
                token,
                status="failed",
                process=None,
                detail=detail,
            )
    except Exception as exc:  # pragma: no cover - defensive
        _update_entry(tenant_key, token, status="failed", detail=f"Preview startup error: {exc}")
    finally:
        try:
            log_handle.close()
        except OSError:
            pass


def start_preview(
    *,
    tenant_id: str,
    base_repo_path: str,
    app_targets: list[str] | None = None,
    force_restart: bool = False,
) -> dict[str, Any]:
    tenant_repo = Path(
        get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)
    ).resolve()
    tenant_key = str(tenant_repo)
    if not tenant_repo.exists() or not tenant_repo.is_dir():
        return _static_preview(
            status="failed",
            detail=f"Tenant source repository is missing: {tenant_repo}",
        )

    app_root = _find_app_root(tenant_repo, app_targets)
    old_entry: dict[str, Any] | None = None
    with _PREVIEW_LOCK:
        existing = _PREVIEW_PROCESSES.get(tenant_key)
        same_app = bool(
            existing
            and existing.get("app_root") == (str(app_root) if app_root else None)
        )
        if existing and same_app and not force_restart:
            existing_status = str(existing.get("status") or "")
            if existing_status == "starting" and (_thread_alive(existing) or _process_running(existing)):
                return _entry_payload(existing)
            if existing_status == "ready":
                if existing.get("kind") == "static_file" or (
                    _process_running(existing) and _is_port_open(int(existing.get("port") or 0))
                ):
                    return _entry_payload(existing)
        if existing:
            existing["status"] = "stopped"
            old_entry = existing

    if old_entry and _process_running(old_entry):
        _terminate_process(old_entry)

    if app_root is None:
        entry = {
            "kind": "static_file",
            "status": "ready",
            "url": None,
            "detail": "No runnable package dev script was found; serving the static preview fallback.",
            "app_root": None,
            "process": None,
            "thread": None,
            "token": uuid.uuid4().hex,
        }
        with _PREVIEW_LOCK:
            _PREVIEW_PROCESSES[tenant_key] = entry
        return _entry_payload(entry)

    try:
        port = _find_free_port()
    except RuntimeError as exc:
        return _static_preview(detail=f"{exc} Serving the static preview fallback.")

    token = uuid.uuid4().hex
    url = f"http://{HOST}:{port}"
    safe_tenant = re.sub(r"[^a-zA-Z0-9_.-]+", "-", tenant_id).strip("-") or "tenant"
    log_path = Path(__file__).resolve().parents[1] / "logs" / "previews" / f"{safe_tenant}.log"
    entry = {
        "kind": "live_server",
        "status": "starting",
        "url": url,
        "detail": "Preparing preview...",
        "app_root": str(app_root),
        "port": port,
        "process": None,
        "thread": None,
        "log_path": str(log_path),
        "token": token,
    }
    thread = threading.Thread(
        target=_boot_preview_worker,
        args=(tenant_key, token, log_path, app_root, port, url),
        name=f"preview-{safe_tenant}",
        daemon=True,
    )
    entry["thread"] = thread
    with _PREVIEW_LOCK:
        _PREVIEW_PROCESSES[tenant_key] = entry
    thread.start()
    return _entry_payload(entry)


def preview_status(
    *,
    tenant_id: str,
    base_repo_path: str,
    app_targets: list[str] | None = None,
) -> dict[str, Any]:
    tenant_repo = Path(
        get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)
    ).resolve()
    tenant_key = str(tenant_repo)
    if not tenant_repo.exists() or not tenant_repo.is_dir():
        return _static_preview(
            status="failed",
            detail=f"Tenant source repository is missing: {tenant_repo}",
        )

    with _PREVIEW_LOCK:
        entry = _PREVIEW_PROCESSES.get(tenant_key)
    if entry is None:
        if _find_app_root(tenant_repo, app_targets) is None:
            return _static_preview(
                detail="No runnable package dev script was found; static preview is ready.",
            )
        return _static_preview(
            status="stopped",
            detail="Live preview has not been started.",
        )

    status = str(entry.get("status") or "failed")
    if entry.get("kind") == "static_file" or status == "stopped":
        return _entry_payload(entry)

    if status == "starting":
        if _process_running(entry) or _thread_alive(entry):
            return _entry_payload(entry)
        detail = _tail_preview_log_summary(entry.get("log_path"))
        failure = "Preview startup stopped unexpectedly."
        if detail:
            failure = f"{failure} Latest error: {detail}"
        _update_entry(tenant_key, str(entry.get("token") or ""), status="failed", detail=failure)
        return _entry_payload(entry)

    if status == "ready":
        if _process_running(entry) and _is_port_open(int(entry.get("port") or 0)):
            return _entry_payload(entry)
        detail = _tail_preview_log_summary(entry.get("log_path"))
        failure = "Preview process is no longer running."
        if detail:
            failure = f"{failure} Latest error: {detail}"
        if _process_running(entry):
            _terminate_process(entry)
        _update_entry(
            tenant_key,
            str(entry.get("token") or ""),
            status="failed",
            process=None,
            detail=failure,
        )
    return _entry_payload(entry)


def stop_preview(*, tenant_id: str, base_repo_path: str) -> dict[str, Any]:
    tenant_repo = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)).resolve()
    with _PREVIEW_LOCK:
        entry = _PREVIEW_PROCESSES.get(str(tenant_repo))
        if entry:
            entry["status"] = "stopped"
            entry["detail"] = "Preview stopped."
    if not entry:
        return {"kind": "live_server", "status": "stopped", "detail": "No live preview process was running."}

    if _process_running(entry):
        _terminate_process(entry)
        entry["process"] = None
    return _entry_payload(entry)


def get_preview_upstream_url(*, tenant_id: str, base_repo_path: str) -> str | None:
    """Return a loopback URL for backend-internal proxying only."""
    tenant_repo = Path(
        get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_id)
    ).resolve()
    with _PREVIEW_LOCK:
        entry = _PREVIEW_PROCESSES.get(str(tenant_repo))
        if (
            not entry
            or entry.get("kind") != "live_server"
            or entry.get("status") != "ready"
            or not _process_running(entry)
        ):
            return None
        url = str(entry.get("url") or "")
    return url if url.startswith(f"http://{HOST}:") else None


def _cleanup_all_previews() -> None:
    with _PREVIEW_LOCK:
        entries = list(_PREVIEW_PROCESSES.values())
        for entry in entries:
            entry["status"] = "stopped"
    for entry in entries:
        if _process_running(entry):
            _terminate_process(entry)


atexit.register(_cleanup_all_previews)

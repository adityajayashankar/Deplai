from __future__ import annotations

import io
import json
import os
import tarfile
import uuid
from pathlib import Path
from typing import Any


TERRAFORM_IMAGE = "hashicorp/terraform:1.9.0"


def _command_timeout_seconds(args: list[str]) -> int:
    primary = args[0] if args else ""
    defaults = {
        "init": int(os.getenv("DEPLAI_TERRAFORM_INIT_TIMEOUT_SECONDS", "600")),
        "plan": int(os.getenv("DEPLAI_TERRAFORM_PLAN_TIMEOUT_SECONDS", "1800")),
        "apply": int(os.getenv("DEPLAI_TERRAFORM_APPLY_TIMEOUT_SECONDS", "3600")),
        "show": int(os.getenv("DEPLAI_TERRAFORM_SHOW_TIMEOUT_SECONDS", "300")),
        "output": int(os.getenv("DEPLAI_TERRAFORM_OUTPUT_TIMEOUT_SECONDS", "300")),
        "force-unlock": int(os.getenv("DEPLAI_TERRAFORM_UNLOCK_TIMEOUT_SECONDS", "120")),
    }
    return defaults.get(primary, int(os.getenv("DEPLAI_TERRAFORM_DEFAULT_TIMEOUT_SECONDS", "900")))


def _docker_client() -> Any:
    import docker

    return docker.from_env()


def _decode_output(output: bytes | str) -> str:
    return output.decode() if isinstance(output, bytes) else str(output)


def _emit_progress(apply_context: dict[str, Any] | None, msg_type: str, content: str) -> None:
    if not apply_context:
        return
    emitter = apply_context.get("emit")
    if not callable(emitter):
        return
    try:
        emitter(str(msg_type or "info"), str(content or "").strip())
    except Exception:
        pass


def _tar_directory(root: Path) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for file_path in sorted(root.rglob("*")):
            if not file_path.is_file():
                continue
            rel_path = file_path.relative_to(root).as_posix()
            data = file_path.read_bytes()
            info = tarfile.TarInfo(name=rel_path)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    buffer.seek(0)
    return buffer.getvalue()


def _sync_local_to_volume(local_dir: Path, volume_name: str) -> None:
    docker_client = _docker_client()
    helper = docker_client.containers.create(
        "alpine",
        command=["sh", "-lc", "sleep 120"],
        volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
    )
    try:
        helper.start()
        helper.put_archive("/workspace", _tar_directory(local_dir))
    finally:
        try:
            helper.remove(force=True)
        except Exception:
            pass


def _sync_volume_to_local(local_dir: Path, volume_name: str) -> None:
    docker_client = _docker_client()
    helper = docker_client.containers.create(
        "alpine",
        command=["sh", "-lc", "sleep 120"],
        volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
    )
    try:
        helper.start()
        stream, _ = helper.get_archive("/workspace")
        payload = b"".join(stream)
        if not payload:
            return
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
            archive.extractall(path=local_dir)
    finally:
        try:
            helper.remove(force=True)
        except Exception:
            pass


def _lock_info_path(local_dir: Path) -> Path | None:
    candidates = [
        local_dir / ".terraform.tfstate.lock.info",
        local_dir / "terraform.tfstate.lock.info",
        local_dir / ".terraform" / "terraform.tfstate.lock.info",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _extract_lock_id(local_dir: Path) -> str | None:
    lock_path = _lock_info_path(local_dir)
    if lock_path is None:
        return None
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    lock_id = str(payload.get("ID") or "").strip()
    return lock_id or None


def run_terraform_command(
    local_dir: Path,
    args: list[str],
    *,
    env: dict[str, str],
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if apply_context and apply_context.get("cancel_requested"):
        raise RuntimeError("Terraform apply cancelled by user.")

    primary = str(args[0] if args else "terraform").strip() or "terraform"
    _emit_progress(apply_context, "info", f"Running terraform {primary}...")

    volume_name = f"deplai_tf_exec_{uuid.uuid4().hex[:12]}"
    docker_client = _docker_client()
    volume = docker_client.volumes.create(name=volume_name)
    stdout = ""
    timeout_seconds = _command_timeout_seconds(args)
    try:
        _sync_local_to_volume(local_dir, volume_name)
        container = docker_client.containers.create(
            TERRAFORM_IMAGE,
            command=[f"-chdir=/workspace", *args],
            environment=env,
            volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
        )
        if apply_context is not None:
            apply_context["container_id"] = container.id
        try:
            container.start()
            result = container.wait(timeout=timeout_seconds)
            stdout = _decode_output(container.logs(stdout=True, stderr=True))
            status_code = int((result or {}).get("StatusCode") or 1)
            _sync_volume_to_local(local_dir, volume_name)
            if status_code != 0:
                _emit_progress(apply_context, "error", f"terraform {primary} failed.")
                raise RuntimeError(stdout or f"terraform command failed (exit {status_code})")
            _emit_progress(apply_context, "success", f"terraform {primary} completed.")
            return {"stdout": stdout, "status_code": status_code}
        except Exception as exc:
            try:
                container.kill()
            except Exception:
                pass
            _sync_volume_to_local(local_dir, volume_name)
            stdout = _decode_output(container.logs(stdout=True, stderr=True))
            lock_id = _extract_lock_id(local_dir)
            primary = args[0] if args else ""
            if lock_id and primary in {"plan", "apply"}:
                try:
                    run_terraform_command(
                        local_dir,
                        ["force-unlock", "-force", lock_id],
                        env=env,
                        apply_context=apply_context,
                    )
                except Exception:
                    pass
            _emit_progress(apply_context, "error", f"terraform {primary} failed or timed out.")
            raise RuntimeError(f"terraform {' '.join(args)} failed or timed out after {timeout_seconds}s: {stdout or exc}") from exc
        finally:
            if apply_context is not None:
                apply_context["container_id"] = None
            try:
                container.remove(force=True)
            except Exception:
                pass
    finally:
        try:
            volume.remove(force=True)
        except Exception:
            pass


def parse_json_stream(stream_text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in str(stream_text or "").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def extract_diagnostics(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    diagnostics: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "diagnostic":
            continue
        diagnostic = event.get("diagnostic")
        if not isinstance(diagnostic, dict):
            continue
        level = str(diagnostic.get("severity") or event.get("@level") or "").lower()
        if level and level != "error":
            continue
        diagnostics.append(
            {
                "summary": str(diagnostic.get("summary") or ""),
                "detail": str(diagnostic.get("detail") or ""),
                "range": diagnostic.get("range"),
            }
        )
    return diagnostics


def extract_apply_errors(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") == "apply_errored":
            failures.append(event)
    return failures


def extract_failed_resource_types(failures: list[dict[str, Any]]) -> list[str]:
    resource_types: list[str] = []
    for failure in failures:
        for key in ("resource_type", "resource_addr", "addr"):
            value = str(failure.get(key) or "").strip()
            if not value:
                continue
            if value.startswith("aws_") and "." in value:
                value = value.split(".", 1)[0]
            elif "." in value and not value.startswith("aws_"):
                value = value.split(".", 1)[0]
            if value.startswith("module.") and ".aws_" in value:
                value = value.split(".aws_", 1)[1]
                value = f"aws_{value.split('.', 1)[0]}"
            if value.startswith("aws_"):
                resource_types.append(value)
                break
    return sorted(set(resource_types))

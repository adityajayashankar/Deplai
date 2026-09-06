"""Shared Docker scanner wait helpers with named live log callbacks."""

from __future__ import annotations

import time
import contextvars
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Any

from utils import decode_output

LogCallback = Callable[[str], None]
execution_evidence: contextvars.ContextVar[dict | None] = contextvars.ContextVar("scanner_evidence", default=None)


def safe_log(message: str) -> str:
    from security_redaction import redact
    return redact(message)


def wait_container(
    container: Any,
    *,
    timeout_seconds: int,
    engine: str,
    on_log: LogCallback | None = None,
    poll_seconds: int = 15,
    success_codes: tuple[int, ...] = (0,),
) -> tuple[bool, str, int]:
    """Wait for a detached container while emitting periodic named log tails.

    Returns (ok, error_message, exit_code).
    """
    deadline = time.monotonic() + max(1, int(timeout_seconds))
    last_emitted = ""
    started = time.monotonic()
    if on_log:
        on_log(f"{engine}: container started")

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            try:
                container.kill()
            except Exception:
                pass
            if on_log:
                on_log(f"{engine}: timed out after {timeout_seconds}s")
            return (False, f"{engine} timed out after {timeout_seconds}s", -1)

        wait_for = min(max(1, int(poll_seconds)), max(1, int(remaining)))
        try:
            result = container.wait(timeout=wait_for)
            exit_code = int(result.get("StatusCode", -1))
            if on_log:
                tail = decode_output(container.logs(stdout=True, stderr=True, tail=12))
                detail = " ".join(tail.split())[:220]
                if detail:
                    on_log(safe_log(f"{engine}: exit {exit_code} — {detail}"))
                else:
                    on_log(f"{engine}: finished with exit {exit_code}")
            if exit_code in success_codes:
                return (True, "", exit_code)
            return (False, f"{engine} exited with code {exit_code}", exit_code)
        except Exception as exc:
            # docker SDK raises on wait timeout; keep polling until our deadline.
            message = str(exc).lower()
            if "timed out" not in message and "timeout" not in message:
                return (False, str(exc), -1)

        if on_log:
            elapsed = int(time.monotonic() - started)
            try:
                tail = decode_output(container.logs(stdout=True, stderr=True, tail=8))
            except Exception:
                tail = ""
            detail = " ".join(tail.split())[:180]
            line = f"{engine}: still running ({elapsed}s)"
            if detail and detail != last_emitted:
                line = f"{line} — {detail}"
                last_emitted = detail
            on_log(safe_log(line))


def run_detached(
    *,
    image: str,
    command: list[str] | None = None,
    entrypoint: str | list[str] | None = None,
    volumes: dict | None = None,
    environment: dict | None = None,
    user: str | None = None,
    timeout_seconds: int,
    engine: str,
    on_log: LogCallback | None = None,
    success_codes: tuple[int, ...] = (0,),
    poll_seconds: int = 15,
) -> tuple[bool, str]:
    """Start a detached container, stream named progress, and clean up."""
    from utils import get_docker_client

    container = None
    try:
        if on_log:
            on_log(f"{engine}: launching image {image}")
        kwargs: dict[str, Any] = {
            "image": image,
            "detach": True,
        }
        if command is not None:
            kwargs["command"] = command
        if entrypoint is not None:
            kwargs["entrypoint"] = entrypoint
        if volumes is not None:
            kwargs["volumes"] = volumes
        if environment is not None:
            kwargs["environment"] = environment
        if user is not None:
            kwargs["user"] = user
        container = get_docker_client().containers.run(**kwargs)
        evidence = execution_evidence.get()
        if evidence is not None:
            evidence.update(container_id=container.id, image=image,
                process_started_at=datetime.now(timezone.utc).isoformat())
            try:
                evidence["image_id"] = container.image.id
            except Exception:
                pass
        ok, error, _ = wait_container(
            container,
            timeout_seconds=timeout_seconds,
            engine=engine,
            on_log=on_log,
            poll_seconds=poll_seconds,
            success_codes=success_codes,
        )
        if evidence is not None:
            evidence.update(exit_code=_, process_finished_at=datetime.now(timezone.utc).isoformat())
        try:
            container.remove(force=True)
        except Exception:
            pass
        return (ok, error)
    except Exception as exc:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(exc))

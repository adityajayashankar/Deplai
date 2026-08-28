from __future__ import annotations

import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from deploy_exec.errors import DeployError


def poll(
    operation: Callable[[], Any],
    *,
    retries: int,
    interval_seconds: float,
    sleeper=time.sleep,
) -> Any:
    last: Exception | None = None
    attempts = max(1, int(retries))
    for attempt in range(attempts):
        try:
            return operation()
        except DeployError as exc:
            last = exc
            if attempt >= attempts - 1:
                raise
            sleeper(max(0.0, float(interval_seconds)))
        except Exception as exc:
            last = exc
            if attempt >= attempts - 1:
                raise DeployError(code="HEALTH_CHECK_FAILED", technical_message=str(exc)) from exc
            sleeper(max(0.0, float(interval_seconds)))
    if isinstance(last, DeployError):
        raise last
    raise DeployError(code="HEALTH_CHECK_FAILED")


def check_http(url: str, expected_status: int = 200, timeout_seconds: float = 5) -> int:
    target = str(url or "").strip()
    if not target.lower().startswith(("http://", "https://")):
        raise DeployError(code="EXTERNAL_ENDPOINT_FAILED", technical_message="public endpoint is not http(s)")
    request = Request(target, method="GET")
    try:
        with urlopen(request, timeout=max(1.0, float(timeout_seconds))) as response:
            status = int(getattr(response, "status", 0) or 0)
    except HTTPError as exc:
        status = int(exc.code)
    except URLError as exc:
        raise DeployError(code="EXTERNAL_ENDPOINT_FAILED", technical_message=str(exc.reason)[:200]) from exc
    except Exception as exc:
        raise DeployError(code="EXTERNAL_ENDPOINT_FAILED", technical_message=str(exc)[:200]) from exc
    if status != int(expected_status):
        raise DeployError(
            code="EXTERNAL_ENDPOINT_FAILED",
            technical_message=f"expected {expected_status}, got {status}",
            details={"status": status, "expected": expected_status},
        )
    return status

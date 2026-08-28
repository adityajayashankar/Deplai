from __future__ import annotations

import time

from deploy_exec.errors import DeployError


def should_retry(error: DeployError, attempt: int, max_attempts: int) -> bool:
    if attempt >= max_attempts:
        return False
    return bool(error.retryable)


def backoff_seconds(attempt: int, base: float = 1.5, cap: float = 20.0) -> float:
    delay = min(cap, base * (2 ** max(0, attempt - 1)))
    return float(delay)


def sleep_backoff(attempt: int, base: float = 1.5, cap: float = 20.0, sleeper=time.sleep) -> None:
    sleeper(backoff_seconds(attempt, base=base, cap=cap))

"""Shared service-key comparison for Connector → Agentic HTTP."""

from __future__ import annotations

import hmac


def api_key_matches(provided: str | None, expected: str) -> bool:
    if not isinstance(provided, str) or not expected:
        return False
    left = provided.encode("utf-8")
    right = expected.encode("utf-8")
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)

from __future__ import annotations

import re
from typing import Any

_SECRET_KEYS = {
    "password", "secret", "token", "api_key", "aws_secret_access_key", "aws_session_token",
    "github_token", "authorization", "private_key", "private_key_pem", "database_url",
    "pgpassword", "secret_string", "digest_auth",
}

_SECRET_PATTERNS = (
    re.compile(r"(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*\S+"),
    re.compile(r"(?i)postgresql://[^:\s]+:[^@\s]+@"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
)


def redact_text(value: str) -> str:
    text = str(value or "")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def _sensitive_key(key: str) -> bool:
    lowered = str(key or "").strip().lower()
    if lowered in {"secret_references", "secret_arns", "config_keys"}:
        return False
    if lowered in _SECRET_KEYS:
        return True
    if lowered.endswith(("_secret", "_password", "_token", "_api_key")):
        return True
    if "password" in lowered and lowered != "password_file":
        return True
    return False


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            if _sensitive_key(str(key)):
                cleaned[key] = "[REDACTED]"
            else:
                cleaned[key] = redact(item)
        return cleaned
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value

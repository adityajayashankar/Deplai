"""OpenRouter-free router policy for security remediation."""
from __future__ import annotations


def is_openrouter_free_model(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized == "openrouter/free" or normalized.endswith(":free")


def resolve_cheap_model(model: str | None, *, access_mode: str | None = None) -> str:
    """Always route remediation through OpenRouter's free model router."""
    return "openrouter/free"


def default_model() -> str:
    return "openrouter/free"


def resolve_model(model: str | None) -> str:
    return resolve_cheap_model(model)


def rotation() -> list[str]:
    # OpenRouter chooses a free upstream for this router request.
    return ["openrouter/free"]

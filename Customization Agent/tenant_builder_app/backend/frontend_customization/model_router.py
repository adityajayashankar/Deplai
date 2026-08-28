"""Abstract model router. Never force the most expensive model for trivial work."""

from __future__ import annotations

from typing import Any

TASK_TO_ROLE = {
    "ux_research": "planning",
    "ux_strategy": "planning",
    "design_system": "planning",
    "screen_planner": "planning",
    "implement_shell": "coding",
    "implement_screens": "coding",
    "implement_responsive": "coding",
    "implement_a11y": "coding",
    "repair": "coding",
    "visual_qa": "vision",
    "business_logic": "classification",
    "review_gate": "planning",
}

ROLE_DEFAULTS = {
    "planning": {"prefer": ["claude-sonnet-4-6", "gpt-4.1", "gemini-2.5-pro"], "max_tokens": 2500},
    "coding": {"prefer": ["claude-sonnet-4-6", "gpt-4.1", "gpt-4o"], "max_tokens": 4000},
    "vision": {"prefer": ["gpt-4o", "claude-sonnet-4-6", "gemini-2.5-pro"], "max_tokens": 1200},
    "classification": {"prefer": ["claude-haiku-4-5", "gpt-4o-mini", "gemini-2.5-flash"], "max_tokens": 800},
}


def route_model(stage: str, llm_config: dict[str, Any] | None = None) -> dict[str, Any]:
    role = TASK_TO_ROLE.get(stage, "classification")
    defaults = ROLE_DEFAULTS[role]
    config = dict(llm_config or {})
    requested = str(config.get("model") or "").strip()
    return {
        "role": role,
        "model": requested or defaults["prefer"][0],
        "max_tokens": int(config.get("max_tokens") or defaults["max_tokens"]),
        "provider": str(config.get("provider") or ""),
        "access_mode": str(config.get("access_mode") or "auto"),
        "user_id": str(config.get("user_id") or ""),
    }


def sanitize_llm_config(llm_config: dict[str, Any] | None) -> dict[str, Any]:
    cleaned = dict(llm_config or {})
    cleaned.pop("api_key", None)
    cleaned.pop("apiKey", None)
    return cleaned


def llm_available(llm_config: dict[str, Any] | None) -> bool:
    if not llm_config:
        return False
    if str(llm_config.get("user_id") or "").strip():
        return True
    key = str(llm_config.get("api_key") or "").strip()
    provider = str(llm_config.get("provider") or "").strip()
    model = str(llm_config.get("model") or "").strip()
    return bool(key and (provider or model))


def llm_client_kwargs(state: dict[str, Any]) -> dict[str, Any]:
    config = state.get("llm_config") if isinstance(state.get("llm_config"), dict) else {}
    return {
        "provider": str(config.get("provider") or ""),
        "model": str(config.get("model") or ""),
        "access_mode": str(config.get("access_mode") or "auto"),
        "user_id": str(config.get("user_id") or state.get("user_id") or ""),
        "api_key": "",
    }

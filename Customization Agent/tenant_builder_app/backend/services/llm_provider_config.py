from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parents[2]

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
HF_API_URL = "https://router.huggingface.co/v1/chat/completions"

DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant"
DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-coder:free"
DEFAULT_HF_MODEL = "Qwen/Qwen2.5-Coder-32B-Instruct"
OPENROUTER_FALLBACK_MODELS = (
    DEFAULT_OPENROUTER_MODEL,
    "openai/gpt-oss-20b:free",
    "z-ai/glm-4.5-air:free",
    "google/gemma-3n-e2b-it:free",
)


@dataclass(frozen=True)
class LLMProviderConfig:
    provider: str
    api_url: str
    model: str
    api_key: str


def load_llm_env() -> None:
    """Load backend-local env first, then repo-root env for this monorepo layout."""
    load_dotenv(BACKEND_DIR / ".env", override=False)
    load_dotenv(REPO_ROOT / ".env", override=False)


def infer_provider(api_url: str) -> str:
    lowered = (api_url or "").lower()
    if "groq.com" in lowered:
        return "groq"
    if "openrouter.ai" in lowered:
        return "openrouter"
    if "anthropic" in lowered:
        return "anthropic"
    if "huggingface" in lowered:
        return "huggingface"
    if "127.0.0.1" in lowered or "localhost" in lowered:
        return "local"
    return "generic"


def _normalize_provider(raw: str) -> str:
    provider = raw.strip().lower().replace("_", "-")
    aliases = {
        "open-router": "openrouter",
        "open_router": "openrouter",
        "or": "openrouter",
        "lmstudio": "local",
        "lm-studio": "local",
        "grroq": "groq",
    }
    return aliases.get(provider, provider)


def _env_first(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "")
        if value and value.strip():
            return value.strip()
    return ""


def _groq_config(explicit_api_url: str = "") -> LLMProviderConfig:
    return LLMProviderConfig(
        provider="groq",
        api_url=explicit_api_url or GROQ_API_URL,
        model=_env_first("LLM_MODEL_ID", "CUSTOMIZATION_LLM_MODEL", "GROQ_MODEL") or DEFAULT_GROQ_MODEL,
        api_key=_env_first("LLM_API_KEY", "CUSTOMIZATION_LLM_API_KEY", "GROQ_API_KEY"),
    )


def _openrouter_config(
    explicit_api_url: str = "",
    *,
    model_override: str = "",
    use_default_model: bool = False,
) -> LLMProviderConfig:
    configured_model = _env_first("LLM_MODEL_ID", "CUSTOMIZATION_LLM_MODEL", "OPENROUTER_MODEL")
    if model_override:
        model = model_override
    elif use_default_model:
        model = DEFAULT_OPENROUTER_MODEL
    else:
        model = configured_model or DEFAULT_OPENROUTER_MODEL

    return LLMProviderConfig(
        provider="openrouter",
        api_url=explicit_api_url or OPENROUTER_API_URL,
        model=model,
        api_key=_env_first("LLM_API_KEY", "CUSTOMIZATION_LLM_API_KEY", "OPENROUTER_API_KEY"),
    )


def _legacy_config(requested_provider: str, explicit_api_url: str) -> LLMProviderConfig:
    api_url = explicit_api_url or _env_first("HF_API_URL") or HF_API_URL
    provider = requested_provider or infer_provider(api_url)
    provider_key_names = {
        "anthropic": ("ANTHROPIC_API_KEY",),
        "huggingface": ("HF_API_KEY",),
        "local": ("HF_API_KEY",),
        "generic": ("HF_API_KEY",),
    }.get(provider, ("HF_API_KEY",))

    return LLMProviderConfig(
        provider=provider,
        api_url=api_url,
        model=_env_first("LLM_MODEL_ID", "CUSTOMIZATION_LLM_MODEL", "HF_MODEL_ID") or DEFAULT_HF_MODEL,
        api_key=_env_first("LLM_API_KEY", "CUSTOMIZATION_LLM_API_KEY", *provider_key_names),
    )


def _dedupe_configs(configs: list[LLMProviderConfig]) -> list[LLMProviderConfig]:
    deduped: list[LLMProviderConfig] = []
    seen: set[tuple[str, str, str, str]] = set()
    for config in configs:
        if not config.api_url or not config.model:
            continue
        key = (config.provider, config.api_url, config.model, "key" if config.api_key else "")
        if key in seen:
            continue
        seen.add(key)
        deduped.append(config)
    return deduped


def resolve_llm_provider_configs() -> list[LLMProviderConfig]:
    load_llm_env()

    requested_provider = _normalize_provider(
        _env_first("LLM_PROVIDER", "AGENT_LLM_BACKEND", "CUSTOMIZATION_LLM_PROVIDER")
    )
    explicit_api_url = _env_first("LLM_API_URL", "CUSTOMIZATION_LLM_API_URL")

    if not requested_provider and explicit_api_url:
        requested_provider = infer_provider(explicit_api_url)

    configs: list[LLMProviderConfig] = []
    if requested_provider == "groq" or (not requested_provider and _env_first("GROQ_API_KEY")):
        configs.append(_groq_config(explicit_api_url if requested_provider == "groq" else ""))
    elif requested_provider == "openrouter" or (not requested_provider and _env_first("OPENROUTER_API_KEY")):
        configs.append(_openrouter_config(explicit_api_url if requested_provider == "openrouter" else ""))
    else:
        configs.append(_legacy_config(requested_provider, explicit_api_url))

    if _env_first("GROQ_API_KEY"):
        configs.append(_groq_config())

    if _env_first("OPENROUTER_API_KEY"):
        configs.append(_openrouter_config())
        configured_openrouter_model = _env_first("LLM_MODEL_ID", "CUSTOMIZATION_LLM_MODEL", "OPENROUTER_MODEL")
        for fallback_model in OPENROUTER_FALLBACK_MODELS:
            if fallback_model != configured_openrouter_model:
                configs.append(_openrouter_config(model_override=fallback_model, use_default_model=True))

    if _env_first("HF_API_KEY") or explicit_api_url:
        configs.append(_legacy_config("", explicit_api_url))

    return _dedupe_configs(configs)


def resolve_llm_provider_config() -> LLMProviderConfig:
    configs = resolve_llm_provider_configs()
    if configs:
        return configs[0]
    return _legacy_config("", "")

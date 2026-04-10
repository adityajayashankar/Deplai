from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

# Default model and provider can be modified based on available APIs
DEFAULT_MODEL = "llama-3.1-8b-instant"
DEFAULT_PROVIDER = "groq"  # Can be one of: openai, groq, anthropic, openrouter


def get_llm_client() -> OpenAI:
    provider = os.environ.get("AGENT_LLM_BACKEND", DEFAULT_PROVIDER).lower()

    if provider == "groq":
        return OpenAI(
            api_key=os.environ.get("GROQ_API_KEY"),
            base_url="https://api.groq.com/openai/v1",
        )
    elif provider == "anthropic":
        return OpenAI(
            api_key=os.environ.get("CLAUDE_API_KEY"),
            base_url="https://api.anthropic.com/v1",
        )
    elif provider == "openrouter":
        return OpenAI(
            api_key=os.environ.get("OPENROUTER_API_KEY"),
            base_url="https://openrouter.ai/api/v1",
        )
    else:  # Default to OpenAI-compatible API
        return OpenAI(
            api_key=os.environ.get("OPENAI_API_KEY", os.environ.get("XAI_API_KEY")),
        )


def get_model() -> str:
    provider = os.environ.get("AGENT_LLM_BACKEND", DEFAULT_PROVIDER).lower()

    if provider == "groq":
        return os.environ.get("GROQ_MODEL", DEFAULT_MODEL)
    elif provider == "openrouter":
        return os.environ.get("OPENROUTER_MODEL", "arcee-ai/trinity-large-preview:free")
    elif provider == "anthropic":
        return "claude-3-opus-20240229"
    else:
        return "gpt-3.5-turbo"


def chat_json(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    client = get_llm_client()
    model = get_model()

    try:
        response = client.chat.completions.create(
            model=model,
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content)
    except Exception as e:
        print(f"Error calling LLM API: {str(e)}")
        # Return empty dict on failure
        return {}

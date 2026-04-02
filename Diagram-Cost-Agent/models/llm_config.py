from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from openai import OpenAI


class GroqLLM:
    def __init__(self) -> None:
        api_key = os.getenv("GROQ_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is required for LLM fallback calls.")
        self.client = OpenAI(api_key=api_key, base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1"))
        self.model = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

    def call_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        content = (resp.choices[0].message.content or "").strip()
        if not content:
            return {}
        return json.loads(content)


# Backward compatibility alias for existing imports.
XAILLM = GroqLLM


def load_prompt(filename: str) -> str:
    base = Path(__file__).resolve().parents[1] / "prompts"
    return (base / filename).read_text(encoding="utf-8")

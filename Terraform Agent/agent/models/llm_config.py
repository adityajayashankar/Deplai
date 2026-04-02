from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

MODEL = "grok-4"


def get_llm_client() -> OpenAI:
    return OpenAI(
        api_key=os.environ["XAI_API_KEY"],
        base_url="https://api.x.ai/v1",
    )


def chat_json(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    client = get_llm_client()
    response = client.chat.completions.create(
        model=MODEL,
        temperature=0.2,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    content = response.choices[0].message.content or "{}"
    return json.loads(content)

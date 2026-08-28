"""Thin client used by the customization backend to call the DeplAI AI gateway."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib import error, request


def gateway_enabled() -> bool:
    flag = os.getenv("AI_PLATFORM_ENABLED", "true").strip().lower()
    url = os.getenv("DEPLAI_AI_GATEWAY_URL", "").strip() or os.getenv("CONNECTOR_URL", "").strip()
    return flag in {"1", "true", "yes", "on"} and bool(url)


def chat_via_gateway(
    *,
    user_id: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    api_key: str | None = None,
    provider: str | None = None,
    access_mode: str = "auto",
    temperature: float = 0.2,
    max_tokens: int = 2048,
    timeout_seconds: int = 40,
) -> str:
    payload: dict[str, Any] = {
        "model": model or "best",
        "access_mode": access_mode or "auto",
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if api_key:
        payload["api_key"] = api_key
    if provider:
        payload["provider"] = provider
    url = (os.getenv("DEPLAI_AI_GATEWAY_URL") or os.getenv("CONNECTOR_URL") or "").rstrip("/") + "/api/ai/chat"
    service_key = os.getenv("DEPLAI_SERVICE_KEY", "")
    headers = {
        "Content-Type": "application/json",
        "X-API-Key": service_key,
        "x-deplai-service-key": service_key,
        "x-deplai-user-id": user_id,
    }
    req = request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as extra:
        detail = extra.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AI gateway HTTP {extra.code}: {detail[:400]}") from extra
    text = str(data.get("output") or "").strip()
    if not text:
        raise error.URLError("AI gateway returned an empty response")
    return text

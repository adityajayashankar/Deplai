"""DeplAI AI gateway client.

Security remediation, Terraform generation, customization, and other agent
workflows must call this instead of provider SDKs. The Connector AI platform
resolves provider, model, credential source, routing, org-wallet metering, and
fallback.
"""

from __future__ import annotations

import contextvars
import json
import os
from typing import Any
from urllib import error, request

_bound_user_id: contextvars.ContextVar[str] = contextvars.ContextVar("deplai_ai_user_id", default="")
_bound_organization_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "deplai_ai_organization_id",
    default="",
)


def bind_user(user_id: str | None) -> None:
    _bound_user_id.set(str(user_id or "").strip())


def bind_organization(organization_id: str | None) -> None:
    _bound_organization_id.set(str(organization_id or "").strip())


def bind_ai_context(*, user_id: str | None = None, organization_id: str | None = None) -> None:
    if user_id is not None:
        bind_user(user_id)
    if organization_id is not None:
        bind_organization(organization_id)


def bound_user() -> str:
    return _bound_user_id.get() or os.getenv("DEPLAI_AI_USER_ID", "").strip()


def bound_organization() -> str:
    return _bound_organization_id.get() or os.getenv("DEPLAI_ORGANIZATION_ID", "").strip()


def gateway_enabled() -> bool:
    flag = os.getenv("AI_PLATFORM_ENABLED", "true").strip().lower()
    return flag in {"1", "true", "yes", "on"} and bool(_gateway_url())


def _require_organization_id() -> bool:
    return os.getenv("DEPLAI_AI_GATEWAY_REQUIRE_ORG", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def gateway_ready(user_id: str | None = None, organization_id: str | None = None) -> bool:
    resolved_user = str(user_id or bound_user()).strip()
    resolved_org = str(organization_id or bound_organization()).strip()
    if not gateway_enabled() or not resolved_user:
        return False
    if _require_organization_id() and not resolved_org:
        return False
    return True


def _gateway_url() -> str:
    return (
        os.getenv("DEPLAI_AI_GATEWAY_URL", "").strip()
        or os.getenv("CONNECTOR_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_APP_URL", "").strip()
    )


def _service_key() -> str:
    return os.getenv("DEPLAI_SERVICE_KEY", "").strip()


class DeplaiAI:
    def chat(
        self,
        *,
        user_id: str | None = None,
        organization_id: str | None = None,
        model: str = "best_reasoning",
        messages: list[dict[str, str]] | None = None,
        prompt: str | None = None,
        access_mode: str = "auto",
        task: str | None = None,
        api_key: str | None = None,
        provider: str | None = None,
        credential_id: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        timeout_seconds: int = 90,
    ) -> dict[str, Any]:
        resolved_user = str(user_id or bound_user()).strip()
        resolved_org = str(organization_id or bound_organization()).strip()
        if not resolved_user:
            raise RuntimeError("AI gateway requires a user_id.")
        if _require_organization_id() and not resolved_org:
            raise RuntimeError("AI gateway requires an organization_id for credit metering.")
        payload: dict[str, Any] = {
            "model": model,
            "access_mode": access_mode,
            "messages": messages
            or ([{"role": "user", "content": prompt}] if prompt else []),
        }
        if task:
            payload["task"] = task
            payload["routing_policy"] = task
        if api_key:
            payload["api_key"] = api_key
        if provider:
            payload["provider"] = provider
        if credential_id:
            payload["credential_id"] = credential_id
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if response_format:
            payload["response_format"] = response_format
        if metadata:
            payload["metadata"] = metadata

        url = _gateway_url().rstrip("/") + "/api/ai/chat"
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": _service_key(),
            "x-deplai-service-key": _service_key(),
            "x-deplai-user-id": resolved_user,
            "x-deplai-organization-id": resolved_org,
        }
        req = request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"AI gateway HTTP {exc.code}: {detail[:400]}") from exc


def _map_provider(provider: str | None) -> str | None:
    raw = (provider or "").strip().lower()
    if not raw or raw.startswith("best"):
        return None
    return {
        "claude": "anthropic",
        "anthropic": "anthropic",
        "google": "gemini",
        "gemini": "gemini",
        "openai": "openai",
        "groq": "groq",
        "openrouter": "openrouter",
        "minimax": "minimax",
        "xai": "xai",
        "kimi": "kimi",
        "glm": "glm",
    }.get(raw, raw)


def remediate_text(
    *,
    user_id: str | None,
    organization_id: str | None = None,
    prompt: str,
    model: str | None = None,
    access_mode: str | None = None,
    api_key: str | None = None,
    provider: str | None = None,
    credential_id: str | None = None,
    max_tokens: int | None = None,
    response_format: dict[str, Any] | None = None,
    timeout_seconds: int = 120,
) -> tuple[bool, str]:
    """Call the Connector AI gateway for security remediation."""
    resolved_user = str(user_id or bound_user()).strip()
    if not resolved_user:
        return (False, "AI gateway requires a user_id.")
    mode = (access_mode or "auto").strip().lower() or "auto"
    if mode not in {"platform", "byok", "auto"}:
        mode = "auto"
    requested = (model or "").strip()
    if not requested and mode == "platform":
        requested = os.getenv("REMEDIATION_PLATFORM_MODEL", "glm-5.2-free").strip()
    resolved_model = requested or ("glm-5.2-free" if mode == "platform" else "best_coding")
    return chat_text(
        user_id=resolved_user,
        organization_id=organization_id,
        model=resolved_model,
        prompt=prompt,
        access_mode=mode,
        api_key=api_key,
        provider=None if resolved_model.startswith("best") else _map_provider(provider),
        credential_id=credential_id,
        temperature=0.1,
        max_tokens=max_tokens,
        response_format=response_format,
        timeout_seconds=timeout_seconds,
        metadata={"product": "security", "stage": "remediation"},
    )


def chat_text(**kwargs: Any) -> tuple[bool, str]:
    if not gateway_enabled():
        return (False, "AI platform gateway is not configured.")
    try:
        result = DeplaiAI().chat(**kwargs)
        text = str(result.get("output") or "").strip()
        if not text:
            return (False, "AI gateway returned an empty response.")
        return (True, text)
    except Exception as exc:  # noqa: BLE001 - caller needs the failure string
        return (False, str(exc))


def chat_json(**kwargs: Any) -> dict[str, Any]:
    ok, text = chat_text(**kwargs)
    if not ok:
        raise RuntimeError(text)
    raw = str(text or "").strip()
    depth = 0
    start = -1
    for index, ch in enumerate(raw):
        if ch == "{":
            if depth == 0:
                start = index
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start != -1:
                candidate = raw[start : index + 1]
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict):
                        return parsed
                except json.JSONDecodeError:
                    start = -1
                    continue
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("AI gateway response was valid JSON but not an object.")
    return parsed

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
        # Security remediation validates its JSON contract locally. Do not
        # send OpenAI's native strict-schema option to OpenRouter free models:
        # provider support is inconsistent and rejected schemas become 400s.
        if response_format and not (metadata or {}).get("product") == "security":
            payload["response_format"] = response_format
        if metadata:
            payload["metadata"] = metadata
        # Reasoning controls are optional provider extensions. Omit them for
        # remediation so every selected OpenRouter free model receives the
        # smallest common OpenAI-compatible request shape.
        if (metadata or {}).get("product") != "security":
            payload.setdefault("reasoning", {"effort": "high"})

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
    timeout_seconds: int = 660,
    temperature: float = 0.15,
) -> tuple[bool, str]:
    """Call the platform OpenRouter gateway for security remediation.

    Remediation does not accept a caller key, BYOK credential, or alternate
    provider. Keeping that decision here as well as in Connector prevents a
    worker-side fallback from bypassing the product security policy.
    """
    resolved_user = str(user_id or bound_user()).strip()
    if not resolved_user:
        return (False, "Security remediation requires the authenticated platform gateway user context.")
    from cheap_models import resolve_cheap_model
    from remediation_pipeline.remediation_store import current_remediation_run_id
    return chat_text(
        user_id=resolved_user,
        organization_id=organization_id,
        model=model if model == "z-ai/glm-5.3-flash" else resolve_cheap_model(model, access_mode="platform"),
        prompt=prompt,
        access_mode="platform",
        # Deliberately omit api_key and credential_id: this is platform-only.
        provider="openrouter",
        temperature=temperature,
        max_tokens=max_tokens,
        # Strict JSON is a local postcondition. Native schema mode is omitted
        # because not every OpenRouter free upstream accepts it.
        response_format=None,
        timeout_seconds=timeout_seconds,
        metadata={
            "product": "security",
            "stage": "remediation",
            "remediation_run_id": current_remediation_run_id(),
            "json_contract": "local_strict",
        },
    )



def chat_text(**kwargs: Any) -> tuple[bool, str]:
    if not gateway_enabled():
        return (False, "AI platform gateway is not configured.")
    try:
        reservation = 0
        token_store = None
        token_run_id = ""
        if (kwargs.get("metadata") or {}).get("product") == "security":
            from remediation_pipeline.remediation_store import current_remediation_run_id, remediation_runs
            token_run_id = current_remediation_run_id()
            if token_run_id and callable(getattr(remediation_runs, "reserve_tokens", None)):
                serialized = json.dumps(kwargs.get("messages") or [{"role": "user", "content": kwargs.get("prompt", "")}], ensure_ascii=False)
                ascii_count = sum(ord(char) < 128 for char in serialized)
                reservation = (ascii_count + 2) // 3 + len(serialized.encode()) - ascii_count + 64 + int(kwargs.get("max_tokens") or 8192)
                token_store = remediation_runs
                token_store.reserve_tokens(token_run_id, reservation)
        result = DeplaiAI().chat(**kwargs)
        if token_store is not None:
            usage = result.get("usage") or {}
            actual = usage.get("totalTokens") or usage.get("total_tokens")
            if not actual:
                actual = (usage.get("inputTokens", 0) or 0) + (usage.get("outputTokens", 0) or 0)
            try:
                token_store.reconcile_tokens(token_run_id, reservation, actual)
            except Exception:
                # The original reservation remains charged. A completed model
                # response must not be discarded because reconciliation failed.
                token_store.append_event(token_run_id, project_id="", message_type="warning",
                    content="Token budget reconciliation unavailable; retaining the request estimate.", stage="remediation")
        if (kwargs.get("metadata") or {}).get("product") == "security":
            from remediation_pipeline.remediation_store import current_remediation_run_id, remediation_runs
            run_id = current_remediation_run_id()
            for attempt in result.get("skipped", []) or []:
                remediation_runs.append_event(run_id, project_id="", message_type="model_attempt",
                    content=json.dumps(attempt), stage="remediation")
            remediation_runs.append_event(run_id, project_id="", message_type="model_result",
                content=json.dumps({"model": result.get("model"), "provider": result.get("provider"),
                    "usage": result.get("usage"), "cost": result.get("cost"), "fallback": result.get("fallback")}), stage="remediation")
            record_usage = getattr(remediation_runs, "record_usage", None)
            usage_error = "" if callable(record_usage) else "the remediation journal is from a different release"
            if callable(record_usage):
                try:
                    record_usage(run_id, result.get("usage"))
                except Exception as exc:  # Usage telemetry must not cancel a completed model response.
                    usage_error = f"usage journaling failed ({type(exc).__name__})"
            if usage_error:
                # A split rollout must not turn a completed model response into
                # a failed remediation. The warning remains truthful and tells
                # operators to replace the stale journal with the same release.
                try:
                    remediation_runs.append_event(
                        run_id,
                        project_id="",
                        message_type="warning",
                        content=(
                            "Model response succeeded, but token usage was not recorded because " + usage_error + ". "
                            "Remediation will continue; "
                            "deploy the matching Agentic Layer image before relying on usage billing."
                        ),
                        stage="remediation",
                    )
                except Exception:
                    pass
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

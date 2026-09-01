"""LLM chat overlay for the infra advisor (OpenAI-compatible + Anthropic keys via consult helpers)."""

from __future__ import annotations

import json
import urllib.request
from typing import Any


def _text(value: Any) -> str:
    return str(value or "").strip()


def call_advisor_chat(
    *,
    messages: list[dict[str, Any]],
    decision: dict[str, Any],
    cost_estimate: dict[str, Any],
    budget_cap_usd: float,
    selected_tier: str,
    requirements: dict[str, Any],
    open_questions: list[str],
    repo_detection_summary: str,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    llm_api_base_url: str | None = None,
) -> str | None:
    """Answer the latest user message using plan context. Returns plain text or None."""
    stack = dict((decision or {}).get("stack_config") or {})
    ec2 = dict(stack.get("ec2") or {})
    rds = dict(stack.get("rds") or {})
    redis = dict(stack.get("elasticache") or stack.get("redis") or {})
    context = {
        "budget_cap_usd": budget_cap_usd,
        "selected_tier": selected_tier,
        "requirements": requirements,
        "open_questions": open_questions,
        "repo_detection_summary": repo_detection_summary,
        "components": list((decision or {}).get("components") or []),
        "ec2_instance_type": ec2.get("instance_type"),
        "ec2_root_gb": ec2.get("root_volume_size_gb"),
        "ec2_app_port": ec2.get("app_port"),
        "rds_instance_class": rds.get("instance_class") or rds.get("instance_type"),
        "rds_engine": rds.get("engine"),
        "redis_node_type": redis.get("node_type"),
        "estimated_monthly_usd": (cost_estimate or {}).get("subtotal_monthly_usd"),
        "recent_messages": [
            {"role": m.get("role"), "content": str(m.get("content") or "")[:800]}
            for m in (messages or [])[-10:]
            if isinstance(m, dict)
        ],
    }

    system_prompt = (
        "You are DeplAI's AWS setup advisor for beginners. "
        "Answer the user's latest message directly and specifically using the provided plan context. "
        "If they ask which EC2/instance size, name the exact instance_type from context and explain briefly why. "
        "Keep answers short (3-8 sentences). Use plain language; mention AWS names only when asked. "
        "Do not repeat a long intro. Do not dump the full architecture unless they ask for the whole plan. "
        "If something is unknown, say what you still need. Return plain text only — no JSON, no markdown fences."
    )
    user_prompt = (
        "Plan context (JSON):\n"
        f"{json.dumps(context, ensure_ascii=True, default=str)}\n\n"
        "Answer the latest user message in recent_messages."
    )

    try:
        from ai_gateway import chat_text, gateway_ready
        if gateway_ready():
            ok, text = chat_text(
                model=_text(llm_model) or "best",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                api_key=_text(llm_api_key) or None,
                provider=_text(llm_provider) or None,
                temperature=0.3,
                max_tokens=700,
                access_mode="byok" if _text(llm_api_key) else "platform",
                metadata={"product": "deployment", "stage": "infra_advise"},
            )
            if ok:
                return text
    except Exception:
        pass

    try:
        from terraform_consult import _llm_available, _resolve_openai_compatible
    except Exception:
        return None

    ok, _reason = _llm_available(
        llm_provider=llm_provider,
        llm_api_key=llm_api_key,
        llm_api_base_url=llm_api_base_url,
    )
    if not ok:
        return None

    config: dict[str, str] | None = None
    if _text(llm_api_key) and _text(llm_api_base_url):
        config = {
            "provider": _text(llm_provider) or "custom",
            "api_key": _text(llm_api_key),
            "model": _text(llm_model) or "gpt-4o-mini",
            "base_url": _text(llm_api_base_url).rstrip("/"),
        }
    else:
        config = _resolve_openai_compatible()
    if not config:
        return None

    endpoint = f"{config['base_url']}/chat/completions"
    payload = {
        "model": config["model"],
        "temperature": 0.3,
        "max_tokens": 700,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['api_key']}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            body = json.loads(response.read().decode("utf-8"))
        content = body["choices"][0]["message"]["content"]
        text = _text(content if isinstance(content, str) else json.dumps(content))
        return text or None
    except Exception:
        return None

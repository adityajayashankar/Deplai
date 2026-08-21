"""Public entrypoint for the LangGraph infra advisor."""

from __future__ import annotations

from typing import Any

from infra_advisor.graph import get_infra_advisor_graph
from infra_advisor.persistence import persist_advisor_state
from planning_runtime import slugify


def run_infra_advise(
    *,
    architecture_json: dict[str, Any] | None = None,
    repository_context: dict[str, Any] | None = None,
    deployment_profile: dict[str, Any] | None = None,
    detected: dict[str, Any] | None = None,
    aws_region: str = "eu-north-1",
    conversation_history: list[dict[str, Any]] | None = None,
    turn_count: int = 0,
    force_decision: bool = False,
    workspace: str | None = None,
    project_id: str | None = None,
    project_name: str | None = None,
    user_answers: dict[str, Any] | None = None,
    prior_decision: dict[str, Any] | None = None,
    budget_cap_usd: float | None = None,
    selected_tier: str | None = None,
    requirements: dict[str, Any] | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    llm_api_base_url: str | None = None,
) -> dict[str, Any]:
    workspace_key = slugify(workspace or project_name or project_id or "default")
    messages = [item for item in (conversation_history or []) if isinstance(item, dict)]

    initial: dict[str, Any] = {
        "messages": messages,
        "repo_context": dict(repository_context or {}),
        "architecture_json": dict(architecture_json or {}),
        "deployment_profile": dict(deployment_profile or {}),
        "detected": dict(detected or {}),
        "workspace": workspace_key,
        "region": aws_region or "eu-north-1",
        "turn_count": int(turn_count or 0),
        "force_decision": bool(force_decision),
        "prior_decision": dict(prior_decision or {}),
        "user_answers": dict(user_answers or {}),
        "requirements": dict(requirements or {}),
        "budget_cap_usd": float(budget_cap_usd) if budget_cap_usd is not None else 0.0,
        "selected_tier": selected_tier or "recommended",
        "ready": False,
        "open_questions": [],
        "upgrade_suggestions": [],
        "change_notes": [],
        "source": "infra_advisor",
        "llm_provider": llm_provider or "",
        "llm_api_key": llm_api_key or "",
        "llm_model": llm_model or "",
        "llm_api_base_url": llm_api_base_url or "",
    }

    graph = get_infra_advisor_graph()
    final_state = graph.invoke(initial)

    assistant_message = str(final_state.get("assistant_message") or "").strip()
    decision = dict(final_state.get("decision") or {})
    transcript = list(messages)
    if assistant_message:
        transcript.append({"role": "assistant", "content": assistant_message})

    persist_payload = {
        **final_state,
        "messages": transcript,
        "decision": decision,
    }
    persist_advisor_state(workspace=workspace_key, state=persist_payload)

    return {
        "success": True,
        "assistant_message": assistant_message,
        "ready": bool(final_state.get("ready")),
        "decision": decision or None,
        "open_questions": list(final_state.get("open_questions") or []),
        "repo_detection_summary": str(final_state.get("repo_detection_summary") or ""),
        "turn_count": int(final_state.get("turn_count") or (int(turn_count or 0) + 1)),
        "decision_summary": str(final_state.get("decision_summary") or ""),
        "source": "infra_advisor",
        "fallback_reason": None,
        "budget_cap_usd": float(final_state.get("budget_cap_usd") or 0),
        "selected_tier": str(final_state.get("selected_tier") or "recommended"),
        "cost_estimate": dict(final_state.get("cost_estimate") or {}),
        "budget_gate": dict(final_state.get("budget_gate") or {}),
        "upgrade_suggestions": list(final_state.get("upgrade_suggestions") or []),
        "plan_tiers": {
            "costs": dict((final_state.get("plan_tiers") or {}).get("costs") or {}),
        },
        "requirements": dict(final_state.get("requirements") or {}),
        "error": None,
    }

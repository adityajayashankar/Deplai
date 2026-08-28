"""Hierarchical memory and context budgets for agent prompts."""

from __future__ import annotations

from typing import Any

from frontend_customization.models import TrustLevel

DEFAULT_BUDGETS = {
    "intake": 2_000,
    "mapping": 4_000,
    "business_logic": 6_000,
    "ux_research": 5_000,
    "ux_strategy": 4_000,
    "design_system": 4_000,
    "screen_planner": 4_000,
    "implement_shell": 12_000,
    "implement_screens": 14_000,
    "implement_responsive": 8_000,
    "implement_a11y": 8_000,
    "repair": 10_000,
    "visual_qa": 3_000,
    "functional_safety": 3_000,
    "review_gate": 4_000,
}


def wrap_untrusted(text: str) -> str:
    compact = (text or "").strip()
    if not compact:
        return ""
    return (
        f"<{TrustLevel.UNTRUSTED_REPOSITORY_CONTENT.value}>\n"
        f"{compact[:8000]}\n"
        f"</{TrustLevel.UNTRUSTED_REPOSITORY_CONTENT.value}>"
    )


def context_for_task(state: dict[str, Any], stage: str) -> dict[str, Any]:
    """Progressive disclosure: only the facts this agent needs."""
    budget = DEFAULT_BUDGETS.get(stage, 4_000)
    facts = {
        "run_id": state.get("run_id"),
        "mode": state.get("mode"),
        "goal": state.get("goal"),
        "repository_manifest": _clip(state.get("repository_manifest") or {}, 1200),
        "trust": TrustLevel.TRUSTED.value,
    }
    if stage in {"business_logic", "implement_shell", "implement_screens", "implement_responsive", "implement_a11y", "repair", "functional_safety"}:
        facts["business_logic_boundary"] = state.get("business_logic_boundary") or {}
    if stage in {"ux_research", "ux_strategy", "design_system", "screen_planner"}:
        facts["frontend_manifest"] = _clip(state.get("frontend_manifest") or {}, 1500)
    if stage in {"ux_strategy", "design_system", "screen_planner", "implement_shell", "implement_screens"}:
        facts["product_ux_model"] = _clip(state.get("product_ux_model") or {}, 1200)
    if stage.startswith("implement") or stage in {"repair", "visual_qa", "review_gate"}:
        facts["design_system_plan"] = _clip(state.get("design_system_plan") or {}, 1200)
        facts["screen_plans"] = (state.get("screen_plans") or [])[:12]
        facts["tasks"] = (state.get("tasks") or [])[:12]
    facts["context_budget"] = budget
    return facts


def _clip(value: Any, limit: int) -> Any:
    text = str(value)
    if len(text) <= limit:
        return value
    if isinstance(value, dict):
        clipped: dict[str, Any] = {}
        remaining = limit
        for key, item in value.items():
            rendered = str(item)
            if remaining <= 0:
                break
            clipped[key] = rendered[: min(len(rendered), remaining)]
            remaining -= len(rendered)
        return clipped
    return text[:limit]

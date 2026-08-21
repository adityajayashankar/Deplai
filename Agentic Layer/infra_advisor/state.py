"""State for the LangGraph infra advisor."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


Intent = Literal[
    "set_budget",
    "answer",
    "refine",
    "choose_tier",
    "approve",
    "clarify",
    "start",
    "question",
]

TierId = Literal["baseline", "recommended", "resilient"]


class Requirements(TypedDict, total=False):
    audience: str
    availability: str
    data_needs: str
    traffic_band: str


class UpgradeSuggestion(TypedDict, total=False):
    extra_monthly_usd: float
    title: str
    plain_benefit: str
    unlocks: list[str]
    tier: str


class BudgetGate(TypedDict, total=False):
    cap_usd: float
    total_usd: float
    percent_used: float
    status: str
    gap_usd: float


class CostEstimate(TypedDict, total=False):
    currency: str
    source: str
    line_items: list[dict[str, Any]]
    subtotal_monthly_usd: float


class PlanTier(TypedDict, total=False):
    baseline: dict[str, Any]
    recommended: dict[str, Any]
    resilient: dict[str, Any]
    costs: dict[str, float]


class InfraAdvisorState(TypedDict, total=False):
    messages: list[dict[str, str]]
    repo_context: dict[str, Any]
    architecture_json: dict[str, Any]
    deployment_profile: dict[str, Any]
    detected: dict[str, Any]
    workspace: str
    region: str
    turn_count: int
    force_decision: bool
    prior_decision: dict[str, Any]
    user_answers: dict[str, Any]
    requirements: Requirements
    budget_cap_usd: float
    selected_tier: TierId
    intent: Intent
    intakes: dict[str, Any]
    decision: dict[str, Any]
    cost_estimate: CostEstimate
    budget_gate: BudgetGate
    upgrade_suggestions: list[UpgradeSuggestion]
    plan_tiers: PlanTier
    ready: bool
    open_questions: list[str]
    assistant_message: str
    decision_summary: str
    repo_detection_summary: str
    source: str
    change_notes: list[str]
    route: str
    llm_provider: str
    llm_api_key: str
    llm_model: str
    llm_api_base_url: str

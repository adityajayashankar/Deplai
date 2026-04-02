from __future__ import annotations

from typing import Optional, TypedDict


class DiagramNode(TypedDict):
    id: str
    label: str
    type: str
    color: str
    existing: bool


class DiagramEdge(TypedDict):
    from_node: str
    to_node: str
    style: str


class CostLineItem(TypedDict):
    service: str
    resource_id: str
    type: str
    monthly_usd: float
    notes: str


class BudgetGate(TypedDict):
    cap_usd: float
    total_usd: float
    percent_used: float
    status: str


class AgentState(TypedDict):
    infra_plan: dict
    budget_cap_usd: float
    pipeline_run_id: str
    environment: str
    diagram_nodes: list[DiagramNode]
    diagram_edges: list[DiagramEdge]
    cost_line_items: list[CostLineItem]
    total_monthly_usd: float
    estimate_type: str
    budget_gate: BudgetGate
    approval_payload: Optional[dict]
    warnings: list[str]


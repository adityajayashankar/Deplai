from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from state import AgentState


def run_approval_packager(state: AgentState) -> AgentState:
    infra_plan = dict(state.get("infra_plan") or {})
    region = str(infra_plan.get("region") or "ap-south-1")
    nodes = list(state.get("diagram_nodes") or [])
    edges = list(state.get("diagram_edges") or [])

    payload = {
        "stage": "7",
        "stage_label": "Generate diagram + estimate_cost",
        "pipeline_run_id": str(state.get("pipeline_run_id") or ""),
        "environment": str(state.get("environment") or "dev"),
        "diagram": {
            "nodes": nodes,
            "edges": [
                {"from": edge["from_node"], "to": edge["to_node"], "style": edge["style"]}
                for edge in edges
            ],
            "region": region,
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
        "cost_estimate": {
            "line_items": list(state.get("cost_line_items") or []),
            "total_monthly_usd": round(float(state.get("total_monthly_usd") or 0.0), 2),
            "currency": "USD",
            "estimate_type": str(state.get("estimate_type") or "live_runtime"),
        },
        "budget_gate": dict(state.get("budget_gate") or {}),
        "warnings": list(state.get("warnings") or []),
        "approval_required": True,
        "next_stage": "8",
        "next_stage_label": "Generate Terraform + Ansible",
        "generated_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    }

    output_dir = Path(__file__).resolve().parents[1] / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "stage7_approval_payload.json"
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return {
        **state,
        "approval_payload": payload,
    }


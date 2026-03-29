from __future__ import annotations

import json
import sys
from typing import Any

from graph import build_graph
from state import AgentState


def _default_state(payload: dict[str, Any]) -> AgentState:
    return {
        "infra_plan": dict(payload.get("infra_plan") or {}),
        "budget_cap_usd": float(payload.get("budget_cap_usd") or 100.0),
        "pipeline_run_id": str(payload.get("pipeline_run_id") or ""),
        "environment": str(payload.get("environment") or "dev"),
        "diagram_nodes": [],
        "diagram_edges": [],
        "cost_line_items": [],
        "total_monthly_usd": 0.0,
        "estimate_type": "live_runtime",
        "budget_gate": {"cap_usd": 0.0, "total_usd": 0.0, "percent_used": 0.0, "status": "PASS"},
        "approval_payload": None,
        "warnings": [],
    }


def main() -> None:
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    app = build_graph()
    result = app.invoke(_default_state(payload))
    print(json.dumps(result.get("approval_payload") or {}, ensure_ascii=False))


if __name__ == "__main__":
    main()


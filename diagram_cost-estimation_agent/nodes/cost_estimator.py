from __future__ import annotations

import json
from typing import Any

from models.llm_config import GroqLLM, load_prompt
from state import AgentState, CostLineItem
from tools.aws_pricing import estimate_cost, round_money


def _llm_estimate(resource_type: str, region: str) -> tuple[float, str]:
    llm = GroqLLM()
    system_prompt = load_prompt("system_prompt.txt")
    cost_prompt = load_prompt("cost_prompt.txt")
    payload = {"resource_type": resource_type, "region": region}
    out = llm.call_json(system_prompt, f"{cost_prompt}\n\nInput:\n{json.dumps(payload)}")
    monthly = round_money(float(out.get("monthly_usd", 0.0)))
    notes = str(out.get("notes", "LLM inferred estimate"))
    return monthly, notes


def run_cost_estimator(state: AgentState) -> AgentState:
    region = str((state.get("infra_plan") or {}).get("region") or "ap-south-1")
    nodes = list(state.get("diagram_nodes") or [])
    warnings = list(state.get("warnings") or [])
    line_items: list[CostLineItem] = []
    estimate_type = "live_runtime"
    total = 0.0

    for node in nodes:
        resource_type = str(node.get("type") or "").strip().lower()
        resource_id = str(node.get("id") or "").strip()
        known = estimate_cost(resource_type, region, "default")

        if known is not None:
            monthly, service, cost_type, notes = known
            if resource_type == "s3" and "LOG" in resource_id.upper():
                notes = "Log storage, minimal traffic"
            monthly = round_money(monthly)
            total += monthly
            if monthly > 0:
                line_items.append(
                    {
                        "service": service,
                        "resource_id": resource_id,
                        "type": cost_type,
                        "monthly_usd": monthly,
                        "notes": notes,
                    }
                )
            continue

        try:
            inferred_monthly, inferred_notes = _llm_estimate(resource_type, region)
            estimate_type = "llm_inferred"
            total += inferred_monthly
            if inferred_monthly > 0:
                line_items.append(
                    {
                        "service": "UnknownAWSService",
                        "resource_id": resource_id,
                        "type": "Inferred",
                        "monthly_usd": inferred_monthly,
                        "notes": inferred_notes,
                    }
                )
        except Exception as exc:
            warnings.append(f"Cost estimation fallback failed for {resource_id}: {exc}")

    return {
        **state,
        "cost_line_items": line_items,
        "total_monthly_usd": round_money(total),
        "estimate_type": estimate_type,
        "warnings": warnings,
    }

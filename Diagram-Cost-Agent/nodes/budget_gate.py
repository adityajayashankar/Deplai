from __future__ import annotations

from state import AgentState, BudgetGate


def evaluate_budget(total: float, cap: float) -> BudgetGate:
    if cap <= 0:
        percent = 100.0
    else:
        percent = round((total / cap) * 100, 1)
    if total > cap:
        status = "FAIL"
    elif percent >= 80:
        status = "WARN"
    else:
        status = "PASS"
    return {
        "cap_usd": round(float(cap), 2),
        "total_usd": round(float(total), 2),
        "percent_used": percent,
        "status": status,
    }


def run_budget_gate(state: AgentState) -> AgentState:
    total = float(state.get("total_monthly_usd") or 0.0)
    cap = float(state.get("budget_cap_usd") or 0.0)
    gate = evaluate_budget(total, cap)
    warnings = list(state.get("warnings") or [])

    if gate["status"] == "FAIL":
        warnings.append(f"Budget cap exceeded: ${total:.2f} > ${cap:.2f}. Human approval required.")
    elif gate["status"] == "WARN":
        warnings.append(f"Approaching budget cap: {gate['percent_used']}% used. Review before scaling.")

    return {
        **state,
        "budget_gate": gate,
        "warnings": warnings,
    }


"""LangGraph nodes for the infra advisor."""

from __future__ import annotations

from typing import Any

from infra_advisor.cost import estimate_decision_cost, evaluate_budget
from infra_advisor.design import (
    beginner_questions,
    build_all_tiers,
    build_repo_detection_summary,
    build_upgrade_suggestions,
    classify_intent,
    describe_changes,
    infer_detected_signals,
    looks_like_question,
    merge_requirements,
    parse_budget_from_text,
    parse_chat_intakes,
    parse_tier_choice,
    pick_affordable_tier,
    plain_component_list,
)
from infra_advisor.llm import call_advisor_chat
from infra_advisor.persistence import load_advisor_state
from infra_advisor.state import InfraAdvisorState


def _latest_user(messages: list[dict[str, Any]]) -> str:
    for item in reversed(messages or []):
        if isinstance(item, dict) and str(item.get("role") or "").lower() == "user":
            content = str(item.get("content") or "").strip()
            if content:
                return content
    return ""


def load_context(state: InfraAdvisorState) -> dict[str, Any]:
    workspace = str(state.get("workspace") or "default")
    persisted = load_advisor_state(workspace)
    messages = list(state.get("messages") or [])
    if not messages and isinstance(persisted.get("decision"), dict):
        # keep going with request messages only
        pass

    budget = state.get("budget_cap_usd")
    if budget is None or float(budget or 0) <= 0:
        budget = persisted.get("budget_cap_usd")
    requirements = dict(state.get("requirements") or {})
    if not requirements:
        requirements = dict(persisted.get("requirements") or {})

    prior = dict(state.get("prior_decision") or {})
    if not prior:
        prior = dict(persisted.get("decision") or {})

    selected_tier = str(state.get("selected_tier") or persisted.get("selected_tier") or "recommended")
    turn_count = max(int(state.get("turn_count") or 0), int(persisted.get("turn_count") or 0))

    detected = infer_detected_signals(
        architecture_json=dict(state.get("architecture_json") or {}),
        repository_context=dict(state.get("repo_context") or {}),
        deployment_profile=dict(state.get("deployment_profile") or {}),
        detected=dict(state.get("detected") or {}),
    )
    repo_summary = build_repo_detection_summary(detected)

    return {
        "budget_cap_usd": float(budget) if budget not in (None, "") else 0.0,
        "requirements": requirements,
        "prior_decision": prior,
        "selected_tier": selected_tier if selected_tier in {"baseline", "recommended", "resilient"} else "recommended",
        "turn_count": turn_count + 1,
        "detected": detected,
        "repo_detection_summary": repo_summary,
        "source": "infra_advisor",
        "ready": False,
        "open_questions": [],
        "upgrade_suggestions": list(persisted.get("upgrade_suggestions") or []),
        "change_notes": [],
    }


def understand_turn(state: InfraAdvisorState) -> dict[str, Any]:
    messages = list(state.get("messages") or [])
    intent = classify_intent(
        messages=messages,
        budget_cap_usd=float(state.get("budget_cap_usd") or 0),
        force_decision=bool(state.get("force_decision")),
    )
    latest = _latest_user(messages)
    updates: dict[str, Any] = {"intent": intent}

    budget_from_text = parse_budget_from_text(latest)
    if budget_from_text is not None:
        updates["budget_cap_usd"] = float(budget_from_text)
        intent = "set_budget" if intent == "clarify" else intent
        updates["intent"] = intent

    tier = parse_tier_choice(latest)
    if tier and intent in {"choose_tier", "refine", "answer"}:
        updates["selected_tier"] = tier
        updates["intent"] = "choose_tier"

    intakes = parse_chat_intakes(messages, dict(state.get("user_answers") or {}))
    requirements = merge_requirements(dict(state.get("requirements") or {}), messages, intakes)
    updates["intakes"] = intakes
    updates["requirements"] = requirements

    # Routing label for conditional edges
    if intent == "approve" or bool(state.get("force_decision")):
        updates["route"] = "finalize"
    elif float(updates.get("budget_cap_usd", state.get("budget_cap_usd") or 0) or 0) <= 0:
        updates["route"] = "ask"
    elif intent == "question":
        # Keep designing so answers can reference concrete sizes/components.
        updates["route"] = "design"
    elif intent in {"start", "clarify", "answer", "set_budget"} and beginner_questions(
        requirements,
        float(updates.get("budget_cap_usd", state.get("budget_cap_usd") or 0) or 0),
    ):
        budget_val = float(updates.get("budget_cap_usd", state.get("budget_cap_usd") or 0) or 0)
        qs = beginner_questions(requirements, budget_val)
        filled = sum(1 for key in ("audience", "traffic_band", "availability", "data_needs") if requirements.get(key))
        # Once budget + enough context exists, design even if one soft question remains.
        if budget_val > 0 and filled >= 2 and intent in {"answer", "set_budget", "refine"}:
            updates["route"] = "design"
            updates["open_questions"] = qs
        elif intent == "set_budget":
            updates["route"] = "ask" if qs else "design"
        elif intent in {"start", "clarify"}:
            updates["route"] = "ask"
        else:
            updates["route"] = "ask" if qs else "design"
    else:
        updates["route"] = "design"

    return updates


def ask_beginner_questions(state: InfraAdvisorState) -> dict[str, Any]:
    questions = beginner_questions(
        dict(state.get("requirements") or {}),
        float(state.get("budget_cap_usd") or 0),
    )
    return {
        "open_questions": questions,
        "ready": False,
        "decision": dict(state.get("decision") or state.get("prior_decision") or {}),
    }


def design_architecture(state: InfraAdvisorState) -> dict[str, Any]:
    detected = dict(state.get("detected") or {})
    requirements = dict(state.get("requirements") or {})
    intakes = dict(state.get("intakes") or {})
    region = str(state.get("region") or "eu-north-1")
    prior = dict(state.get("prior_decision") or {})
    preferred = str(state.get("selected_tier") or "recommended")
    budget = float(state.get("budget_cap_usd") or 0)

    tiers = build_all_tiers(
        detected=detected,
        base_intakes=intakes,
        requirements=requirements,
        deployment_profile=dict(state.get("deployment_profile") or {}),
        aws_region=region,
        prior_decision=prior or None,
        estimate_fn=estimate_decision_cost,
    )
    costs = dict(tiers.get("costs") or {})
    selected = pick_affordable_tier(costs, budget, preferred=preferred)
    # If user explicitly chose a tier, honor it even if over budget (upsell will explain).
    if state.get("intent") == "choose_tier" and preferred in tiers:
        selected = preferred
    decision = dict(tiers.get(selected) or {})
    change_notes = describe_changes(prior or None, decision)
    return {
        "plan_tiers": tiers,
        "selected_tier": selected,
        "decision": decision,
        "change_notes": change_notes,
        "open_questions": [],
    }


def estimate_cost_node(state: InfraAdvisorState) -> dict[str, Any]:
    decision = dict(state.get("decision") or {})
    estimate = estimate_decision_cost(decision)
    return {"cost_estimate": estimate}


def budget_fit(state: InfraAdvisorState) -> dict[str, Any]:
    estimate = dict(state.get("cost_estimate") or {})
    total = float(estimate.get("subtotal_monthly_usd") or 0)
    cap = float(state.get("budget_cap_usd") or 0)
    gate = evaluate_budget(total, cap)
    return {"budget_gate": gate}


def propose_tiers(state: InfraAdvisorState) -> dict[str, Any]:
    tiers = dict(state.get("plan_tiers") or {})
    costs = dict(tiers.get("costs") or {})
    selected = str(state.get("selected_tier") or "recommended")
    budget = float(state.get("budget_cap_usd") or 0)
    detected = dict(state.get("detected") or {})
    suggestions = build_upgrade_suggestions(
        selected_tier=selected,
        costs=costs,
        budget_cap_usd=budget,
        detected=detected,
    )

    # If over budget on selected, auto-shift to affordable unless user forced tier or approved.
    gate = dict(state.get("budget_gate") or {})
    updates: dict[str, Any] = {"upgrade_suggestions": suggestions}
    if (
        gate.get("status") == "FAIL"
        and state.get("intent") not in {"choose_tier", "approve"}
        and not bool(state.get("ready"))
    ):
        affordable = pick_affordable_tier(costs, budget, preferred="baseline")
        if affordable != selected and affordable in tiers:
            decision = dict(tiers.get(affordable) or {})
            estimate = estimate_decision_cost(decision)
            updates.update(
                {
                    "selected_tier": affordable,
                    "decision": decision,
                    "cost_estimate": estimate,
                    "budget_gate": evaluate_budget(float(estimate.get("subtotal_monthly_usd") or 0), budget),
                    "change_notes": list(state.get("change_notes") or [])
                    + [f"Adjusted to the {affordable} plan so it fits your budget."],
                }
            )
            updates["upgrade_suggestions"] = build_upgrade_suggestions(
                selected_tier=affordable,
                costs=costs,
                budget_cap_usd=budget,
                detected=detected,
            )
    return updates


def finalize_decision(state: InfraAdvisorState) -> dict[str, Any]:
    # Ensure we have a decision to lock
    decision = dict(state.get("decision") or {})
    if not decision:
        designed = design_architecture(state)
        decision = dict(designed.get("decision") or {})
        return {
            **designed,
            "decision": decision,
            "ready": True,
            "open_questions": [],
            "cost_estimate": estimate_decision_cost(decision),
            "budget_gate": evaluate_budget(
                float(estimate_decision_cost(decision).get("subtotal_monthly_usd") or 0),
                float(state.get("budget_cap_usd") or 0),
            ),
        }
    return {"ready": True, "open_questions": []}


def compose_reply(state: InfraAdvisorState) -> dict[str, Any]:
    questions = list(state.get("open_questions") or [])
    decision = dict(state.get("decision") or {})
    estimate = dict(state.get("cost_estimate") or {})
    gate = dict(state.get("budget_gate") or {})
    suggestions = list(state.get("upgrade_suggestions") or [])
    ready = bool(state.get("ready"))
    tier = str(state.get("selected_tier") or "recommended")
    budget = float(state.get("budget_cap_usd") or 0)
    intent = str(state.get("intent") or "")
    messages = list(state.get("messages") or [])
    latest = _latest_user(messages)
    turn_count = int(state.get("turn_count") or 0)
    prior_assistant = any(
        isinstance(m, dict) and str(m.get("role") or "").lower() == "assistant" and str(m.get("content") or "").strip()
        for m in messages
    )
    show_intro = turn_count <= 1 and not prior_assistant
    parts: list[str] = []

    # Prefer a direct LLM answer for free-form questions once a plan exists (or can be inferred).
    wants_direct_answer = intent == "question" or looks_like_question(latest)
    if wants_direct_answer and (decision.get("components") or budget > 0):
        llm_answer = call_advisor_chat(
            messages=messages,
            decision=decision,
            cost_estimate=estimate,
            budget_cap_usd=budget,
            selected_tier=tier,
            requirements=dict(state.get("requirements") or {}),
            open_questions=questions,
            repo_detection_summary=str(state.get("repo_detection_summary") or ""),
            llm_provider=state.get("llm_provider"),
            llm_api_key=state.get("llm_api_key"),
            llm_model=state.get("llm_model"),
            llm_api_base_url=state.get("llm_api_base_url"),
        )
        if llm_answer:
            footer: list[str] = []
            total = float(estimate.get("subtotal_monthly_usd") or gate.get("total_usd") or 0)
            if budget > 0 and total > 0:
                footer.append(f"Current plan estimate: ${total:.2f}/mo (budget ${budget:.2f}).")
            message = llm_answer if not footer else f"{llm_answer}\n\n" + "\n".join(footer)
            summary_lines = [
                f"Tier: {tier}",
                f"Components: {', '.join(str(x) for x in (decision.get('components') or []))}",
                f"Estimate: ${total:.2f}/mo",
                f"Budget: ${budget:.2f}/mo",
            ]
            return {
                "assistant_message": message,
                "decision_summary": "\n".join(summary_lines),
                "ready": ready or (bool(decision.get("components")) and not questions),
                "source": "infra_advisor_llm",
            }

    if questions and not decision.get("components"):
        if show_intro:
            parts.append("I'll set up AWS for your project in plain language - no cloud expertise needed.")
            parts.append("")
        if intent == "set_budget" and budget > 0:
            parts.append(f"Got it — I'll aim for about ${budget:.0f}/month.")
            parts.append("")
        if budget <= 0:
            parts.append(questions[0])
            parts.append("")
            parts.append("You can tap a budget chip or type something like \"$50\".")
        else:
            parts.append("A couple quick questions so the setup matches your app:")
            for idx, q in enumerate(questions, start=1):
                parts.append(f"{idx}. {q}")
        return {
            "assistant_message": "\n".join(parts),
            "decision_summary": "",
            "ready": False,
        }

    change_notes = list(state.get("change_notes") or [])
    if change_notes:
        parts.append("Updated based on what you said:")
        for note in change_notes:
            parts.append(f"- {note}")
        parts.append("")

    labels = plain_component_list(decision)
    tier_label = {"baseline": "simple", "recommended": "balanced", "resilient": "stay-online"}.get(tier, tier)
    parts.append(f"Here's a {tier_label} setup for your project:")
    if labels:
        parts.append("- " + "\n- ".join(labels))
    total = float(estimate.get("subtotal_monthly_usd") or gate.get("total_usd") or 0)
    if budget > 0:
        parts.append("")
        parts.append(f"Estimated monthly cost: ${total:.2f} (your budget: ${budget:.2f})")
        status = str(gate.get("status") or "")
        if status == "PASS":
            parts.append("This fits your budget.")
        elif status == "WARN":
            parts.append("This is close to your budget — still okay, but leave a little headroom.")
        elif status == "FAIL":
            gap = float(gate.get("gap_usd") or max(0.0, total - budget))
            parts.append(f"This is about ${gap:.2f}/mo over budget.")

    if suggestions:
        parts.append("")
        parts.append("If you increase the budget a bit, you can unlock:")
        for item in suggestions[:2]:
            extra = float(item.get("extra_monthly_usd") or 0)
            title = str(item.get("title") or "Upgrade")
            benefit = str(item.get("plain_benefit") or "")
            parts.append(f"- +${extra:.0f}/mo -> {title}: {benefit}")

    if questions and not ready:
        parts.append("")
        parts.append("Still need:")
        for idx, q in enumerate(questions, start=1):
            parts.append(f"{idx}. {q}")
    elif ready:
        parts.append("")
        parts.append("Ready when you are — approve to continue, or ask for a change in plain English.")
    else:
        parts.append("")
        parts.append("Want changes? Say things like \"cheaper\", \"more reliable\", \"remove the database\", or raise the budget.")

    # Deterministic fallback when LLM is unavailable but user asked a size/instance question.
    if wants_direct_answer:
        stack = dict(decision.get("stack_config") or {})
        ec2 = dict(stack.get("ec2") or {})
        instance = str(ec2.get("instance_type") or "").strip()
        if instance:
            disk_gb = ec2.get("root_volume_size_gb")
            disk_bit = f" with a {disk_gb}GB disk" if disk_gb else ""
            direct = (
                f"I'd configure the app server as {instance}{disk_bit}. "
                "That size matches this plan's traffic/budget; change it in Suggested settings if you want."
            )
            parts = [direct, ""] + parts

    summary_lines = [
        f"Tier: {tier}",
        f"Components: {', '.join(str(x) for x in (decision.get('components') or []))}",
        f"Estimate: ${total:.2f}/mo",
        f"Budget: ${budget:.2f}/mo",
    ]
    return {
        "assistant_message": "\n".join(parts),
        "decision_summary": "\n".join(summary_lines),
        "ready": ready or (bool(decision.get("components")) and not questions),
    }


def route_after_understand(state: InfraAdvisorState) -> str:
    route = str(state.get("route") or "design")
    if route == "finalize":
        return "finalize"
    if route == "ask":
        return "ask"
    return "design"

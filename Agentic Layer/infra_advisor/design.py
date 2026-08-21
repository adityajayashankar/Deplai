"""Intent parsing and tiered architecture design for beginners."""

from __future__ import annotations

import re
from typing import Any

from terraform_consult import (
    build_heuristic_decision,
    build_repo_detection_summary,
    infer_detected_signals,
    parse_chat_intakes,
    parse_message_deltas,
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _latest_user(messages: list[dict[str, Any]]) -> str:
    for item in reversed(messages or []):
        if not isinstance(item, dict):
            continue
        if _text(item.get("role")).lower() != "user":
            continue
        content = _text(item.get("content"))
        if content:
            return content
    return ""


def parse_budget_from_text(message: str) -> float | None:
    text = message.lower().strip()
    if not text:
        return None
    chip = re.fullmatch(r"\$?\s*(\d+(?:\.\d+)?)\s*(?:/mo|/month|usd)?", text)
    if chip:
        return float(chip.group(1))
    match = re.search(
        r"(?:budget|spend|cap|afford|month(?:ly)?)\D{0,20}\$?\s*(\d+(?:\.\d+)?)",
        text,
        re.I,
    )
    if match:
        return float(match.group(1))
    match = re.search(r"\$\s*(\d+(?:\.\d+)?)", text)
    if match:
        return float(match.group(1))
    return None


def looks_like_question(message: str) -> bool:
    text = _text(message).lower()
    if not text:
        return False
    if "?" in text:
        return True
    return bool(
        re.search(
            r"\b(which|what|why|how|when|should i|can you|could you|suggest|recommend|explain|tell me|"
            r"instance type|ec2 size|server size)\b",
            text,
        )
    )


def classify_intent(
    *,
    messages: list[dict[str, Any]],
    budget_cap_usd: float | None,
    force_decision: bool,
) -> str:
    latest = _latest_user(messages).lower()
    if force_decision or re.search(r"\b(approve|looks good|use this plan|lock it in|ship it|build this)\b", latest):
        return "approve"
    if re.search(r"\b(baseline|recommended|resilient|more resilient|cheapest|safer)\b", latest) and re.search(
        r"\b(tier|plan|option|choose|switch|use|pick)\b", latest
    ):
        return "choose_tier"
    if parse_budget_from_text(latest) is not None or re.search(r"\bbudget\b", latest):
        return "set_budget"
    if not budget_cap_usd or budget_cap_usd <= 0:
        return "clarify"
    if not messages or all(_text(m.get("role")).lower() != "user" for m in messages if isinstance(m, dict)):
        return "start"
    if looks_like_question(latest):
        return "question"
    if parse_message_deltas(latest):
        return "refine"
    if re.search(r"\b(yes|no|small|medium|large|hobby|production|friends|customers|ok|fine)\b", latest):
        return "answer"
    return "refine" if latest else "start"


def parse_tier_choice(message: str) -> str | None:
    text = message.lower()
    if "baseline" in text or "cheapest" in text or "minimal" in text:
        return "baseline"
    if "resilient" in text or "safer" in text or "ha" in text or "high availability" in text:
        return "resilient"
    if "recommended" in text or "balanced" in text or "default" in text:
        return "recommended"
    return None


def merge_requirements(
    existing: dict[str, Any],
    messages: list[dict[str, Any]],
    intakes: dict[str, Any],
) -> dict[str, Any]:
    req = dict(existing or {})
    latest = _latest_user(messages).lower()

    if intakes.get("peak_traffic") is not None or intakes.get("monthly_traffic") is not None:
        peak = int(intakes.get("peak_traffic") or 0)
        monthly = int(intakes.get("monthly_traffic") or 0)
        if peak >= 200 or monthly >= 100_000:
            req["traffic_band"] = "high"
        elif peak >= 50 or monthly >= 20_000:
            req["traffic_band"] = "medium"
        else:
            req["traffic_band"] = "low"
    else:
        user_match = re.search(r"\b(?:around|about|~)?\s*(\d+)\s*(?:people|users|concurrent)?\b", latest, re.I)
        if user_match and ("user" in latest or "people" in latest or "concurrent" in latest):
            peak = int(user_match.group(1))
            if peak >= 200:
                req["traffic_band"] = "high"
            elif peak >= 50:
                req["traffic_band"] = "medium"
            else:
                req["traffic_band"] = "low"
        elif re.search(r"\b(under\s*20|few users|just me|small)\b", latest):
            req["traffic_band"] = "low"
        elif re.search(r"\b(more than\s*200|lots of|high traffic)\b", latest):
            req["traffic_band"] = "high"

    if re.search(r"\b(hobby|friends|side project|just me|personal)\b", latest):
        req["audience"] = "personal"
    elif re.search(r"\b(customers|production|company|startup|users)\b", latest):
        req["audience"] = "customers"

    if re.search(r"\b(must stay up|no downtime|high availability|can't go down|cannot go down)\b", latest):
        req["availability"] = "high"
    elif re.search(r"\b(ok if down|fine if offline|downtime ok|single server)\b", latest):
        req["availability"] = "basic"

    if re.search(r"\b(keep my data|database|postgres|mysql|don't lose data|do not lose)\b", latest):
        req["data_needs"] = "managed"
    elif re.search(r"\b(no database|no db|sqlite|local data)\b", latest):
        req["data_needs"] = "none"

    if intakes.get("need_rds") is True:
        req["data_needs"] = "managed"
    if intakes.get("need_rds") is False:
        req["data_needs"] = "none"
    if intakes.get("ha") is True or intakes.get("need_alb") is True:
        req["availability"] = req.get("availability") or "high"
    if intakes.get("need_alb") is False and req.get("availability") != "high":
        req["availability"] = req.get("availability") or "basic"

    return req


def beginner_questions(requirements: dict[str, Any], budget_cap_usd: float | None) -> list[str]:
    questions: list[str] = []
    if not budget_cap_usd or budget_cap_usd <= 0:
        questions.append("About how much can you spend on AWS each month? (for example $25, $50, $100)")
        return questions[:2]
    if not requirements.get("audience"):
        questions.append("Is this mainly for you/friends, or for real customers?")
    if not requirements.get("traffic_band"):
        questions.append("About how many people might use it at the same time — under 20, around 50–200, or more?")
    if not requirements.get("availability"):
        questions.append("If the app goes down for a few hours, is that okay, or does it need to stay up?")
    if not requirements.get("data_needs"):
        questions.append("Do you need to keep user data safely in a database, or is this mostly a simple website?")
    return questions[:2]


def _tier_intakes(
    *,
    base_intakes: dict[str, Any],
    requirements: dict[str, Any],
    detected: dict[str, Any],
    tier: str,
) -> dict[str, Any]:
    intakes = dict(base_intakes)
    traffic = requirements.get("traffic_band") or "low"
    availability = requirements.get("availability") or "basic"
    data_needs = requirements.get("data_needs")
    if data_needs is None:
        data_needs = "managed" if detected.get("has_database") else "none"

    if tier == "baseline":
        intakes["need_alb"] = False
        intakes["need_eip"] = True
        intakes["ha"] = False
        intakes["need_rds"] = False
        intakes["need_redis"] = False
        intakes["instance_type"] = intakes.get("instance_type") or "t3.micro"
        if traffic == "high":
            intakes["instance_type"] = "t3.small"
    elif tier == "recommended":
        intakes["need_alb"] = traffic in {"medium", "high"} or availability == "high" or bool(intakes.get("need_alb"))
        intakes["need_eip"] = True if not intakes.get("need_alb") else bool(intakes.get("need_eip", True))
        intakes["ha"] = availability == "high" or traffic == "high"
        intakes["need_rds"] = data_needs == "managed" or bool(detected.get("has_database"))
        intakes["need_redis"] = bool(detected.get("has_redis")) and traffic != "low"
        intakes["instance_type"] = intakes.get("instance_type") or ("t3.small" if traffic != "low" else "t3.micro")
    else:  # resilient
        intakes["need_alb"] = True
        intakes["need_eip"] = True
        intakes["ha"] = True
        intakes["need_rds"] = data_needs != "none" or bool(detected.get("has_database"))
        intakes["need_redis"] = bool(detected.get("has_redis")) or traffic == "high"
        intakes["instance_type"] = intakes.get("instance_type") or "t3.small"

    # Preserve explicit chat refinements that don't fight the tier skeleton.
    if base_intakes.get("direct_port_routing") is False:
        intakes["direct_port_routing"] = False
        intakes["disabled_public_port"] = base_intakes.get("disabled_public_port")
    if base_intakes.get("app_port"):
        intakes["app_port"] = base_intakes["app_port"]
    if base_intakes.get("region"):
        intakes["region"] = base_intakes["region"]
    if base_intakes.get("root_volume_size_gb"):
        intakes["root_volume_size_gb"] = base_intakes["root_volume_size_gb"]
    return intakes


def design_tier_decision(
    *,
    tier: str,
    detected: dict[str, Any],
    base_intakes: dict[str, Any],
    requirements: dict[str, Any],
    deployment_profile: dict[str, Any] | None,
    aws_region: str,
    prior_decision: dict[str, Any] | None,
) -> dict[str, Any]:
    intakes = _tier_intakes(
        base_intakes=base_intakes,
        requirements=requirements,
        detected=detected,
        tier=tier,
    )
    decision = build_heuristic_decision(
        detected=detected,
        intakes=intakes,
        deployment_profile=deployment_profile,
        aws_region=aws_region,
        prior_decision=prior_decision,
    )
    # For resilient, force multi-az on rds when present.
    if tier == "resilient" and "rds" in (decision.get("components") or []):
        stack = dict(decision.get("stack_config") or {})
        rds = dict(stack.get("rds") or {})
        rds["multi_az"] = True
        stack["rds"] = rds
        decision["stack_config"] = stack
    decision["selected_tier"] = tier
    decision["intakes"] = intakes
    return decision


def build_all_tiers(
    *,
    detected: dict[str, Any],
    base_intakes: dict[str, Any],
    requirements: dict[str, Any],
    deployment_profile: dict[str, Any] | None,
    aws_region: str,
    prior_decision: dict[str, Any] | None,
    estimate_fn,
) -> dict[str, Any]:
    tiers: dict[str, Any] = {}
    costs: dict[str, float] = {}
    for tier in ("baseline", "recommended", "resilient"):
        decision = design_tier_decision(
            tier=tier,
            detected=detected,
            base_intakes=base_intakes,
            requirements=requirements,
            deployment_profile=deployment_profile,
            aws_region=aws_region,
            prior_decision=prior_decision,
        )
        cost = estimate_fn(decision)
        tiers[tier] = decision
        costs[tier] = float(cost.get("subtotal_monthly_usd") or 0.0)
    return {"baseline": tiers["baseline"], "recommended": tiers["recommended"], "resilient": tiers["resilient"], "costs": costs}


def pick_affordable_tier(costs: dict[str, float], budget_cap_usd: float, preferred: str = "recommended") -> str:
    order = ["baseline", "recommended", "resilient"]
    if preferred in order:
        # try preferred and below first, then higher if they fit
        candidates = [preferred] + [t for t in order if t != preferred]
    else:
        candidates = order
    affordable = [t for t in order if float(costs.get(t) or 0) <= float(budget_cap_usd or 0)]
    if preferred in affordable:
        return preferred
    if affordable:
        # richest affordable
        return affordable[-1]
    return "baseline"


def build_upgrade_suggestions(
    *,
    selected_tier: str,
    costs: dict[str, float],
    budget_cap_usd: float,
    detected: dict[str, Any],
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    cap = float(budget_cap_usd or 0)
    current = float(costs.get(selected_tier) or 0)

    def add(tier: str, title: str, benefit: str, unlocks: list[str]) -> None:
        target = float(costs.get(tier) or 0)
        extra = round(max(0.0, target - cap if target > cap else target - current), 2)
        if target <= current and tier != selected_tier:
            extra = round(max(0.0, target - current), 2)
        if tier == selected_tier:
            return
        if target <= cap and tier in {"recommended", "resilient"} and order_index(tier) > order_index(selected_tier):
            suggestions.append(
                {
                    "extra_monthly_usd": round(max(0.0, target - current), 2),
                    "title": title,
                    "plain_benefit": benefit,
                    "unlocks": unlocks,
                    "tier": tier,
                }
            )
        elif target > cap:
            suggestions.append(
                {
                    "extra_monthly_usd": round(target - cap, 2),
                    "title": title,
                    "plain_benefit": benefit,
                    "unlocks": unlocks,
                    "tier": tier,
                }
            )

    def order_index(tier: str) -> int:
        return {"baseline": 0, "recommended": 1, "resilient": 2}.get(tier, 0)

    if selected_tier == "baseline":
        add(
            "recommended",
            "Balanced production setup",
            "Adds safer networking and a managed database when your app needs one.",
            ["load_balancer_if_needed", "managed_database"],
        )
        add(
            "resilient",
            "Stay-online setup",
            "Keeps the app reachable if one piece fails, with stronger database protection.",
            ["load_balancer", "multi_az_database", "stable_address"],
        )
    elif selected_tier == "recommended":
        add(
            "resilient",
            "Stay-online upgrade",
            "Adds failover so customers are less likely to see downtime.",
            ["multi_az_database", "load_balancer"],
        )

    if detected.get("has_database") and selected_tier == "baseline":
        # emphasize DB upsell
        for item in suggestions:
            if item.get("tier") == "recommended":
                item["plain_benefit"] = "Your project looks like it needs a database — this unlocks a managed one AWS keeps healthy."
                break

    # Deduplicate / keep top 3
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in suggestions:
        key = str(item.get("tier") or item.get("title"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique[:3]


def plain_component_list(decision: dict[str, Any]) -> list[str]:
    mapping = {
        "vpc": "private cloud network",
        "ec2": "app server",
        "alb": "traffic distributor (keeps the site reachable as traffic grows)",
        "eip": "stable public address",
        "rds": "managed database",
        "elasticache": "managed cache",
        "ecs": "container service",
    }
    stack = dict((decision or {}).get("stack_config") or {})
    ec2 = dict(stack.get("ec2") or {})
    rds = dict(stack.get("rds") or {})
    redis = dict(stack.get("elasticache") or stack.get("redis") or {})
    labels: list[str] = []
    for item in decision.get("components") or []:
        key = str(item).strip().lower()
        label = mapping.get(key, key.replace("_", " "))
        if key == "ec2" and ec2.get("instance_type"):
            label = f"app server ({ec2.get('instance_type')}"
            if ec2.get("root_volume_size_gb"):
                label += f", {ec2.get('root_volume_size_gb')}GB disk"
            label += ")"
        elif key == "rds":
            bits = [str(rds.get("engine") or "sql").strip()]
            if rds.get("instance_class") or rds.get("instance_type"):
                bits.append(str(rds.get("instance_class") or rds.get("instance_type")))
            label = f"managed database ({', '.join(bits)})"
        elif key in {"elasticache", "redis"} and redis.get("node_type"):
            label = f"managed cache ({redis.get('node_type')})"
        labels.append(label)
    return labels


def describe_changes(prior: dict[str, Any] | None, current: dict[str, Any]) -> list[str]:
    if not prior:
        return []
    before = set(str(x).lower() for x in (prior.get("components") or []))
    after = set(str(x).lower() for x in (current.get("components") or []))
    notes: list[str] = []
    added = sorted(after - before)
    removed = sorted(before - after)
    label = {
        "alb": "traffic distributor",
        "eip": "stable public address",
        "rds": "managed database",
        "elasticache": "managed cache",
        "ec2": "app server",
        "vpc": "network",
    }
    if added:
        notes.append("Added: " + ", ".join(label.get(x, x) for x in added) + ".")
    if removed:
        notes.append("Removed: " + ", ".join(label.get(x, x) for x in removed) + ".")
    return notes[:4]


# Re-export consult helpers used by nodes
__all__ = [
    "beginner_questions",
    "build_all_tiers",
    "build_repo_detection_summary",
    "build_upgrade_suggestions",
    "classify_intent",
    "describe_changes",
    "design_tier_decision",
    "infer_detected_signals",
    "looks_like_question",
    "merge_requirements",
    "parse_budget_from_text",
    "parse_chat_intakes",
    "parse_message_deltas",
    "parse_tier_choice",
    "pick_affordable_tier",
    "plain_component_list",
]

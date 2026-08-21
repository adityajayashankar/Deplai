"""Deterministic monthly cost estimate from a consultant decision."""

from __future__ import annotations

from typing import Any

HOURS = 730.0

_HOURLY = {
    "t3.micro": 0.0104,
    "t3.small": 0.0208,
    "t3.medium": 0.0416,
    "t3.large": 0.0832,
    "db.t3.micro": 0.026,
    "db.t3.small": 0.052,
    "cache.t4g.micro": 0.016,
    "cache.t3.micro": 0.021,
    "alb": 0.0225,
    "eip": 0.005,
    "vpc": 0.006,
    "nat": 0.062,
}

_EBS_GB_MONTH = 0.08


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _components(decision: dict[str, Any]) -> list[str]:
    raw = decision.get("components") or []
    if not isinstance(raw, list):
        return []
    return [str(item).strip().lower() for item in raw if str(item).strip()]


def estimate_decision_cost(decision: dict[str, Any]) -> dict[str, Any]:
    stack = _record(decision.get("stack_config"))
    components = _components(decision)
    line_items: list[dict[str, Any]] = []
    total = 0.0

    def add(component: str, label: str, monthly: float, note: str = "") -> None:
        nonlocal total
        monthly = round(float(monthly), 2)
        if monthly <= 0:
            return
        total += monthly
        line_items.append(
            {
                "component": component,
                "label": label,
                "hourly_usd": round(monthly / HOURS, 6),
                "monthly_usd": monthly,
                "note": note,
                "source": "fallback",
            }
        )

    if "vpc" in components or True:
        add("vpc", "Networking baseline", _HOURLY["vpc"] * HOURS, "VPC/subnets baseline")

    ec2 = _record(stack.get("ec2"))
    instance = str(ec2.get("instance_type") or "t3.micro").lower()
    desired = int(ec2.get("desired_count") or 1)
    root_gb = float(ec2.get("root_volume_size_gb") or 35)
    compute_hourly = _HOURLY.get(instance, _HOURLY["t3.micro"]) * max(1, desired)
    add("ec2", f"App server ({instance})", compute_hourly * HOURS, f"{desired} instance(s)")
    add("ebs", "Disk storage", root_gb * _EBS_GB_MONTH * max(1, desired), f"{int(root_gb)}GB gp3")

    if "alb" in components or decision.get("need_alb"):
        add("alb", "Load balancer", _HOURLY["alb"] * HOURS, "Application Load Balancer")
        # small LCU allowance
        add("alb_lcu", "Load balancer capacity", _HOURLY["alb"] * 0.35 * HOURS, "Light traffic LCUs")

    if "eip" in components or decision.get("need_eip"):
        add("eip", "Stable public address", _HOURLY["eip"] * HOURS, "Elastic IP")

    if "rds" in components:
        rds = _record(stack.get("rds"))
        klass = str(rds.get("instance_class") or "db.t3.micro").lower()
        multi = 2.0 if rds.get("multi_az") else 1.0
        hourly = _HOURLY.get(klass, _HOURLY["db.t3.micro"]) * multi
        add("rds", "Managed database", hourly * HOURS, "Multi-AZ" if multi > 1 else "Single-AZ")

    if "elasticache" in components or "redis" in components:
        cache = _record(stack.get("elasticache"))
        node = str(cache.get("node_type") or "cache.t4g.micro").lower()
        hourly = _HOURLY.get(node, _HOURLY["cache.t4g.micro"])
        add("redis", "Managed cache", hourly * HOURS, node)

    networking = _record(stack.get("networking"))
    if networking.get("nat_gateway"):
        add("nat", "Private network gateway", _HOURLY["nat"] * HOURS, "NAT gateway")

    return {
        "currency": "USD",
        "source": "fallback",
        "line_items": line_items,
        "subtotal_monthly_usd": round(total, 2),
    }


def evaluate_budget(total: float, cap: float) -> dict[str, Any]:
    cap = float(cap or 0.0)
    total = float(total or 0.0)
    if cap <= 0:
        percent = 100.0
        status = "WARN"
        gap = 0.0
    else:
        percent = round((total / cap) * 100, 1)
        gap = round(max(0.0, total - cap), 2)
        if total > cap:
            status = "FAIL"
        elif percent >= 80:
            status = "WARN"
        else:
            status = "PASS"
    return {
        "cap_usd": round(cap, 2),
        "total_usd": round(total, 2),
        "percent_used": percent,
        "status": status,
        "gap_usd": gap,
    }

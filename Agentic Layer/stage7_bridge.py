from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cost_estimation import estimate_cost
from planning_runtime import repo_root


AWS_REGION_LABELS = {
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ap-south-2": "Asia Pacific (Hyderabad)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "eu-north-1": "Europe (Stockholm)",
    "eu-west-1": "Europe (Ireland)",
    "eu-west-2": "Europe (London)",
    "eu-central-1": "Europe (Frankfurt)",
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-2": "US West (Oregon)",
}


def _normalize_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def _aws_region_label(region: str) -> str:
    normalized = str(region or "").strip().lower()
    return AWS_REGION_LABELS.get(normalized, "Europe (Stockholm)")


def _estimate_stage7_costs(
    *,
    region: str,
    compute: str,
    services: list[str],
    storage: list[str],
    database: str,
    cache: str,
    cdn: str,
) -> tuple[list[dict[str, Any]], float, list[str], str]:
    region_label = _aws_region_label(region)
    pricing_nodes: list[dict[str, Any]] = []
    line_items, total_monthly, cost_warnings, estimate_type = _estimate_stage7_costs(
        region=region,
        compute=compute,
        services=services,
        storage=storage,
        database=database,
        cache=cache,
        cdn=cdn,
    )
    warnings: list[str] = []

    if "website_bucket" in storage:
        pricing_nodes.append(
            {
                "id": "WEBSITEBUCKET",
                "type": "AmazonS3",
                "label": "Website Bucket",
                "region": region_label,
                "attributes": {
                    "storageGB": 10,
                    "storageClass": "Standard",
                    "numPUTRequests": 1000,
                    "numGETRequests": 10000,
                },
            }
        )

    if compute == "ec2":
        for service in services or ["app"]:
            pricing_nodes.append(
                {
                    "id": f"{service.upper()}SERVER",
                    "type": "AmazonEC2",
                    "label": service.replace("_", " ").title(),
                    "region": region_label,
                    "attributes": {
                        "instanceType": "t3.micro",
                        "instanceCount": 1,
                        "operatingSystem": "Linux",
                        "tenancy": "Shared",
                        "capacitystatus": "Used",
                        "preInstalledSw": "NA",
                        "termType": "OnDemand",
                        "storageGB": 20,
                        "volumeType": "gp3",
                    },
                }
            )
    elif compute == "lambda":
        for service in services or ["app"]:
            pricing_nodes.append(
                {
                    "id": f"{service.upper()}FUNCTION",
                    "type": "AWSLambda",
                    "label": service.replace("_", " ").title(),
                    "region": region_label,
                    "attributes": {
                        "requestsPerMonth": 1_000_000,
                        "memorySizeMB": 256,
                        "durationMs": 250,
                    },
                }
            )

    if database == "rds":
        pricing_nodes.append(
            {
                "id": "RDS",
                "type": "AmazonRDS",
                "label": "Primary PostgreSQL",
                "region": region_label,
                "attributes": {
                    "instanceType": "db.t3.micro",
                    "databaseEngine": "PostgreSQL",
                    "termType": "OnDemand",
                    "storageGB": 20,
                    "storageType": "gp3",
                },
            }
        )

    estimate = estimate_cost({"nodes": pricing_nodes, "edges": []}, provider="aws")
    total_monthly = 0.0

    for item in estimate.get("breakdown") or []:
        if not isinstance(item, dict):
            continue
        detail = item.get("detail") if isinstance(item.get("detail"), dict) else {}
        used_fallback = bool(detail.get("fallback_pricing_used")) if isinstance(detail, dict) else False
        notes = "Estimated via AWS Pricing API."
        if used_fallback:
            notes = "AWS Pricing API did not return a direct match, so fallback heuristic pricing was used."
        line_items.append(
            {
                "service": str(item.get("service") or ""),
                "resource_id": str(item.get("node_id") or ""),
                "type": "AWS Pricing API",
                "monthly_usd": round(float(item.get("monthly_usd") or 0.0), 2),
                "notes": notes,
            }
        )
        total_monthly += float(item.get("monthly_usd") or 0.0)

    for err in estimate.get("errors") or []:
        warnings.append(str(err))

    if estimate.get("note"):
        warnings.append(str(estimate["note"]))

    if cdn == "cloudfront":
        line_items.append(
            {
                "service": "AmazonCloudFront",
                "resource_id": "CLOUDFRONT",
                "type": "Heuristic",
                "monthly_usd": 8.50,
                "notes": "Baseline distribution + transfer estimate.",
            }
        )
        total_monthly += 8.50

    if compute == "ecs":
        line_items.append(
            {
                "service": "AmazonECS",
                "resource_id": "ECSCLUSTER",
                "type": "Heuristic",
                "monthly_usd": 18.40,
                "notes": "Baseline Fargate/ECS control-plane estimate.",
            }
        )
        total_monthly += 18.40
        for service in services or ["api"]:
            line_items.append(
                {
                    "service": "AWSFargate",
                    "resource_id": f"{service.upper()}SERVICE",
                    "type": "Heuristic",
                    "monthly_usd": 12.25,
                    "notes": f"Baseline runtime estimate for {service}.",
                }
            )
            total_monthly += 12.25

    if cache == "elasticache":
        line_items.append(
            {
                "service": "AmazonElastiCache",
                "resource_id": "CACHE",
                "type": "Heuristic",
                "monthly_usd": 15.20,
                "notes": "cache.t3.small baseline.",
            }
        )
        total_monthly += 15.20

    estimate_type = "aws_pricing_api"
    if any(item.get("type") == "Heuristic" for item in line_items) or warnings:
        estimate_type = "aws_pricing_api_hybrid"

    return line_items, round(total_monthly, 2), warnings, estimate_type


def _stage7_fallback_payload(
    *,
    infra_plan: dict[str, Any],
    budget_cap_usd: float,
    pipeline_run_id: str,
    environment: str,
    warning: str,
) -> dict[str, Any]:
    region = str(infra_plan.get("region") or "eu-north-1").strip() or "eu-north-1"
    compute = str(infra_plan.get("compute") or "").strip().lower()
    services = _normalize_list(infra_plan.get("services"))
    storage = _normalize_list(infra_plan.get("storage"))
    security_groups = _normalize_list(infra_plan.get("security_groups"))
    database = str(infra_plan.get("database") or "").strip().lower()
    cache = str(infra_plan.get("cache") or "").strip().lower()
    cdn = str(infra_plan.get("cdn") or "").strip().lower()

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    line_items: list[dict[str, Any]] = []

    def add_node(node_id: str, label: str, node_type: str, color: str, existing: bool = False) -> None:
        if any(existing_node.get("id") == node_id for existing_node in nodes):
            return
        nodes.append(
            {
                "id": node_id,
                "label": label,
                "type": node_type,
                "color": color,
                "existing": existing,
            }
        )

    def add_edge(from_id: str, to_id: str, style: str = "solid") -> None:
        edge = {"from": from_id, "to": to_id, "style": style}
        if edge not in edges:
            edges.append(edge)

    if "website_bucket" in storage:
        add_node("WEBSITEBUCKET", "Website Bucket", "s3", "amber")

    if cdn == "cloudfront":
        add_node("CLOUDFRONT", "CloudFront", "cloudfront", "cyan")
        if any(node["id"] == "WEBSITEBUCKET" for node in nodes):
            add_edge("CLOUDFRONT", "WEBSITEBUCKET")

    if compute == "ec2":
        for service in services or ["app"]:
            node_id = f"{service.upper()}SERVER"
            add_node(node_id, service.replace("_", " ").title(), "ec2", "green")
    elif compute == "ecs":
        add_node("ECSCLUSTER", "ECS Cluster", "ecs", "green")
        for service in services or ["api"]:
            node_id = f"{service.upper()}SERVICE"
            add_node(node_id, service.replace("_", " ").title(), "service", "green")
            add_edge("ECSCLUSTER", node_id)
    elif compute == "lambda":
        for service in services or ["app"]:
            node_id = f"{service.upper()}FUNCTION"
            add_node(node_id, service.replace("_", " ").title(), "lambda", "green")

    for group in security_groups:
        group_id = group.upper()
        add_node(group_id, group.replace("_", " ").title(), "security_group", "gray")
        for node in list(nodes):
            if node["type"] in {"ec2", "service", "lambda"}:
                add_edge(group_id, node["id"])

    if database == "rds":
        add_node("RDS", "Rds", "rds", "purple")
        for node in list(nodes):
            if node["type"] in {"ec2", "service", "lambda"}:
                add_edge(node["id"], "RDS")

    if cache == "elasticache":
        add_node("CACHE", "Redis Cache", "elasticache", "orange")
        for node in list(nodes):
            if node["type"] in {"ec2", "service", "lambda"}:
                add_edge(node["id"], "CACHE")

    percent_used = round((total_monthly / budget_cap_usd) * 100, 1) if budget_cap_usd > 0 else 0.0
    budget_status = "PASS" if budget_cap_usd <= 0 or total_monthly <= budget_cap_usd else "FAIL"

    return {
        "stage": "7",
        "stage_label": "Generate diagram + estimate_cost",
        "pipeline_run_id": pipeline_run_id,
        "environment": environment,
        "diagram": {
            "nodes": nodes,
            "edges": edges,
            "region": region,
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
        "cost_estimate": {
            "line_items": line_items,
            "total_monthly_usd": total_monthly,
            "currency": "USD",
            "estimate_type": estimate_type,
        },
        "budget_gate": {
            "cap_usd": round(float(budget_cap_usd), 2),
            "total_usd": total_monthly,
            "percent_used": percent_used,
            "status": budget_status,
        },
        "warnings": [warning, *cost_warnings],
        "approval_required": True,
        "next_stage": "8",
        "next_stage_label": "Generate Terraform + Ansible",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def run_stage7_approval_payload(
    *,
    infra_plan: dict[str, Any],
    budget_cap_usd: float = 100.0,
    pipeline_run_id: str = "",
    environment: str = "dev",
) -> dict[str, Any]:
    agent_dir = repo_root() / "diagram_cost-estimation_agent"
    runner = agent_dir / "run_stage7.py"
    if not runner.exists():
        return _stage7_fallback_payload(
            infra_plan=infra_plan,
            budget_cap_usd=float(budget_cap_usd or 100.0),
            pipeline_run_id=str(pipeline_run_id or ""),
            environment=str(environment or "dev"),
            warning="Stage7 agent runner not found. Using deterministic fallback payload.",
        )

    payload = {
        "infra_plan": infra_plan,
        "budget_cap_usd": float(budget_cap_usd or 100.0),
        "pipeline_run_id": str(pipeline_run_id or ""),
        "environment": str(environment or "dev"),
    }

    proc = subprocess.run(
        [sys.executable, str(runner)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=str(agent_dir),
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        tail_err = (proc.stderr or "").strip()[-1500:]
        return _stage7_fallback_payload(
            infra_plan=infra_plan,
            budget_cap_usd=float(budget_cap_usd or 100.0),
            pipeline_run_id=str(pipeline_run_id or ""),
            environment=str(environment or "dev"),
            warning=f"Stage7 agent failed. Using deterministic fallback payload. Details: {tail_err or 'unknown subprocess error'}",
        )
    raw = (proc.stdout or "").strip()
    if not raw:
        return _stage7_fallback_payload(
            infra_plan=infra_plan,
            budget_cap_usd=float(budget_cap_usd or 100.0),
            pipeline_run_id=str(pipeline_run_id or ""),
            environment=str(environment or "dev"),
            warning="Stage7 agent returned empty output. Using deterministic fallback payload.",
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        return _stage7_fallback_payload(
            infra_plan=infra_plan,
            budget_cap_usd=float(budget_cap_usd or 100.0),
            pipeline_run_id=str(pipeline_run_id or ""),
            environment=str(environment or "dev"),
            warning=f"Stage7 agent returned invalid JSON. Using deterministic fallback payload. Details: {exc}",
        )

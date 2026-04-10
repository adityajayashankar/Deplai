from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

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

RDS_BASELINES = {
    "db.t3.micro": {"ap-south-1": 28.08, "us-east-1": 25.55},
    "db.t3.small": {"ap-south-1": 56.16, "us-east-1": 51.10},
    "db.t3.medium": {"ap-south-1": 112.32, "us-east-1": 102.20},
    "db.r6g.large": {"ap-south-1": 215.00, "us-east-1": 196.00},
}

REDIS_BASELINES = {
    "cache.t3.micro": {"ap-south-1": 13.14, "us-east-1": 11.52},
    "cache.t3.small": {"ap-south-1": 17.35, "us-east-1": 15.20},
    "cache.t3.medium": {"ap-south-1": 34.70, "us-east-1": 30.40},
    "cache.r6g.large": {"ap-south-1": 138.00, "us-east-1": 121.00},
}

ALB_BASELINES = {"ap-south-1": 20.10, "us-east-1": 18.40}
NAT_BASELINES = {"ap-south-1": 39.50, "us-east-1": 32.85}
ECR_BASELINES = {"ap-south-1": 1.20, "us-east-1": 0.90}
FARGATE_WEB_BASELINES = {"ap-south-1": 23.00, "us-east-1": 23.00}
FARGATE_WORKER_BASELINES = {"ap-south-1": 15.50, "us-east-1": 15.50}


def _normalize_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _region_value(values: dict[str, float], region: str) -> float:
    normalized = str(region or "").strip().lower()
    if normalized in values:
        return float(values[normalized])
    if "us-east-1" in values:
        return float(values["us-east-1"])
    return float(next(iter(values.values())))


def _service_profiles(infra_plan: dict[str, Any], services: list[str]) -> list[dict[str, Any]]:
    raw_profiles = infra_plan.get("service_profiles") if isinstance(infra_plan.get("service_profiles"), list) else []
    profiles: list[dict[str, Any]] = []
    for raw in raw_profiles:
        if not isinstance(raw, dict):
            continue
        service_id = str(raw.get("id") or "").strip()
        if not service_id:
            continue
        profiles.append(
            {
                "id": service_id,
                "port": raw.get("port"),
                "desired_count": int(raw.get("desired_count") or 1),
            }
        )
    if profiles:
        return profiles
    return [
        {
            "id": service,
            "port": 3000 if "api" in service.lower() or "web" in service.lower() else None,
            "desired_count": 2 if "api" in service.lower() or "web" in service.lower() else 1,
        }
        for service in (services or ["api"])
    ]


def _estimate_stage7_costs(
    *,
    region: str,
    compute: str,
    services: list[str],
    service_profiles: list[dict[str, Any]],
    storage: list[str],
    database: str,
    database_config: dict[str, Any],
    cache: str,
    cache_config: dict[str, Any],
    cdn: str,
    networking: str,
    networking_config: dict[str, Any],
    container_registry: str,
    task_definitions: list[str],
) -> tuple[list[dict[str, Any]], float, list[str], str]:
    line_items: list[dict[str, Any]] = []
    warnings: list[str] = []
    total_monthly = 0.0
    service_profiles = service_profiles or _service_profiles({"service_profiles": service_profiles}, services)

    if "website_bucket" in storage:
        line_items.append(
            {
                "service": "AmazonS3",
                "resource_id": "WEBSITEBUCKET",
                "type": "Heuristic",
                "monthly_usd": 0.23,
                "notes": "Baseline ~10GB static/object storage.",
            }
        )
        total_monthly += 0.23

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

    if str(networking_config.get("load_balancer") or "").strip().lower() == "alb":
        alb_monthly = round(_region_value(ALB_BASELINES, region), 2)
        line_items.append(
            {
                "service": "ElasticLoadBalancing",
                "resource_id": "APPLICATIONLOADBALANCER",
                "type": "Heuristic",
                "monthly_usd": alb_monthly,
                "notes": "Baseline ALB hourly + light LCU usage.",
            }
        )
        total_monthly += alb_monthly

    if networking == "custom_vpc" and bool(networking_config.get("nat_gateway")):
        nat_monthly = round(_region_value(NAT_BASELINES, region), 2)
        line_items.append(
            {
                "service": "AmazonVPC",
                "resource_id": "NATGATEWAY",
                "type": "Heuristic",
                "monthly_usd": nat_monthly,
                "notes": "Single NAT gateway baseline with light egress.",
            }
        )
        total_monthly += nat_monthly

    if compute == "ecs":
        for service in service_profiles:
            service_id = str(service.get("id") or "api")
            is_web = service.get("port") not in {None, "", 0}
            desired_count = int(service.get("desired_count") or (2 if is_web else 1))
            baseline = _region_value(FARGATE_WEB_BASELINES if is_web else FARGATE_WORKER_BASELINES, region)
            monthly = round(baseline * desired_count, 2)
            line_items.append(
                {
                    "service": "AWSFargate",
                    "resource_id": f"{service_id.upper()}SERVICE",
                    "type": "Heuristic",
                    "monthly_usd": monthly,
                    "notes": f"Baseline runtime estimate for {service_id} with {desired_count} task(s).",
                }
            )
            total_monthly += monthly
        for task_definition in task_definitions:
            line_items.append(
                {
                    "service": "AmazonECS",
                    "resource_id": f"{task_definition.upper()}TASKDEF",
                    "type": "Informational",
                    "monthly_usd": 0.00,
                    "notes": "Task definitions do not add direct monthly runtime cost.",
                }
            )

    if database == "rds":
        instance_class = str(database_config.get("instance_class") or "db.t3.small")
        db_monthly = round(_region_value(RDS_BASELINES.get(instance_class, RDS_BASELINES["db.t3.small"]), region), 2)
        line_items.append(
            {
                "service": "AmazonRDS",
                "resource_id": "PRIMARYDATABASE",
                "type": "Heuristic",
                "monthly_usd": db_monthly,
                "notes": f"{instance_class} PostgreSQL primary baseline.",
            }
        )
        total_monthly += db_monthly
        if bool(database_config.get("multi_az")):
            line_items.append(
                {
                    "service": "AmazonRDS",
                    "resource_id": "STANDBYDATABASE",
                    "type": "Heuristic",
                    "monthly_usd": db_monthly,
                    "notes": f"{instance_class} PostgreSQL standby baseline for Multi-AZ.",
                }
            )
            total_monthly += db_monthly

    if cache == "elasticache":
        node_type = str(cache_config.get("node_type") or "cache.t3.small")
        cache_monthly = round(_region_value(REDIS_BASELINES.get(node_type, REDIS_BASELINES["cache.t3.small"]), region), 2)
        line_items.append(
            {
                "service": "AmazonElastiCache",
                "resource_id": "CACHECLUSTER",
                "type": "Heuristic",
                "monthly_usd": cache_monthly,
                "notes": f"{node_type} Redis baseline.",
            }
        )
        total_monthly += cache_monthly

    if container_registry == "ecr":
        ecr_monthly = round(_region_value(ECR_BASELINES, region), 2)
        line_items.append(
            {
                "service": "AmazonECR",
                "resource_id": "ECRREPOSITORY",
                "type": "Heuristic",
                "monthly_usd": ecr_monthly,
                "notes": "Small private repository storage baseline.",
            }
        )
        total_monthly += ecr_monthly

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
    service_profiles = _service_profiles(infra_plan, services)
    storage = _normalize_list(infra_plan.get("storage"))
    security_groups = _normalize_list(infra_plan.get("security_groups"))
    database = str(infra_plan.get("database") or "").strip().lower()
    database_config = _as_dict(infra_plan.get("database_config"))
    cache = str(infra_plan.get("cache") or "").strip().lower()
    cache_config = _as_dict(infra_plan.get("cache_config"))
    cdn = str(infra_plan.get("cdn") or "").strip().lower()
    networking = str(infra_plan.get("networking") or "").strip().lower()
    networking_config = _as_dict(infra_plan.get("networking_config"))
    container_registry = str(infra_plan.get("container_registry") or "").strip().lower()
    task_definitions = _normalize_list(infra_plan.get("task_definitions"))
    line_items, total_monthly, cost_warnings, estimate_type = _estimate_stage7_costs(
        region=region,
        compute=compute,
        services=services,
        service_profiles=service_profiles,
        storage=storage,
        database=database,
        database_config=database_config,
        cache=cache,
        cache_config=cache_config,
        cdn=cdn,
        networking=networking,
        networking_config=networking_config,
        container_registry=container_registry,
        task_definitions=task_definitions,
    )

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

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

    if networking == "custom_vpc":
        add_node("APPLICATIONVPC", "Application VPC", "vpc", "gray")
        for index in range(int(networking_config.get("public_subnets") or 0)):
            subnet_id = f"PUBLICSUBNET{index + 1}"
            add_node(subnet_id, f"Public Subnet {index + 1}", "subnet", "gray")
            add_edge("APPLICATIONVPC", subnet_id, "dashed")
        for index in range(int(networking_config.get("private_subnets") or 0)):
            subnet_id = f"PRIVATESUBNET{index + 1}"
            add_node(subnet_id, f"Private Subnet {index + 1}", "subnet", "gray")
            add_edge("APPLICATIONVPC", subnet_id, "dashed")
        if networking_config.get("internet_gateway"):
            add_node("INTERNETGATEWAY", "Internet Gateway", "igw", "gray")
            add_edge("APPLICATIONVPC", "INTERNETGATEWAY", "dashed")
        if networking_config.get("nat_gateway"):
            add_node("NATGATEWAY", "NAT Gateway", "nat_gateway", "gray")
            add_edge("APPLICATIONVPC", "NATGATEWAY", "dashed")
            if any(node["id"] == "PUBLICSUBNET1" for node in nodes):
                add_edge("PUBLICSUBNET1", "NATGATEWAY", "dashed")
        if str(networking_config.get("load_balancer") or "").strip().lower() == "alb":
            add_node("APPLICATIONLOADBALANCER", "Application Load Balancer", "alb", "orange")
            if any(node["id"] == "PUBLICSUBNET1" for node in nodes):
                add_edge("PUBLICSUBNET1", "APPLICATIONLOADBALANCER", "dashed")

    if compute == "ec2":
        for service in services or ["app"]:
            node_id = f"{service.upper()}SERVER"
            add_node(node_id, service.replace("_", " ").title(), "ec2", "green")
    elif compute == "ecs":
        add_node("ECSCLUSTER", "ECS Cluster", "ecs", "green")
        for service in service_profiles:
            service_id = str(service.get("id") or "api")
            node_id = f"{service_id.upper()}SERVICE"
            add_node(node_id, f"{service_id.replace('_', ' ').title()} Service", "service", "green")
            add_edge("ECSCLUSTER", node_id)
            if service_id in task_definitions:
                task_id = f"{service_id.upper()}TASKDEF"
                add_node(task_id, f"{service_id.replace('_', ' ').title()} Task Definition", "task_definition", "green")
                add_edge(task_id, node_id, "dashed")
            if str(service.get("port") or "").strip() and any(node["id"] == "APPLICATIONLOADBALANCER" for node in nodes):
                add_edge("APPLICATIONLOADBALANCER", node_id, "solid")
        if container_registry == "ecr":
            add_node("ECRREPOSITORY", "ECR Repository", "ecr", "amber")
            for service_id in task_definitions:
                add_edge("ECRREPOSITORY", f"{service_id.upper()}TASKDEF", "dashed")
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
        add_node("PRIMARYDATABASE", "Primary PostgreSQL", "rds", "purple")
        if bool(database_config.get("multi_az")):
            add_node("STANDBYDATABASE", "Standby PostgreSQL (Multi-AZ)", "rds", "purple")
            add_edge("PRIMARYDATABASE", "STANDBYDATABASE", "dashed")
        for node in list(nodes):
            if node["type"] in {"ec2", "service", "lambda"}:
                add_edge(node["id"], "PRIMARYDATABASE")

    if cache == "elasticache":
        add_node("CACHECLUSTER", "Redis Cache", "elasticache", "orange")
        for node in list(nodes):
            if node["type"] in {"ec2", "service", "lambda"}:
                add_edge(node["id"], "CACHECLUSTER")

    for private_subnet in [node["id"] for node in nodes if node["id"].startswith("PRIVATESUBNET")]:
        for target in [node["id"] for node in nodes if node["type"] in {"ecs", "service", "rds", "elasticache"}]:
            add_edge(private_subnet, target, "dashed")

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
    agent_dir = repo_root() / "Diagram-Cost-Agent"
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
        warning_detail = tail_err or "unknown subprocess error"
        if "ModuleNotFoundError" in warning_detail:
            warning_detail = "Stage7 graph runtime dependencies are unavailable in this environment"
        return _stage7_fallback_payload(
            infra_plan=infra_plan,
            budget_cap_usd=float(budget_cap_usd or 100.0),
            pipeline_run_id=str(pipeline_run_id or ""),
            environment=str(environment or "dev"),
            warning=f"Stage7 agent failed. Using deterministic fallback payload. Details: {warning_detail}",
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

from __future__ import annotations

import re
from typing import Any, Iterable

from state import DiagramEdge, DiagramNode


COLOR_BY_TYPE: dict[str, str] = {
    "cloudfront": "teal",
    "cloudwatch": "teal",
    "s3": "amber",
    "ec2": "green",
    "ecs": "green",
    "service": "green",
    "task_definition": "green",
    "lambda": "green",
    "rds": "purple",
    "elasticache": "purple",
    "vpc": "gray",
    "subnet": "gray",
    "security_group": "gray",
    "igw": "gray",
    "nat_gateway": "gray",
    "alb": "orange",
    "ecr": "amber",
}


def _make_id(raw: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", raw).upper()


def _make_node(node_id: str, label: str, node_type: str, existing: bool) -> DiagramNode:
    return {
        "id": node_id,
        "label": label,
        "type": node_type,
        "color": COLOR_BY_TYPE.get(node_type, "coral"),
        "existing": existing,
    }


def _dedupe_nodes(nodes: Iterable[DiagramNode]) -> list[DiagramNode]:
    out: list[DiagramNode] = []
    seen: set[str] = set()
    for node in nodes:
        node_id = node["id"]
        if node_id in seen:
            continue
        seen.add(node_id)
        out.append(node)
    return out


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list_from(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def _service_node_id(service_id: str) -> str:
    return f"{_make_id(service_id)}SERVICE"


def _task_definition_id(service_id: str) -> str:
    return f"{_make_id(service_id)}TASKDEF"


def _build_service_descriptors(plan: dict[str, Any]) -> list[dict[str, Any]]:
    services = _list_from(plan.get("services"))
    profiles = plan.get("service_profiles") if isinstance(plan.get("service_profiles"), list) else []
    descriptors: list[dict[str, Any]] = []
    for raw in profiles:
        if not isinstance(raw, dict):
            continue
        service_id = str(raw.get("id") or "").strip()
        if not service_id:
            continue
        descriptors.append(
            {
                "id": service_id,
                "port": raw.get("port"),
                "desired_count": int(raw.get("desired_count") or 1),
                "cpu": int(raw.get("cpu") or 0),
                "memory": int(raw.get("memory") or 0),
            }
        )
    if descriptors:
        return descriptors
    return [
        {
            "id": service_id,
            "port": 3000 if "api" in service_id.lower() or "web" in service_id.lower() else None,
            "desired_count": 2 if "api" in service_id.lower() or "web" in service_id.lower() else 1,
            "cpu": 0,
            "memory": 0,
        }
        for service_id in services
    ]


def infra_plan_to_nodes(plan: dict) -> list[DiagramNode]:
    nodes: list[DiagramNode] = []
    compute = str(plan.get("compute") or "").strip().lower()
    networking = str(plan.get("networking") or "").strip().lower()
    networking_config = _as_dict(plan.get("networking_config"))
    cdn = str(plan.get("cdn") or "").strip().lower()
    logging = str(plan.get("logging") or "").strip().lower()
    database = str(plan.get("database") or "").strip().lower()
    database_config = _as_dict(plan.get("database_config"))
    cache = str(plan.get("cache") or "").strip().lower()
    cache_config = _as_dict(plan.get("cache_config"))
    container_registry = str(plan.get("container_registry") or "").strip().lower()
    storage = [str(v).strip() for v in (plan.get("storage") or []) if str(v).strip()]
    security_groups = [str(v).strip() for v in (plan.get("security_groups") or []) if str(v).strip()]
    services = _build_service_descriptors(plan)
    task_definitions = _list_from(plan.get("task_definitions"))

    if cdn == "cloudfront":
        nodes.append(_make_node("CLOUDFRONTDISTRIBUTION", "CloudFront Distribution", "cloudfront", False))

    for item in storage:
        key = item.lower()
        if "website" in key:
            nodes.append(_make_node("WEBSITEBUCKET", "Website Bucket", "s3", False))
        elif "log" in key:
            nodes.append(_make_node("SECURITYLOGSBUCKET", "Security Logs Bucket", "s3", False))
        else:
            rid = _make_id(item)
            label = item.replace("_", " ").title()
            nodes.append(_make_node(rid, label, "s3", "default" in rid.lower()))

    if networking == "default_vpc":
        nodes.append(_make_node("DEFAULTVPC", "Default VPC (existing)", "vpc", True))
        nodes.append(_make_node("DEFAULTSUBNET", "Default Subnet (existing)", "subnet", True))
    elif networking:
        vpc_node = _make_node("APPLICATIONVPC", "Application VPC", "vpc", False)
        vpc_node["pricing_tier"] = "custom_vpc" if networking == "custom_vpc" else "existing_vpc"
        nodes.append(vpc_node)
        public_subnets = int(networking_config.get("public_subnets") or 0)
        private_subnets = int(networking_config.get("private_subnets") or 0)
        for index in range(public_subnets):
            subnet = _make_node(f"PUBLICSUBNET{index + 1}", f"Public Subnet {index + 1}", "subnet", False)
            subnet["subnet_role"] = "public"
            nodes.append(subnet)
        for index in range(private_subnets):
            subnet = _make_node(f"PRIVATESUBNET{index + 1}", f"Private Subnet {index + 1}", "subnet", False)
            subnet["subnet_role"] = "private"
            nodes.append(subnet)
        if networking_config.get("internet_gateway"):
            nodes.append(_make_node("INTERNETGATEWAY", "Internet Gateway", "igw", False))
        if networking_config.get("nat_gateway"):
            nat_node = _make_node("NATGATEWAY", "NAT Gateway", "nat_gateway", False)
            nat_node["pricing_tier"] = "single_nat"
            nodes.append(nat_node)
        if str(networking_config.get("load_balancer") or "").strip().lower() == "alb":
            alb_node = _make_node("APPLICATIONLOADBALANCER", "Application Load Balancer", "alb", False)
            alb_node["pricing_tier"] = "application_alb"
            nodes.append(alb_node)

    if compute == "ec2":
        label = "Web Server" if any("web_server" == item["id"].lower() for item in services) else "EC2 Instance"
        nodes.append(_make_node("WEBAPPSERVER", label, "ec2", False))
    elif compute == "ecs":
        nodes.append(_make_node("ECSCLUSTER", "ECS Cluster", "ecs", False))
        for service in services:
            label = f"{service['id'].replace('_', ' ').title()} Service"
            node = _make_node(_service_node_id(service["id"]), label, "service", False)
            node["pricing_tier"] = "web" if service.get("port") else "worker"
            node["desired_count"] = int(service.get("desired_count") or 1)
            node["cpu"] = int(service.get("cpu") or 0)
            node["memory"] = int(service.get("memory") or 0)
            nodes.append(node)
        for service_id in task_definitions or [service["id"] for service in services]:
            task_node = _make_node(_task_definition_id(service_id), f"{service_id.replace('_', ' ').title()} Task Definition", "task_definition", False)
            task_node["pricing_tier"] = "task_definition"
            nodes.append(task_node)
    elif compute == "lambda":
        nodes.append(_make_node("LAMBDAFUNCTION", "Lambda Function", "lambda", False))

    for sg in security_groups:
        key = _make_id(sg)
        label = "Web Security Group" if key == "WEBSECURITYGROUP" else sg.replace("_", " ").title()
        nodes.append(_make_node(key, label, "security_group", "default" in key.lower()))

    if logging == "cloudwatch":
        nodes.append(_make_node("CLOUDWATCHLOGGROUP", "CloudWatch Log Group", "cloudwatch", False))

    if database and database not in {"none", "null"}:
        primary = _make_node("PRIMARYDATABASE", "Primary PostgreSQL", "rds", False)
        primary["pricing_tier"] = str(database_config.get("instance_class") or "db.t3.small")
        primary["role"] = "primary"
        nodes.append(primary)
        if bool(database_config.get("multi_az")):
            standby = _make_node("STANDBYDATABASE", "Standby PostgreSQL (Multi-AZ)", "rds", False)
            standby["pricing_tier"] = str(database_config.get("instance_class") or "db.t3.small")
            standby["role"] = "standby"
            nodes.append(standby)

    if cache and cache not in {"none", "null"}:
        cache_node = _make_node("CACHECLUSTER", "Redis Cache", "elasticache", False)
        cache_node["pricing_tier"] = str(cache_config.get("node_type") or "cache.t3.small")
        nodes.append(cache_node)

    if container_registry == "ecr":
        ecr_node = _make_node("ECRREPOSITORY", "ECR Repository", "ecr", False)
        ecr_node["pricing_tier"] = "small_repository"
        nodes.append(ecr_node)

    return _dedupe_nodes(nodes)


def infer_edges(nodes: list[DiagramNode]) -> list[DiagramEdge]:
    by_type: dict[str, list[DiagramNode]] = {}
    for node in nodes:
        by_type.setdefault(node["type"], []).append(node)

    edges: list[DiagramEdge] = []

    def add_edge(from_id: str, to_id: str, style: str) -> None:
        candidate: DiagramEdge = {"from_node": from_id, "to_node": to_id, "style": style}
        if candidate not in edges:
            edges.append(candidate)

    service_nodes = by_type.get("service", [])
    compute_nodes = by_type.get("ec2", []) + by_type.get("lambda", []) + service_nodes
    public_subnets = [node for node in by_type.get("subnet", []) if node.get("subnet_role") == "public"]
    private_subnets = [node for node in by_type.get("subnet", []) if node.get("subnet_role") == "private"]

    for cfront in by_type.get("cloudfront", []):
        s3_nodes = by_type.get("s3", [])
        if s3_nodes:
            preferred = next((n for n in s3_nodes if "WEBSITE" in n["id"]), s3_nodes[0])
            add_edge(cfront["id"], preferred["id"], "dashed")
        for backend in by_type.get("ec2", []) + service_nodes:
            add_edge(cfront["id"], backend["id"], "dashed")

    for vpc in by_type.get("vpc", []):
        for subnet in by_type.get("subnet", []):
            add_edge(vpc["id"], subnet["id"], "dashed")
        for igw in by_type.get("igw", []):
            add_edge(vpc["id"], igw["id"], "dashed")
        for nat in by_type.get("nat_gateway", []):
            add_edge(vpc["id"], nat["id"], "dashed")
        for compute in compute_nodes + by_type.get("ecs", []):
            add_edge(vpc["id"], compute["id"], "dashed")

    for nat in by_type.get("nat_gateway", []):
        if public_subnets:
            add_edge(public_subnets[0]["id"], nat["id"], "dashed")
        for private_subnet in private_subnets:
            add_edge(nat["id"], private_subnet["id"], "dashed")

    for alb in by_type.get("alb", []):
        if public_subnets:
            add_edge(public_subnets[0]["id"], alb["id"], "dashed")
        api_targets = [node for node in service_nodes if "api" in node["id"].lower() or "web" in node["id"].lower()] or service_nodes[:1]
        for target in api_targets:
            add_edge(alb["id"], target["id"], "solid")

    for cluster in by_type.get("ecs", []):
        for service in service_nodes:
            add_edge(cluster["id"], service["id"], "solid")

    for task in by_type.get("task_definition", []):
        service_id = task["id"].replace("TASKDEF", "")
        for service in service_nodes:
            if service["id"].replace("SERVICE", "") == service_id:
                add_edge(task["id"], service["id"], "dashed")

    for ecr in by_type.get("ecr", []):
        for task in by_type.get("task_definition", []):
            add_edge(ecr["id"], task["id"], "dashed")

    for compute in compute_nodes:
        for db in by_type.get("rds", []):
            if db.get("role") == "standby":
                continue
            add_edge(compute["id"], db["id"], "solid")
        for cache in by_type.get("elasticache", []):
            add_edge(compute["id"], cache["id"], "solid")
        for cw in by_type.get("cloudwatch", []):
            add_edge(compute["id"], cw["id"], "dashed")

    primary_db = next((node for node in by_type.get("rds", []) if node.get("role") == "primary"), None)
    standby_db = next((node for node in by_type.get("rds", []) if node.get("role") == "standby"), None)
    if primary_db and standby_db:
        add_edge(primary_db["id"], standby_db["id"], "dashed")

    for private_subnet in private_subnets:
        for target in by_type.get("rds", []) + by_type.get("elasticache", []) + by_type.get("ecs", []) + service_nodes:
            add_edge(private_subnet["id"], target["id"], "dashed")

    api_nodes = [node for node in service_nodes if "api" in node["id"].lower()]
    worker_nodes = [node for node in service_nodes if "worker" in node["id"].lower()]
    for api_node in api_nodes:
        for worker in worker_nodes:
            add_edge(api_node["id"], worker["id"], "solid")

    return edges

from __future__ import annotations

import re
from typing import Iterable

from state import DiagramEdge, DiagramNode


COLOR_BY_TYPE: dict[str, str] = {
    "cloudfront": "teal",
    "cloudwatch": "teal",
    "s3": "amber",
    "ec2": "green",
    "ecs": "green",
    "lambda": "green",
    "rds": "purple",
    "elasticache": "purple",
    "vpc": "gray",
    "subnet": "gray",
    "security_group": "gray",
    "igw": "gray",
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


def infra_plan_to_nodes(plan: dict) -> list[DiagramNode]:
    nodes: list[DiagramNode] = []
    compute = str(plan.get("compute") or "").strip().lower()
    networking = str(plan.get("networking") or "").strip().lower()
    cdn = str(plan.get("cdn") or "").strip().lower()
    logging = str(plan.get("logging") or "").strip().lower()
    database = str(plan.get("database") or "").strip().lower()
    cache = str(plan.get("cache") or "").strip().lower()
    storage = [str(v).strip() for v in (plan.get("storage") or []) if str(v).strip()]
    security_groups = [str(v).strip() for v in (plan.get("security_groups") or []) if str(v).strip()]
    services = [str(v).strip() for v in (plan.get("services") or []) if str(v).strip()]

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

    if compute == "ec2":
        label = "Web Server" if "web_server" in [s.lower() for s in services] else "EC2 Instance"
        nodes.append(_make_node("WEBAPPSERVER", label, "ec2", False))
    elif compute == "ecs":
        nodes.append(_make_node("ECSCLUSTER", "ECS Cluster", "ecs", False))
    elif compute == "lambda":
        nodes.append(_make_node("LAMBDAFUNCTION", "Lambda Function", "lambda", False))

    if networking == "default_vpc":
        nodes.append(_make_node("DEFAULTVPC", "Default VPC (existing)", "vpc", True))
        nodes.append(_make_node("DEFAULTSUBNET", "Default Subnet (existing)", "subnet", True))
    elif networking:
        nodes.append(_make_node(_make_id(networking), networking.replace("_", " ").title(), "vpc", "default" in networking))

    for sg in security_groups:
        key = _make_id(sg)
        label = sg.replace("_", " ").title()
        if key == "WEBSECURITYGROUP":
            label = "Web Security Group"
        nodes.append(_make_node(key, label, "security_group", "default" in key.lower()))

    if logging == "cloudwatch":
        nodes.append(_make_node("CLOUDWATCHLOGGROUP", "CloudWatch Log Group", "cloudwatch", False))

    if database and database not in {"none", "null"}:
        nodes.append(_make_node(_make_id(database), database.replace("_", " ").title(), "rds", False))

    if cache and cache not in {"none", "null"}:
        nodes.append(_make_node(_make_id(cache), cache.replace("_", " ").title(), "elasticache", False))

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

    for cfront in by_type.get("cloudfront", []):
        s3_nodes = by_type.get("s3", [])
        if s3_nodes:
            preferred = next((n for n in s3_nodes if "WEBSITE" in n["id"]), s3_nodes[0])
            add_edge(cfront["id"], preferred["id"], "dashed")
        for backend in by_type.get("ec2", []) + by_type.get("ecs", []):
            add_edge(cfront["id"], backend["id"], "dashed")

    for compute in by_type.get("ec2", []) + by_type.get("ecs", []):
        for vpc in by_type.get("vpc", []):
            add_edge(compute["id"], vpc["id"], "dashed")
        for db in by_type.get("rds", []):
            add_edge(compute["id"], db["id"], "solid")
        for cache in by_type.get("elasticache", []):
            add_edge(compute["id"], cache["id"], "solid")
        for cw in by_type.get("cloudwatch", []):
            add_edge(compute["id"], cw["id"], "dashed")

    for vpc in by_type.get("vpc", []):
        for subnet in by_type.get("subnet", []):
            add_edge(vpc["id"], subnet["id"], "dashed")

    ecs_nodes = by_type.get("ecs", [])
    api_nodes = [n for n in ecs_nodes if "api" in n["id"].lower() or "api" in n["label"].lower()]
    worker_nodes = [n for n in ecs_nodes if "worker" in n["id"].lower() or "worker" in n["label"].lower()]
    for api_node in api_nodes:
        for worker in worker_nodes:
            add_edge(api_node["id"], worker["id"], "solid")

    return edges


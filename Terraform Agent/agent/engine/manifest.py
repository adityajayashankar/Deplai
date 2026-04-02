from __future__ import annotations

from collections import deque
from typing import Any


RESOURCE_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("cloudfront", "cdn"), "aws_cloudfront_distribution"),
    (("origin access control", "oac"), "aws_cloudfront_origin_access_control"),
    (("s3", "bucket", "storage"), "aws_s3_bucket"),
    (("ec2", "instance", "compute"), "aws_instance"),
    (("rds", "postgres", "database", "db"), "aws_db_instance"),
    (("dynamodb",), "aws_dynamodb_table"),
    (("vpc",), "aws_vpc"),
    (("subnet",), "aws_subnet"),
    (("security group", "security"), "aws_security_group"),
    (("secret", "secrets manager"), "aws_secretsmanager_secret"),
]


def infer_resource_type(node_type: str, attributes: dict[str, Any] | None = None) -> str:
    raw = f"{node_type} {' '.join(sorted((attributes or {}).keys()))}".lower()
    for needles, resource_type in RESOURCE_HINTS:
        if any(needle in raw for needle in needles):
            return resource_type
    return "aws_resource"


def _component_config(node: dict[str, Any]) -> dict[str, Any]:
    config = {}
    attrs = node.get("attributes")
    if isinstance(attrs, dict):
        config.update(attrs)
    for key in ("label", "region"):
        value = node.get(key)
        if value is not None:
            config[key] = value
    metadata = node.get("metadata")
    if isinstance(metadata, dict):
        config["metadata"] = metadata
    return config


def build_manifest(architecture_json: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    nodes = architecture_json.get("nodes")
    edges = architecture_json.get("edges")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("architecture_json.nodes must contain at least one node")

    component_ids: set[str] = set()
    raw_components: dict[str, dict[str, Any]] = {}
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("architecture_json.nodes items must be objects")
        component_id = str(node.get("id") or "").strip()
        if not component_id:
            raise ValueError("architecture_json node id is required")
        if component_id in component_ids:
            raise ValueError(f"Duplicate component id: {component_id}")
        component_ids.add(component_id)
        node_type = str(node.get("type") or "").strip()
        resource_type = infer_resource_type(node_type, node.get("attributes") if isinstance(node.get("attributes"), dict) else {})
        raw_components[component_id] = {
            "id": component_id,
            "type": resource_type,
            "strategy": None,
            "dependencies": [],
            "config": _component_config(node),
            "doc_url": None,
            "knowledge_key": None,
        }

    if edges is None:
        edges = []
    if not isinstance(edges, list):
        raise ValueError("architecture_json.edges must be an array")

    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError("architecture_json.edges items must be objects")
        source = str(edge.get("from") or "").strip()
        target = str(edge.get("to") or "").strip()
        if not source or not target:
            raise ValueError("architecture_json edges must define from and to")
        if source not in raw_components or target not in raw_components:
            raise ValueError(f"Edge references unknown node(s): {source} -> {target}")
        deps: list[str] = raw_components[source]["dependencies"]
        if target not in deps:
            deps.append(target)

    ordered = topological_sort(list(raw_components.values()))
    return ordered, [component["id"] for component in ordered]


def topological_sort(components: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {str(component["id"]): component for component in components}
    indegree = {component_id: 0 for component_id in by_id}
    outgoing: dict[str, list[str]] = {component_id: [] for component_id in by_id}

    for component_id, component in by_id.items():
        deps = component.get("dependencies") if isinstance(component.get("dependencies"), list) else []
        normalized_deps: list[str] = []
        for dep in deps:
            dep_id = str(dep)
            if dep_id not in by_id:
                raise ValueError(f"Unknown dependency referenced by {component_id}: {dep_id}")
            normalized_deps.append(dep_id)
            indegree[component_id] += 1
            outgoing[dep_id].append(component_id)
        component["dependencies"] = normalized_deps

    queue = deque(sorted((component_id for component_id, degree in indegree.items() if degree == 0)))
    ordered: list[dict[str, Any]] = []
    while queue:
        current = queue.popleft()
        ordered.append(by_id[current])
        for child in sorted(outgoing[current]):
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)

    if len(ordered) != len(components):
        unresolved = sorted(component_id for component_id, degree in indegree.items() if degree > 0)
        raise ValueError(f"Circular dependencies detected: {', '.join(unresolved)}")

    return ordered

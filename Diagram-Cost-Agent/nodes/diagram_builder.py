from __future__ import annotations

import json
from typing import Any

from models.llm_config import GroqLLM, load_prompt
from state import AgentState, DiagramEdge, DiagramNode
from tools.diagram_builder_tools import infer_edges, infra_plan_to_nodes


_KNOWN_VALUES = {
    "ec2",
    "ecs",
    "lambda",
    "cloudfront",
    "default_vpc",
    "custom_vpc",
    "existing_vpc",
    "cloudwatch",
    "rds",
    "elasticache",
    "ecr",
    "alb",
    "web_server",
    "website_bucket",
    "security_logs_bucket",
    "none",
    "null",
}


def _extract_unknown_values(infra_plan: dict[str, Any]) -> list[str]:
    discovered: set[str] = set()
    for key, value in infra_plan.items():
        if isinstance(value, list):
            for item in value:
                if isinstance(item, (dict, list)):
                    continue
                token = str(item).strip().lower()
                if token and token not in _KNOWN_VALUES:
                    discovered.add(token)
            continue
        if isinstance(value, dict):
            continue
        token = str(value).strip().lower()
        if token and token not in _KNOWN_VALUES and key != "region":
            discovered.add(token)
    return sorted(discovered)


def _merge_nodes(base: list[DiagramNode], extra: list[dict[str, Any]]) -> list[DiagramNode]:
    out = list(base)
    seen = {node["id"] for node in out}
    for raw in extra:
        node_id = str(raw.get("id", "")).strip()
        if not node_id or node_id in seen:
            continue
        node: DiagramNode = {
            "id": node_id,
            "label": str(raw.get("label", node_id)),
            "type": str(raw.get("type", "unknown")),
            "color": str(raw.get("color", "coral")),
            "existing": bool(raw.get("existing", False)),
        }
        out.append(node)
        seen.add(node_id)
    return out


def _merge_edges(base: list[DiagramEdge], extra: list[dict[str, Any]]) -> list[DiagramEdge]:
    out = list(base)
    seen = {(edge["from_node"], edge["to_node"], edge["style"]) for edge in out}
    for raw in extra:
        from_node = str(raw.get("from_node") or raw.get("from") or "").strip()
        to_node = str(raw.get("to_node") or raw.get("to") or "").strip()
        style = str(raw.get("style") or "dashed").strip()
        if not from_node or not to_node:
            continue
        key = (from_node, to_node, style)
        if key in seen:
            continue
        out.append({"from_node": from_node, "to_node": to_node, "style": style})
        seen.add(key)
    return out


def run_diagram_builder(state: AgentState) -> AgentState:
    plan = dict(state.get("infra_plan") or {})
    nodes = infra_plan_to_nodes(plan)
    edges = infer_edges(nodes)
    warnings = list(state.get("warnings") or [])

    unknown_values = _extract_unknown_values(plan)
    if unknown_values:
        try:
            llm = GroqLLM()
            system_prompt = load_prompt("system_prompt.txt")
            diagram_prompt = load_prompt("diagram_prompt.txt")
            user_payload = {
                "infra_plan": plan,
                "unknown_values": unknown_values,
                "existing_nodes": nodes,
                "existing_edges": edges,
            }
            llm_output = llm.call_json(system_prompt, f"{diagram_prompt}\n\nInput:\n{json.dumps(user_payload)}")
            nodes = _merge_nodes(nodes, llm_output.get("nodes", []))
            edges = _merge_edges(edges, llm_output.get("edges", []))
        except Exception as exc:
            warnings.append(f"Diagram LLM fallback skipped: {exc}")

    return {
        **state,
        "diagram_nodes": nodes,
        "diagram_edges": edges,
        "warnings": warnings,
    }

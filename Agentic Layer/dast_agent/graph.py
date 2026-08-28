"""Compile the LangGraph DAST orchestration graph."""

from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from dast_agent import nodes
from dast_agent.state import DASTAgentState


def build_dast_graph():
    graph = StateGraph(DASTAgentState)

    graph.add_node("load_scan_context", nodes.load_scan_context)
    graph.add_node("validate_project_access", nodes.validate_project_access)
    graph.add_node("resolve_target_asset", nodes.resolve_target_asset)
    graph.add_node("validate_target_authorization", nodes.validate_target_authorization)
    graph.add_node("verify_target_scope", nodes.verify_target_scope)
    graph.add_node("perform_ssrf_safety_validation", nodes.perform_ssrf_safety_validation)
    graph.add_node("build_scan_plan", nodes.build_scan_plan)
    graph.add_node("checkpoint_before_scan", nodes.checkpoint_before_scan)
    graph.add_node("launch_zap", nodes.launch_zap)
    graph.add_node("monitor_zap", nodes.monitor_zap)
    graph.add_node("retry_scan", nodes.retry_scan)
    graph.add_node("collect_zap_results", nodes.collect_zap_results)
    graph.add_node("normalize_findings", nodes.normalize_findings)
    graph.add_node("evaluate_compliance", nodes.evaluate_compliance)
    graph.add_node("persist_results", nodes.persist_results)
    graph.add_node("persist_audit_evidence", nodes.persist_audit_evidence)
    graph.add_node("finalize_scan", nodes.finalize_scan)
    graph.add_node("authorization_failed", nodes.authorization_failed)
    graph.add_node("scope_failed", nodes.scope_failed)
    graph.add_node("safety_failed", nodes.safety_failed)

    graph.add_edge(START, "load_scan_context")
    graph.add_edge("load_scan_context", "validate_project_access")
    graph.add_edge("validate_project_access", "resolve_target_asset")
    graph.add_edge("resolve_target_asset", "validate_target_authorization")
    graph.add_conditional_edges(
        "validate_target_authorization",
        nodes.route_after_auth,
        {
            "authorization_failed": "authorization_failed",
            "verify_target_scope": "verify_target_scope",
        },
    )
    graph.add_conditional_edges(
        "verify_target_scope",
        nodes.route_after_scope,
        {
            "scope_failed": "scope_failed",
            "perform_ssrf_safety_validation": "perform_ssrf_safety_validation",
        },
    )
    graph.add_conditional_edges(
        "perform_ssrf_safety_validation",
        nodes.route_after_ssrf,
        {
            "safety_failed": "safety_failed",
            "build_scan_plan": "build_scan_plan",
        },
    )
    graph.add_conditional_edges(
        "build_scan_plan",
        nodes.route_after_plan,
        {
            "authorization_failed": "authorization_failed",
            "checkpoint_before_scan": "checkpoint_before_scan",
        },
    )
    graph.add_edge("checkpoint_before_scan", "launch_zap")
    graph.add_conditional_edges(
        "launch_zap",
        nodes.route_after_launch,
        {
            "authorization_failed": "authorization_failed",
            "collect_zap_results": "collect_zap_results",
            "monitor_zap": "monitor_zap",
            "retry_scan": "retry_scan",
        },
    )
    graph.add_conditional_edges(
        "monitor_zap",
        nodes.route_after_monitor,
        {
            "retry_scan": "retry_scan",
            "collect_zap_results": "collect_zap_results",
        },
    )
    graph.add_edge("retry_scan", "launch_zap")
    graph.add_edge("collect_zap_results", "normalize_findings")
    graph.add_edge("normalize_findings", "evaluate_compliance")
    graph.add_edge("evaluate_compliance", "persist_results")
    graph.add_edge("persist_results", "persist_audit_evidence")
    graph.add_edge("authorization_failed", "persist_audit_evidence")
    graph.add_edge("scope_failed", "persist_audit_evidence")
    graph.add_edge("safety_failed", "persist_audit_evidence")
    graph.add_edge("persist_audit_evidence", "finalize_scan")
    graph.add_edge("finalize_scan", END)

    return graph.compile(checkpointer=MemorySaver())


_GRAPH = None


def get_dast_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_dast_graph()
    return _GRAPH

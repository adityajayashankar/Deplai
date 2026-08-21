"""Compile the LangGraph infra advisor."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from infra_advisor.nodes import (
    ask_beginner_questions,
    budget_fit,
    compose_reply,
    design_architecture,
    estimate_cost_node,
    finalize_decision,
    load_context,
    propose_tiers,
    route_after_understand,
    understand_turn,
)
from infra_advisor.state import InfraAdvisorState


def build_infra_advisor_graph():
    graph = StateGraph(InfraAdvisorState)

    graph.add_node("load_context", load_context)
    graph.add_node("understand_turn", understand_turn)
    graph.add_node("ask_beginner_questions", ask_beginner_questions)
    graph.add_node("design_architecture", design_architecture)
    graph.add_node("estimate_cost", estimate_cost_node)
    graph.add_node("budget_fit", budget_fit)
    graph.add_node("propose_tiers", propose_tiers)
    graph.add_node("finalize_decision", finalize_decision)
    graph.add_node("compose_reply", compose_reply)

    graph.add_edge(START, "load_context")
    graph.add_edge("load_context", "understand_turn")
    graph.add_conditional_edges(
        "understand_turn",
        route_after_understand,
        {
            "ask": "ask_beginner_questions",
            "design": "design_architecture",
            "finalize": "finalize_decision",
        },
    )
    graph.add_edge("ask_beginner_questions", "compose_reply")
    graph.add_edge("design_architecture", "estimate_cost")
    graph.add_edge("estimate_cost", "budget_fit")
    graph.add_edge("budget_fit", "propose_tiers")
    graph.add_edge("propose_tiers", "compose_reply")
    graph.add_edge("finalize_decision", "estimate_cost")
    graph.add_edge("compose_reply", END)

    return graph.compile()


_GRAPH = None


def get_infra_advisor_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_infra_advisor_graph()
    return _GRAPH

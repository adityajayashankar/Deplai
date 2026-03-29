from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from nodes.approval_packager import run_approval_packager
from nodes.budget_gate import run_budget_gate
from nodes.cost_estimator import run_cost_estimator
from nodes.diagram_builder import run_diagram_builder
from state import AgentState


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("diagram_builder", run_diagram_builder)
    graph.add_node("cost_estimator", run_cost_estimator)
    graph.add_node("budget_gate", run_budget_gate)
    graph.add_node("approval_packager", run_approval_packager)

    graph.add_edge(START, "diagram_builder")
    graph.add_edge("diagram_builder", "cost_estimator")
    graph.add_edge("cost_estimator", "budget_gate")
    graph.add_edge("budget_gate", "approval_packager")
    graph.add_edge("approval_packager", END)
    return graph.compile()


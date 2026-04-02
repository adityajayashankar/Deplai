from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from nodes.final_output import run_final_output
from nodes.infra_planner import run_infra_planner
from nodes.refiner import run_refiner
from nodes.repo_parser import run_repo_parser
from nodes.terraform_generator import run_terraform_generator
from nodes.validator import run_validator
from state import AgentState


MAX_REFINEMENT_LOOPS = 3


def _route_after_validation(state: AgentState) -> str:
    if state.get("validation_result", False):
        return "final_output"
    if int(state.get("retry_count", 0)) >= MAX_REFINEMENT_LOOPS:
        return "final_output"
    return "refiner"


def build_graph():
    graph = StateGraph(AgentState)

    graph.add_node("repo_parser", run_repo_parser)
    graph.add_node("infra_planner", run_infra_planner)
    graph.add_node("terraform_generator", run_terraform_generator)
    graph.add_node("validator", run_validator)
    graph.add_node("refiner", run_refiner)
    graph.add_node("final_output", run_final_output)

    graph.add_edge(START, "repo_parser")
    graph.add_edge("repo_parser", "infra_planner")
    graph.add_edge("infra_planner", "terraform_generator")
    graph.add_edge("terraform_generator", "validator")

    graph.add_conditional_edges(
        "validator",
        _route_after_validation,
        {
            "refiner": "refiner",
            "final_output": "final_output",
        },
    )

    graph.add_edge("refiner", "validator")
    graph.add_edge("final_output", END)

    return graph.compile()

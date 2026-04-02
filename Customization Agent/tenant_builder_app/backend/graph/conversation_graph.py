from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from agents.manifest_agent import run_manifest_agent
from agents.termination_detector import detect_termination, end_node


class ConversationState(TypedDict, total=False):
    message: str
    manifest: dict[str, Any]
    terminate: bool
    terminated: bool
    response: str
    questions: list[str]
    manifest_patch: dict[str, Any]


def conversation_handler(state: ConversationState) -> ConversationState:
    state.setdefault("manifest", {})
    state.setdefault("terminate", False)
    state.setdefault("terminated", False)
    state.setdefault("response", "")
    state.setdefault("questions", [])
    state.setdefault("manifest_patch", {})
    return state


def build_conversation_graph():
    graph = StateGraph(ConversationState)

    graph.add_node("conversation_handler", conversation_handler)
    graph.add_node("termination_check", detect_termination)
    graph.add_node("question_agent", run_manifest_agent)
    graph.add_node("end_node", end_node)

    graph.set_entry_point("conversation_handler")
    graph.add_edge("conversation_handler", "termination_check")
    graph.add_conditional_edges(
        "termination_check",
        lambda state: state["terminate"],
        {
            True: "end_node",
            False: "question_agent",
        },
    )
    graph.add_edge("question_agent", END)
    graph.add_edge("end_node", END)

    return graph.compile()
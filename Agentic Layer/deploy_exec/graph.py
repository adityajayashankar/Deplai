"""Compile the LangGraph deployment execution graph."""

from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from deploy_exec import nodes
from deploy_exec.state import DeployExecState


def _branch(next_name: str):
    def route(state: DeployExecState) -> str:
        decision = nodes.route_after(state)
        if decision == "next":
            return next_name
        if decision == "end":
            return "complete"
        return decision

    return route


def build_deploy_graph():
    graph = StateGraph(DeployExecState)
    graph.add_node("validate_contract", nodes.validate_contract)
    graph.add_node("validate_target", nodes.validate_target)
    graph.add_node("validate_artifact", nodes.validate_artifact)
    graph.add_node("check_ssm", nodes.check_ssm)
    graph.add_node("discover_host", nodes.discover_host)
    graph.add_node("host_ready", nodes.host_ready)
    graph.add_node("lock_env", nodes.lock_env)
    graph.add_node("resolve_configuration", nodes.resolve_configuration)
    graph.add_node("authenticate_registry", nodes.authenticate_registry)
    graph.add_node("pull_artifact", nodes.pull_artifact)
    graph.add_node("stop_previous", nodes.stop_previous)
    graph.add_node("start_application", nodes.start_application)
    graph.add_node("verify_runtime", nodes.verify_runtime)
    graph.add_node("health_check", nodes.health_check)
    graph.add_node("external_endpoint", nodes.external_endpoint)
    graph.add_node("smoke_test", nodes.smoke_test)
    graph.add_node("complete", nodes.complete)
    graph.add_node("rollback", nodes.rollback_application)
    graph.add_node("fail", nodes.fail_finalize)

    sequence = [
        ("validate_contract", "validate_target"),
        ("validate_target", "validate_artifact"),
        ("validate_artifact", "lock_env"),
        ("lock_env", "check_ssm"),
        ("check_ssm", "discover_host"),
        ("discover_host", "host_ready"),
        ("host_ready", "resolve_configuration"),
        ("resolve_configuration", "authenticate_registry"),
        ("authenticate_registry", "pull_artifact"),
        ("pull_artifact", "stop_previous"),
        ("stop_previous", "start_application"),
        ("start_application", "verify_runtime"),
        ("verify_runtime", "health_check"),
        ("health_check", "external_endpoint"),
        ("external_endpoint", "smoke_test"),
        ("smoke_test", "complete"),
    ]
    graph.add_edge(START, "validate_contract")
    for current, nxt in sequence:
        graph.add_conditional_edges(
            current,
            _branch(nxt),
            {
                nxt: nxt,
                "rollback": "rollback",
                "fail": "fail",
                "complete": "complete",
            },
        )
    graph.add_edge("complete", END)
    graph.add_edge("rollback", END)
    graph.add_edge("fail", END)
    return graph.compile(checkpointer=MemorySaver())


_GRAPH = None


def reset_graph() -> None:
    global _GRAPH
    _GRAPH = None


def get_deploy_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_deploy_graph()
    return _GRAPH

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from agents.backend_modifier_agent import apply_backend_changes
from agents.backend_planner_agent import plan_backend_changes
from agents.backend_scanner_agent import scan_backend_repo
from agents.frontend_modifier_agent import apply_frontend_changes
from agents.planner_agent import plan_frontend_changes
from agents.frontend_scanner_agent import scan_frontend_repo
from agents.validator_agent import validate_repo


class CustomizationState(TypedDict, total=False):
    tenant_id: str
    repo_path: str
    manifest: dict[str, Any]
    app_targets: list[str]
    repo_map: dict[str, Any]
    backend_repo_map: dict[str, Any]
    planned_changes: list[dict[str, Any]]
    modified_files: list[str]
    modification_records: list[dict[str, Any]]
    errors: list[str]


LOG_PREFIX = "[CustomizationAgent]"
LOG_FILE_PATH = Path(__file__).resolve().parents[1] / "logs" / "customization.log"


def _log_message(message: str) -> None:
    print(f"{LOG_PREFIX} {message}")
    LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE_PATH.open("a", encoding="utf-8") as handle:
        timestamp = datetime.now().isoformat(timespec="seconds")
        handle.write(f"[{timestamp}] {LOG_PREFIX} {message}\n")


def report_modifications(state: CustomizationState) -> CustomizationState:
    modified_files = state.get("modified_files", [])
    if modified_files:
        _log_message("Customization Complete")
        _log_message("Modified files:")
        for file_path in modified_files:
            _log_message(file_path)
        _log_message(f"Total files modified: {len(modified_files)}")
    else:
        _log_message("WARNING: No files were modified.")
        _log_message("This likely means:")
        _log_message("the planner did not generate changes")
        _log_message("the manifest fields were empty")
        _log_message("the frontend/backend scanners did not detect customization targets")
        _log_message("ERROR: No changes were applied.")
    return state


def build_customization_graph(frontend_only: bool = False):
    graph = StateGraph(CustomizationState)

    graph.add_node("frontend_scanner", scan_frontend_repo)
    graph.add_node("frontend_planner", plan_frontend_changes)
    graph.add_node("frontend_modifier", apply_frontend_changes)
    graph.add_node("validator", validate_repo)
    graph.add_node("reporter", report_modifications)

    if not frontend_only:
        graph.add_node("backend_scanner", scan_backend_repo)
        graph.add_node("backend_planner", plan_backend_changes)
        graph.add_node("backend_modifier", apply_backend_changes)

    graph.set_entry_point("frontend_scanner")
    if frontend_only:
        graph.add_edge("frontend_scanner", "frontend_planner")
        graph.add_edge("frontend_planner", "frontend_modifier")
        graph.add_edge("frontend_modifier", "validator")
    else:
        graph.add_edge("frontend_scanner", "backend_scanner")
        graph.add_edge("backend_scanner", "frontend_planner")
        graph.add_edge("frontend_planner", "frontend_modifier")
        graph.add_edge("frontend_modifier", "backend_planner")
        graph.add_edge("backend_planner", "backend_modifier")
        graph.add_edge("backend_modifier", "validator")
    graph.add_edge("validator", "reporter")
    graph.add_edge("reporter", END)

    return graph.compile()


def run_graph(initial_state: CustomizationState, frontend_only: bool = False) -> CustomizationState:
    graph = build_customization_graph(frontend_only=frontend_only)
    return graph.invoke(initial_state)
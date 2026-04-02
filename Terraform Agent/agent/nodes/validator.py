from __future__ import annotations

from state import AgentState
from tools.terraform_tools import validate_terraform


def run_validator(state: AgentState) -> AgentState:
    terraform_files = state.get("terraform_files", {})
    valid, errors = validate_terraform(terraform_files)
    state["validation_result"] = valid
    state["validation_errors"] = errors
    return state

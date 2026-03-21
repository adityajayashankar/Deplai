"""LangGraph state definition for the analysis agent."""

from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages


class AnalysisState(TypedDict):
    """State carried through the LangGraph analysis pipeline."""
    project_id: str
    code_security: list
    supply_chain: list
    sbom: dict
    messages: Annotated[list, add_messages]
    business_logic_summary: str
    vulnerability_summary: str
    final_report: str

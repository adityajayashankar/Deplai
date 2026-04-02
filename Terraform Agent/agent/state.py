from __future__ import annotations

from typing import Optional, TypedDict


class AgentState(TypedDict):
    raw_file_tree: str
    raw_file_contents: dict[str, str]
    tech_stack: dict
    detected_signals: list[str]
    infra_plan: dict
    terraform_files: dict[str, str]
    validation_result: bool
    validation_errors: list[str]
    retry_count: int
    output_path: Optional[str]

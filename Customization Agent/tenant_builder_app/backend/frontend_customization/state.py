"""Compact LangGraph state for frontend customization runs."""

from __future__ import annotations

from typing import Any, TypedDict


class FrontendCustomizationState(TypedDict, total=False):
    run_id: str
    repository_id: str
    project_id: str
    tenant_id: str
    user_id: str
    base_repo_path: str
    workspace_root: str
    original_root: str
    working_root: str
    mode: str
    goal: str
    selected_screens: list[str]
    llm_config: dict[str, Any]

    repository_manifest: dict[str, Any]
    frontend_manifest: dict[str, Any]
    business_logic_boundary: dict[str, Any]
    product_ux_model: dict[str, Any]
    design_system_plan: dict[str, Any]
    screen_plans: list[dict[str, Any]]
    tasks: list[dict[str, Any]]
    active_tasks: list[str]

    file_locks: list[dict[str, Any]]
    changesets: list[dict[str, Any]]
    validation_results: list[dict[str, Any]]
    preview_state: dict[str, Any]
    quality_scores: dict[str, Any]
    final_review: dict[str, Any]
    github: dict[str, Any]
    zip_path: str

    checkpoints: list[dict[str, Any]]
    completed_nodes: list[str]
    current_stage: str
    events: list[dict[str, Any]]
    errors: list[dict[str, Any]]
    warnings: list[str]
    token_usage: dict[str, Any]
    observability: dict[str, Any]

    interrupt_required: bool
    interrupt_kind: str
    interrupt_reason: str
    interrupt_schema: list[dict[str, Any]]
    user_input: dict[str, Any]
    needs_repair: bool
    repair_attempts: int
    status: str
    gate_passed: bool

    artifact_ids: dict[str, str]

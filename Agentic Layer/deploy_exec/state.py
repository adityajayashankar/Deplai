from __future__ import annotations

from typing import Any, TypedDict


class DeployExecState(TypedDict, total=False):
    deployment_id: str
    project_id: str
    environment_id: str
    requested_by: str
    contract: dict[str, Any]
    blueprint: dict[str, Any]
    status: str
    stage: str
    dry_run: bool
    application_started: bool
    locked: bool
    cancelled: bool
    retry_count: int
    host_capabilities: dict[str, Any]
    plan_preview: dict[str, Any]
    error: dict[str, Any]
    errors: list[str]
    events: list[dict[str, Any]]
    result_class: str
    public_endpoint: str
    observed_account_id: str
    observed_region: str
    logs_excerpt: str
    dast_triggered: bool
    completed_steps: list[str]
    snapshot_hash: str
    snapshot: dict[str, Any]
    previous_digest: str

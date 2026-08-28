"""Typed LangGraph state for the DAST agent."""

from __future__ import annotations

from typing import Any, TypedDict


class DASTAgentState(TypedDict, total=False):
    scan_id: str
    project_id: str
    organization_id: str
    requested_by_user_id: str
    project_name: str

    target_url: str
    normalized_target_url: str
    target_hostname: str
    target_port: int | None
    target_scheme: str

    asset_id: str
    asset_type: str
    asset_scope: str
    grant: dict[str, Any]
    live_asset: dict[str, Any]

    authorization_status: str
    authorization_reason: str
    authorization_code: str

    ownership_status: str
    ownership_method: str

    dns_resolution: list[str]
    resolved_ips: list[str]

    scope_validation_status: str
    ssrf_validation_status: str

    scan_profile: str
    scan_intent: str
    api_spec_url: str
    zap_plan: str
    zap_container_id: str
    zap_image: str

    scan_started_at: str
    scan_finished_at: str
    scan_status: str
    scan_stage: str

    findings: list[dict[str, Any]]
    finding_count: int
    compliance_status: str

    errors: list[str]
    warnings: list[str]
    evidence: dict[str, Any]
    audit_events: list[dict[str, Any]]

    retry_count: int
    dast_checkpoint_id: str
    cancelled: bool
    zap_ok: bool

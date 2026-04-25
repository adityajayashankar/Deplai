"""Terraform generation runner backed by the authoritative terraform_agent package."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def _ensure_agent_import_path() -> None:
    candidates = [
        Path(__file__).resolve().parents[1],
        Path("/app"),
    ]
    for candidate in candidates:
        if not candidate.exists():
            continue
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


def generate_terraform(
    architecture_json: dict[str, Any],
    provider: str = "aws",
    project_name: str = "deplai-project",
    openai_api_key: str = "",
    **kwargs: Any,
) -> dict[str, Any]:
    _ensure_agent_import_path()
    from terraform_agent.agent.engine import generate_terraform_run

    payload = {
        "architecture_json": architecture_json,
        "provider": provider,
        "project_name": project_name,
        "llm_api_key": "",
        **kwargs,
    }
    return generate_terraform_run(payload)


def consult_cloudposse_components(
    *,
    architecture_json: dict[str, Any],
    repository_context_json: dict[str, Any] | None = None,
    deployment_profile_json: dict[str, Any] | None = None,
    detected_json: dict[str, Any] | None = None,
    aws_region: str = "eu-north-1",
    conversation_history: list[dict[str, str]] | None = None,
    turn_count: int = 0,
    force_decision: bool = False,
) -> dict[str, Any]:
    _ensure_agent_import_path()
    from terraform_agent.agent.engine.cloudposse_atmos import consultant_conversation_turn

    payload = dict(deployment_profile_json or architecture_json or {})
    if repository_context_json:
        payload["repository_context"] = repository_context_json
    if detected_json:
        payload["detected"] = detected_json
    return consultant_conversation_turn(
        payload,
        aws_region=aws_region,
        conversation_history=conversation_history or [],
        turn_count=turn_count,
        force_decision=force_decision,
    )

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
        "llm_api_key": openai_api_key,
        **kwargs,
    }
    return generate_terraform_run(payload)

"""Terraform generation runner.

RAG-based terraform generation has been removed from this repository.
This module intentionally returns an unavailable response so callers can
use their existing template fallback path.
"""

from __future__ import annotations

from typing import Any


def generate_terraform(
    architecture_json: dict[str, Any],
    provider: str = "aws",
    project_name: str = "deplai-project",
    openai_api_key: str = "",
) -> dict[str, Any]:
    _ = architecture_json, provider, project_name, openai_api_key
    return {
        "success": False,
        "error": "Terraform RAG generator has been removed from this deployment.",
        "source": "unavailable",
    }


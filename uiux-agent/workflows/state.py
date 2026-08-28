"""Shared mutable pipeline state for UI/UX refactor workflow steps."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from schemas.component_capsule import ComponentIndex
from schemas.token_spec import DesignTokenSpec


class PipelineState:
    """Mutable state bag passed through pipeline stages."""

    def __init__(self, repo_root: str, target_css: str | None = None) -> None:
        self.repo_root = Path(repo_root).resolve()
        self.target_css = target_css or str(self.repo_root / "app" / "globals.css")
        self.component_index: ComponentIndex | None = None
        self.design_tokens: DesignTokenSpec | None = None
        self.clarification: dict[str, str] = {}
        self.diff_masks: dict[str, Any] = {}
        self.patches: list[dict[str, Any]] = []
        self.validation_results: list[dict[str, Any]] = []
        self.style_direction: str = ""
        self.scope: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "repo_root": str(self.repo_root),
            "target_css": self.target_css,
            "component_index": (
                self.component_index.model_dump() if self.component_index else None
            ),
            "design_tokens": (
                self.design_tokens.model_dump() if self.design_tokens else None
            ),
            "clarification": self.clarification,
            "style_direction": self.style_direction,
            "scope": self.scope,
            "patches": self.patches,
            "validation_results": self.validation_results,
        }

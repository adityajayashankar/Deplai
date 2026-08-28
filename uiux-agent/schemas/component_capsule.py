"""Component capsule schema — the unit of work in the refactoring pipeline.

Each capsule represents a single React component extracted by the AST chunker.
The component index stored in MongoDB is a collection of these capsules.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ComponentCapsule(BaseModel):
    """A single component extracted from the target codebase.

    This is the atomic unit the pipeline operates on: the AST chunker produces
    these, the boundary classifier annotates them with a diff mask, and the
    component refactorer consumes one at a time.
    """

    name: str = Field(description="Component/function name, e.g. 'SettingsApp'")
    file: str = Field(description="Relative path from the target repo root")
    line_range: tuple[int, int] = Field(
        description="(start_line, end_line) in the source file, 1-indexed inclusive"
    )
    prop_signature_hash: str = Field(
        description="SHA-256 of the component's props/params type signature"
    )
    one_line_summary: str = Field(
        description="Brief human-readable summary, e.g. 'Settings page with tabbed nav'"
    )
    mask_hash: str = Field(
        default="",
        description="SHA-256 of the diff mask (set after boundary classification)",
    )
    ast_node_type: str = Field(
        description="tree-sitter node type: function_declaration, arrow_function, etc."
    )
    status: Literal[
        "pending", "in_progress", "refactored", "validated", "failed"
    ] = Field(default="pending", description="Current pipeline status")
    file_hash: str = Field(
        default="",
        description="SHA-256 of the source file content at indexing time (cache key)",
    )
    token_count_estimate: int = Field(
        default=0,
        description="Estimated token count for the masked source of this component",
    )

    class Config:
        json_schema_extra = {
            "example": {
                "name": "SettingsApp",
                "file": "features/dashboard/SettingsApp.tsx",
                "line_range": [1, 1611],
                "prop_signature_hash": "a1b2c3d4...",
                "one_line_summary": "Settings page with tabbed workspace/user navigation",
                "mask_hash": "",
                "ast_node_type": "function_declaration",
                "status": "pending",
                "file_hash": "e5f6a7b8...",
                "token_count_estimate": 0,
            }
        }


class ComponentIndex(BaseModel):
    """The full component index for a target repository.

    Persisted in MongoDB as part of the AgentOS session state.
    """

    repo_root: str = Field(description="Absolute path to the scanned repo root")
    scan_timestamp: str = Field(description="ISO 8601 timestamp of the last scan")
    components: list[ComponentCapsule] = Field(default_factory=list)
    total_files_scanned: int = Field(default=0)
    total_lines_scanned: int = Field(default=0)

    def get_by_name(self, name: str) -> ComponentCapsule | None:
        """Look up a component by name."""
        for c in self.components:
            if c.name == name:
                return c
        return None

    def get_by_file(self, file: str) -> list[ComponentCapsule]:
        """Get all components in a given file."""
        return [c for c in self.components if c.file == file]

    def pending(self) -> list[ComponentCapsule]:
        """Return components that haven't been processed yet."""
        return [c for c in self.components if c.status == "pending"]

    def summary_for_context(self) -> str:
        """Compact summary suitable for LLM context injection (~5-15K tokens)."""
        lines = [f"Component Index ({len(self.components)} components):\n"]
        for c in self.components:
            lines.append(
                f"  - {c.name} [{c.status}] {c.file}:{c.line_range[0]}-{c.line_range[1]}"
                f" ({c.one_line_summary})"
            )
        return "\n".join(lines)

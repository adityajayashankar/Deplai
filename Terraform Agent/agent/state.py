from __future__ import annotations

from typing import Optional, TypedDict


class AgentState(TypedDict):
    # ── Input ──────────────────────────────────────────────────────────────
    repo_path: Optional[str]          # NEW: filesystem path to the repo being scanned
    raw_file_tree: str
    raw_file_contents: dict[str, str]

    # ── Analysis ───────────────────────────────────────────────────────────
    tech_stack: dict
    detected_signals: list[str]
    infra_plan: dict

    # ── Generation ─────────────────────────────────────────────────────────
    terraform_files: dict[str, str]

    # ── Validation / refinement ────────────────────────────────────────────
    validation_result: bool
    validation_errors: list[str]
    retry_count: int

    # ── Output ─────────────────────────────────────────────────────────────
    output_path: Optional[str]
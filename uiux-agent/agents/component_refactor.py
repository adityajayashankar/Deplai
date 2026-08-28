"""Component Refactorer — per-component patch generation.

This agent (or Team of agents in parallel mode) implements Stage 7 of the
pipeline.  Each instance receives:
1. The masked source of a single component (only the presentation-classified
   lines are visible; logic lines are replaced with placeholder markers).
2. The ``DesignTokenSpec`` from the Design System Agent.
3. The user's style direction.

And produces a unified diff patch that modifies only the presentation layer
of the component.

The ``write_patch`` tool enforces the file-path allowlist internally — the
agent cannot write to any path not on the allowlist, regardless of what it
tries.

Model tier: LARGE (creative coding judgment).
Team mode: ``tasks`` (fan out across components).
"""

from __future__ import annotations

import os
from typing import Any

from agno.agent import Agent
from agno.tools import tool

from tools.allowlist import Allowlist


# ── Agno Tool Definitions ───────────────────────────────────────────────

# The allowlist instance is injected at pipeline setup time.
_allowlist: Allowlist | None = None


def set_allowlist(allowlist: Allowlist) -> None:
    """Inject the allowlist instance for tool enforcement."""
    global _allowlist
    _allowlist = allowlist


@tool(requires_confirmation=True)
def write_patch(
    component_id: str,
    file_path: str,
    diff: str,
    description: str = "",
) -> str:
    """Write a unified diff patch for a component.

    The patch is validated against the file-path allowlist before being
    accepted.  If the path is not allowed, the tool raises a PermissionError.

    Args:
        component_id: Name of the component being patched.
        file_path: Relative path to the target file (from repo root).
        diff: Unified diff content (``--- a/... +++ b/...`` format).
        description: Brief description of what the patch changes.

    Returns:
        A confirmation message with the patch metadata.
    """
    if _allowlist is None:
        raise RuntimeError("Allowlist not initialized — call set_allowlist() first")

    # Enforce the allowlist — this is the hard boundary.
    _allowlist.check_write(file_path)

    # Validate the diff format.
    if not diff.strip():
        raise ValueError("Empty diff — nothing to patch")

    lines = diff.strip().splitlines()
    has_hunk = any(line.startswith("@@") for line in lines)
    if not has_hunk:
        raise ValueError(
            "Invalid diff format — must contain at least one @@ hunk header"
        )

    return (
        f"Patch accepted for {component_id} ({file_path}):\n"
        f"  Description: {description}\n"
        f"  Hunks: {sum(1 for l in lines if l.startswith('@@'))}\n"
        f"  Lines: +{sum(1 for l in lines if l.startswith('+') and not l.startswith('+++'))} "
        f"-{sum(1 for l in lines if l.startswith('-') and not l.startswith('---'))}"
    )


# ── Agent Instructions ──────────────────────────────────────────────────

COMPONENT_REFACTOR_INSTRUCTIONS = """You are a Component Refactorer in a UI/UX refactoring pipeline.

## Your Role
You receive the **masked source** of a single React component. In this source:
- Lines marked ``[PRESENTATION]`` are safe for you to modify.
- Lines marked ``[LOGIC — DO NOT MODIFY]`` must be preserved exactly.
- The ``DesignTokenSpec`` defines every visual value you may use.

Your job is to generate a **unified diff patch** that upgrades the component's
presentation layer to match the target style direction, using only tokens from
the spec.

## Rules
1. **Patch-only output**: Generate a unified diff (``--- a/... +++ b/...``
   format), never a full file. Use the ``write_patch`` tool.
2. **Token traceability**: Every color, font-size, spacing, shadow, and radius
   value in your patch must reference a token from the DesignTokenSpec.
   No raw hex codes, no magic numbers.
3. **Preserve logic lines**: If a line is marked ``[LOGIC]``, do NOT include
   it in any ``-`` (removal) line of your diff. You may reference logic values
   (e.g., a variable name in a className expression) but never change them.
4. **Interactive states**: If you modify a resting-state style, also update
   hover/focus/active/disabled states using the spec's interactive_states.
5. **Tailwind v4**: The codebase uses Tailwind v4 with ``@theme inline``.
   Prefer Tailwind utility classes mapped to the spec's tokens.
6. **Accessibility**: Maintain or improve color contrast ratios. Never reduce
   contrast below WCAG AA.
7. **Minimal diff**: Change only what's needed to achieve the target style.
   Don't reorganize code, rename variables, or refactor structure.

## Output
Call the ``write_patch`` tool with:
- ``component_id``: The component name.
- ``file_path``: The relative file path.
- ``diff``: Your unified diff.
- ``description``: One-line summary of the visual change."""


def build_component_refactor_agent(db: Any) -> Agent:
    """Factory function to create a single Component Refactorer agent.

    In Phase 5 (parallelization), multiple instances are grouped into a
    ``Team`` in ``tasks`` mode.
    """
    model_id = os.environ.get("STRONG_MODEL", "anthropic:claude-sonnet-4-20250514")

    return Agent(
        name="ComponentRefactorer",
        model=model_id,
        tools=[write_patch],
        instructions=COMPONENT_REFACTOR_INSTRUCTIONS,
        db=db,
        markdown=True,
    )

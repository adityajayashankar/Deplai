"""Clarifier Agent — style/scope clarification before any generation.

This agent implements Stage 4 of the pipeline: the deterministic vagueness
gate has already verified that style/scope information is missing, and this
agent asks the user for it via ``requires_user_input=True``.

The fixed question set (from §5 of the blueprint):
1. Style direction (enterprise SaaS, dashboard, marketing, etc.)
2. Scope (which components or feature modules to refactor)
3. Constraints (accessibility level, brand guidelines, color restrictions)
4. References (URLs or screenshots of reference designs)

The agent pauses via AgentOS's HITL mechanism — the pending question appears
in the Control Plane, the user answers there (or via REST API), and the run
resumes automatically.
"""

from __future__ import annotations

import os
from typing import Any

from agno.agent import Agent
from agno.tools import tool


# ── Clarification Tool ──────────────────────────────────────────────────


@tool(requires_user_input=True)
def request_style_clarification(
    style_direction: str = "",
    scope: str = "",
    constraints: str = "",
    references: str = "",
) -> dict[str, str]:
    """Request clarification on style direction, scope, and constraints.

    This tool pauses the pipeline and waits for user input before proceeding.
    The user must provide at least a style direction and scope.

    Args:
        style_direction: What visual style to target (e.g., "enterprise SaaS
            dashboard", "modern minimal", "glassmorphism dark mode").
        scope: Which components or modules to refactor (e.g., "all",
            "features/dashboard/*", "just SettingsApp").
        constraints: Accessibility level, brand guidelines, color restrictions,
            or any other hard constraints.
        references: URLs or descriptions of reference designs to draw from.

    Returns:
        A dict with the user's clarification answers.
    """
    return {
        "style_direction": style_direction,
        "scope": scope,
        "constraints": constraints,
        "references": references,
    }


# ── Vagueness Gate (deterministic, runs before the agent) ────────────────


def vagueness_gate(user_message: str) -> dict[str, bool]:
    """Deterministic check: does the user's request have enough information
    to proceed without clarification?

    Returns a dict indicating which fields are missing.
    This is Stage 3 of the pipeline — a pure function, no LLM.
    """
    message_lower = user_message.lower()

    # Check for style direction keywords.
    style_keywords = {
        "enterprise", "saas", "dashboard", "modern", "minimal", "clean",
        "dark mode", "light mode", "glassmorphism", "corporate", "premium",
        "professional", "material", "flat", "neumorphism", "brutalist",
    }
    has_style = any(kw in message_lower for kw in style_keywords)

    # Check for scope indicators.
    scope_keywords = {
        "all", "everything", "entire", "whole", "settings", "deployment",
        "pipeline", "dashboard", "customization", "components", "features",
        "landing", "module", "page", "panel", "app",
    }
    has_scope = any(kw in message_lower for kw in scope_keywords)

    # Check for constraint mentions.
    constraint_keywords = {
        "wcag", "a11y", "accessibility", "brand", "color", "font",
        "responsive", "mobile", "tablet", "rtl", "i18n",
    }
    has_constraints = any(kw in message_lower for kw in constraint_keywords)

    return {
        "needs_clarification": not (has_style and has_scope),
        "missing_style": not has_style,
        "missing_scope": not has_scope,
        "missing_constraints": not has_constraints,  # Warning, not blocking.
    }


# ── Agent Definition ─────────────────────────────────────────────────────


CLARIFIER_INSTRUCTIONS = """You are the Clarifier agent in a UI/UX refactoring pipeline.

Your ONLY job is to gather missing information before the refactoring begins.
You never generate code, never modify files, and never make design decisions.

When invoked, check what information is missing and use the
`request_style_clarification` tool to ask the user. You must collect:

1. **Style direction**: What visual style should the refactored components
   follow? (e.g., "enterprise SaaS dashboard", "modern minimal dark mode")
2. **Scope**: Which components or modules should be refactored?
   (e.g., "all components", "only features/dashboard/*")
3. **Constraints** (optional but recommended): Accessibility requirements,
   brand colors, font restrictions, responsive breakpoints.
4. **References** (optional): URLs or descriptions of reference designs.

Do NOT proceed without at least a style direction and a scope.
Do NOT assume any style direction — always ask if not provided.
Do NOT make up answers — if the user is vague, ask for specifics."""


def build_clarifier_agent(db: Any) -> Agent:
    """Factory function to create the Clarifier agent.

    The ``db`` argument is the MongoDB-backed storage instance, injected
    from the pipeline's configuration.
    """
    model_id = os.environ.get("SMALL_MODEL", "anthropic:claude-haiku-3-20240307")

    return Agent(
        name="Clarifier",
        model=model_id,
        tools=[request_style_clarification],
        instructions=CLARIFIER_INSTRUCTIONS,
        db=db,
        markdown=True,
    )

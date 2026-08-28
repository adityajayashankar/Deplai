"""Design-token specification schema.

The design-token spec is the contract between the Design System Agent (which
authors/extends it) and the Component Refactorer Team (which consumes it).
Every visual value in a refactored component must trace to a token in this spec.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ColorToken(BaseModel):
    """A single color token."""

    name: str = Field(description="Token name, e.g. '--color-primary'")
    value: str = Field(description="CSS value: hex, oklch, hsl, rgb, or var()")
    semantic: str = Field(
        default="",
        description="Semantic role: 'background', 'foreground', 'accent', 'border', etc.",
    )
    variants: dict[str, str] = Field(
        default_factory=dict,
        description="Theme variants: {'dark': '#...', 'light': '#...'}",
    )


class TypographyToken(BaseModel):
    """Typography scale entry."""

    name: str = Field(description="Token name, e.g. 'heading-1'")
    font_family: str = Field(default="")
    font_size: str = Field(default="")
    font_weight: str | int = Field(default="")
    line_height: str = Field(default="")
    letter_spacing: str = Field(default="")


class SpacingToken(BaseModel):
    """Spacing scale entry."""

    name: str
    value: str = Field(description="CSS value, e.g. '0.5rem', '8px'")


class ShadowToken(BaseModel):
    """Box/text shadow token."""

    name: str
    value: str = Field(description="Full CSS shadow value")


class AnimationToken(BaseModel):
    """Animation/transition token."""

    name: str
    keyframes: str = Field(
        default="", description="@keyframes rule body if applicable"
    )
    duration: str = Field(default="")
    timing_function: str = Field(default="")
    css_class: str = Field(
        default="", description="Tailwind/utility class name if applicable"
    )


class InteractiveStateSet(BaseModel):
    """Token overrides for interactive states of a component pattern."""

    component_pattern: str = Field(
        description="e.g. 'button-primary', 'input-default', 'card-clickable'"
    )
    hover: dict[str, str] = Field(default_factory=dict)
    focus: dict[str, str] = Field(default_factory=dict)
    active: dict[str, str] = Field(default_factory=dict)
    disabled: dict[str, str] = Field(default_factory=dict)


class DesignTokenSpec(BaseModel):
    """The full design-token specification.

    Authored or extended by the Design System Agent; consumed by the
    Component Refactorer Team.  Every visual value in a refactored component
    must trace to a token defined here.

    The ``source`` field tracks provenance:
    - ``extracted``: parsed mechanically from the existing codebase
    - ``authored``: created by the Design System Agent from user direction
    - ``merged``: extracted base extended by the agent
    """

    colors: list[ColorToken] = Field(default_factory=list)
    typography: list[TypographyToken] = Field(default_factory=list)
    spacing: list[SpacingToken] = Field(default_factory=list)
    border_radii: dict[str, str] = Field(
        default_factory=dict,
        description="Named radius tokens: {'sm': '0.25rem', 'lg': '0.75rem', ...}",
    )
    shadows: list[ShadowToken] = Field(default_factory=list)
    animations: list[AnimationToken] = Field(default_factory=list)
    interactive_states: list[InteractiveStateSet] = Field(default_factory=list)
    breakpoints: dict[str, str] = Field(
        default_factory=dict,
        description="Responsive breakpoints: {'sm': '640px', 'md': '768px', ...}",
    )
    custom_properties_raw: dict[str, str] = Field(
        default_factory=dict,
        description="Any CSS custom properties that don't fit the above categories",
    )
    source: Literal["extracted", "authored", "merged"] = Field(default="extracted")
    tailwind_version: str = Field(
        default="4",
        description="Tailwind CSS version detected in the target repo",
    )
    notes: str = Field(
        default="",
        description="Free-form notes from the Design System Agent",
    )

    def token_count_estimate(self) -> int:
        """Rough token-count estimate for context-window budgeting."""
        import json

        return len(json.dumps(self.model_dump())) // 4

    def lookup_color(self, name: str) -> ColorToken | None:
        """Find a color token by name (case-insensitive)."""
        name_lower = name.lower().strip("-")
        for c in self.colors:
            if c.name.lower().strip("-") == name_lower:
                return c
        return None

    def all_token_names(self) -> list[str]:
        """Return a flat list of every token name for traceability checks."""
        names: list[str] = []
        names.extend(c.name for c in self.colors)
        names.extend(t.name for t in self.typography)
        names.extend(s.name for s in self.spacing)
        names.extend(self.border_radii.keys())
        names.extend(s.name for s in self.shadows)
        names.extend(a.name for a in self.animations)
        names.extend(self.custom_properties_raw.keys())
        return names

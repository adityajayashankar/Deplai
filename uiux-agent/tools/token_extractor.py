"""Design-token extractor — parses CSS/Tailwind tokens from the target codebase.

Zero-LLM: this is a pure regex + CSS-parsing module that extracts the existing
design vocabulary from globals.css and any other CSS files in scope.

Handles:
- CSS custom properties (``--color-*``, ``--font-*``, etc.)
- Tailwind v4 ``@theme inline`` blocks
- ``@custom-variant`` directives
- ``@keyframes`` rules
- ``@media (prefers-color-scheme: ...)`` theme variants
- Class-based dark/light mode overrides
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from schemas.token_spec import (
    AnimationToken,
    ColorToken,
    DesignTokenSpec,
    SpacingToken,
    ShadowToken,
    TypographyToken,
)


# ── Regex patterns ───────────────────────────────────────────────────────

# Matches CSS custom property declarations: --name: value;
_CUSTOM_PROP_RE = re.compile(
    r"--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);", re.MULTILINE
)

# Matches @keyframes blocks (name + body).
_KEYFRAMES_RE = re.compile(
    r"@keyframes\s+([\w-]+)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}", re.DOTALL
)

# Matches @theme inline { ... } blocks (Tailwind v4).
_THEME_BLOCK_RE = re.compile(
    r"@theme\s+inline\s*\{([^}]+)\}", re.DOTALL
)

# Matches @custom-variant directives.
_CUSTOM_VARIANT_RE = re.compile(
    r"@custom-variant\s+(\w+)\s*\(([^)]+)\)", re.MULTILINE
)

# Matches :root, :root.dark, :root.light, .compute-landing selector blocks.
_SELECTOR_BLOCK_RE = re.compile(
    r"((?::root(?:\.\w+)?|\.[\w-]+))\s*\{([^}]+)\}", re.DOTALL
)

# Matches @media (prefers-color-scheme: dark/light) { :root:not(.light) { ... } }
_MEDIA_SCHEME_RE = re.compile(
    r"@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{"
    r"([\s\S]*?)\}[\s\S]*?\}",
    re.MULTILINE,
)

# ── Semantic classifiers ─────────────────────────────────────────────────

_COLOR_PREFIXES = {
    "color", "background", "bg", "foreground", "fg", "border", "surface",
    "header", "card", "muted", "search", "primary", "secondary", "accent",
    "popover", "input", "ring", "suspended", "destructive", "success",
    "warning", "info",
}

_TYPOGRAPHY_PREFIXES = {"font", "text", "letter-spacing", "line-height"}

_SPACING_PREFIXES = {"spacing", "gap", "padding", "margin", "space"}

_SHADOW_PREFIXES = {"shadow", "box-shadow"}

_RADIUS_PREFIXES = {"radius", "rounded", "border-radius"}


def _classify_property(name: str) -> str:
    """Classify a custom property name into a token category."""
    name_lower = name.lower().replace("_", "-")
    parts = name_lower.split("-")
    for prefix in _COLOR_PREFIXES:
        if prefix in parts or name_lower.startswith(f"color-{prefix}"):
            return "color"
    for prefix in _TYPOGRAPHY_PREFIXES:
        if prefix in parts:
            return "typography"
    for prefix in _SPACING_PREFIXES:
        if prefix in parts:
            return "spacing"
    for prefix in _SHADOW_PREFIXES:
        if prefix in parts:
            return "shadow"
    for prefix in _RADIUS_PREFIXES:
        if prefix in parts:
            return "radius"
    return "other"


def _semantic_from_name(name: str) -> str:
    """Derive a semantic role from the property name."""
    name_lower = name.lower().replace("_", "-")
    for role in ("background", "foreground", "border", "surface", "accent",
                 "primary", "secondary", "muted", "card", "header", "ring",
                 "input", "popover"):
        if role in name_lower:
            return role
    return ""


def extract_tokens_from_css(css_content: str) -> DesignTokenSpec:
    """Parse a CSS string and return a structured ``DesignTokenSpec``.

    This is the main entry point.  It processes the entire content in a
    single pass, extracting custom properties, keyframes, theme blocks,
    and variant directives.
    """
    colors: list[ColorToken] = []
    typography: list[TypographyToken] = []
    spacing: list[SpacingToken] = []
    shadows: list[ShadowToken] = []
    radii: dict[str, str] = {}
    animations: list[AnimationToken] = []
    custom_raw: dict[str, str] = {}
    seen_names: set[str] = set()

    # --- 1. Extract from selector blocks (:root, .dark, .light, etc.) ---
    dark_variants: dict[str, str] = {}
    light_variants: dict[str, str] = {}

    for match in _SELECTOR_BLOCK_RE.finditer(css_content):
        selector = match.group(1).strip()
        block = match.group(2)
        is_dark = "dark" in selector.lower()
        is_light = "light" in selector.lower()

        for prop_match in _CUSTOM_PROP_RE.finditer(block):
            prop_name = prop_match.group(1).strip()
            prop_value = prop_match.group(2).strip()

            if is_dark:
                dark_variants[prop_name] = prop_value
            elif is_light:
                light_variants[prop_name] = prop_value

            if prop_name not in seen_names:
                seen_names.add(prop_name)
                category = _classify_property(prop_name)
                if category == "color":
                    colors.append(
                        ColorToken(
                            name=f"--{prop_name}",
                            value=prop_value,
                            semantic=_semantic_from_name(prop_name),
                        )
                    )
                elif category == "typography":
                    typography.append(
                        TypographyToken(
                            name=f"--{prop_name}",
                            font_family=prop_value if "font" in prop_name.lower() and "family" in prop_name.lower() else "",
                            font_size=prop_value if "size" in prop_name.lower() else "",
                            font_weight=prop_value if "weight" in prop_name.lower() else "",
                            line_height=prop_value if "height" in prop_name.lower() else "",
                            letter_spacing=prop_value if "spacing" in prop_name.lower() else "",
                        )
                    )
                elif category == "spacing":
                    spacing.append(SpacingToken(name=f"--{prop_name}", value=prop_value))
                elif category == "shadow":
                    shadows.append(ShadowToken(name=f"--{prop_name}", value=prop_value))
                elif category == "radius":
                    radii[f"--{prop_name}"] = prop_value
                else:
                    custom_raw[f"--{prop_name}"] = prop_value

    # --- 2. Backfill dark/light variants onto color tokens ---
    for color in colors:
        stripped = color.name.lstrip("-")
        if stripped in dark_variants:
            color.variants["dark"] = dark_variants[stripped]
        if stripped in light_variants:
            color.variants["light"] = light_variants[stripped]

    # --- 3. Extract from @media (prefers-color-scheme) ---
    for match in _MEDIA_SCHEME_RE.finditer(css_content):
        scheme = match.group(1)  # "dark" or "light"
        inner = match.group(2)
        for prop_match in _CUSTOM_PROP_RE.finditer(inner):
            prop_name = prop_match.group(1).strip()
            prop_value = prop_match.group(2).strip()
            for color in colors:
                if color.name == f"--{prop_name}":
                    color.variants[scheme] = prop_value
                    break

    # --- 4. Extract from @theme inline blocks (Tailwind v4) ---
    for match in _THEME_BLOCK_RE.finditer(css_content):
        block = match.group(1)
        for prop_match in _CUSTOM_PROP_RE.finditer(block):
            prop_name = prop_match.group(1).strip()
            prop_value = prop_match.group(2).strip()
            if prop_name not in seen_names:
                seen_names.add(prop_name)
                category = _classify_property(prop_name)
                if category == "color":
                    colors.append(
                        ColorToken(
                            name=f"--{prop_name}",
                            value=prop_value,
                            semantic=_semantic_from_name(prop_name),
                        )
                    )
                elif category == "typography":
                    font_val = prop_value if "font" in prop_name.lower() else ""
                    typography.append(
                        TypographyToken(name=f"--{prop_name}", font_family=font_val)
                    )
                else:
                    custom_raw[f"--{prop_name}"] = prop_value

    # --- 5. Extract @keyframes ---
    for match in _KEYFRAMES_RE.finditer(css_content):
        anim_name = match.group(1).strip()
        anim_body = match.group(2).strip()
        animations.append(
            AnimationToken(
                name=anim_name,
                keyframes=anim_body,
            )
        )

    return DesignTokenSpec(
        colors=colors,
        typography=typography,
        spacing=spacing,
        border_radii=radii,
        shadows=shadows,
        animations=animations,
        custom_properties_raw=custom_raw,
        source="extracted",
        tailwind_version="4",
    )


def extract_tokens_from_file(css_path: str | Path) -> DesignTokenSpec:
    """Convenience wrapper: read a CSS file and extract tokens."""
    content = Path(css_path).read_text(encoding="utf-8")
    return extract_tokens_from_css(content)

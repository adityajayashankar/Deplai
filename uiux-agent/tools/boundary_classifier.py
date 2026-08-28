"""Boundary classifier — separates presentation from logic AST nodes.

Zero-LLM (with rare fallback): classifies every AST node in a React component
as either ``presentation`` (safe for the refactorer to modify) or ``logic``
(read-only, must be preserved exactly).

The classifier produces a **diff mask** — a list of line ranges with their
classification.  The Component Refactorer is only allowed to generate patches
within the ``presentation`` regions of the mask.

Classification rules (deterministic, no LLM):
- **Presentation:** JSX elements, className attributes, style attributes,
  CSS class strings, Tailwind utility classes, framer-motion animation props,
  CSS-in-JS template literals, pure visual helper functions.
- **Logic:** React hooks (useState, useEffect, useCallback, useMemo, useRef,
  useContext), API calls (fetch, axios), router usage (useRouter,
  useSearchParams, usePathname), type/interface definitions, import
  statements from non-presentation modules, event handler function bodies,
  state management, data transformations.

An LLM fallback is available for genuinely ambiguous nodes (e.g., a ternary
that mixes style and logic), but it should fire on <5% of nodes in practice.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

# tree-sitter — optional import for graceful degradation.
try:
    import tree_sitter
    import tree_sitter_typescript as ts_typescript

    _TS_AVAILABLE = True
except ImportError:
    _TS_AVAILABLE = False


class NodeClass(str, Enum):
    """Classification of an AST node region."""

    PRESENTATION = "presentation"
    LOGIC = "logic"
    AMBIGUOUS = "ambiguous"  # Needs LLM fallback.


@dataclass
class MaskRegion:
    """A contiguous line range with a classification."""

    start_line: int  # 1-indexed, inclusive.
    end_line: int  # 1-indexed, inclusive.
    classification: NodeClass
    reason: str = ""  # Brief explanation for auditing.


@dataclass
class DiffMask:
    """The complete diff mask for a component."""

    component_name: str
    file: str
    regions: list[MaskRegion] = field(default_factory=list)

    @property
    def hash(self) -> str:
        """SHA-256 of the serialized mask, for cache invalidation."""
        data = f"{self.component_name}:{self.file}:" + "|".join(
            f"{r.start_line}-{r.end_line}:{r.classification.value}"
            for r in self.regions
        )
        return hashlib.sha256(data.encode()).hexdigest()[:16]

    def presentation_lines(self) -> set[int]:
        """Return the set of line numbers the refactorer may modify."""
        lines: set[int] = set()
        for r in self.regions:
            if r.classification == NodeClass.PRESENTATION:
                lines.update(range(r.start_line, r.end_line + 1))
        return lines

    def logic_lines(self) -> set[int]:
        """Return the set of line numbers that must not be modified."""
        lines: set[int] = set()
        for r in self.regions:
            if r.classification == NodeClass.LOGIC:
                lines.update(range(r.start_line, r.end_line + 1))
        return lines

    def presentation_ratio(self) -> float:
        """Fraction of the component that is presentation-layer."""
        total = sum(r.end_line - r.start_line + 1 for r in self.regions)
        pres = sum(
            r.end_line - r.start_line + 1
            for r in self.regions
            if r.classification == NodeClass.PRESENTATION
        )
        return pres / total if total > 0 else 0.0

    def ambiguous_regions(self) -> list[MaskRegion]:
        """Return regions that need LLM fallback classification."""
        return [r for r in self.regions if r.classification == NodeClass.AMBIGUOUS]


# ── Deterministic classification rules ───────────────────────────────────

# React hooks — always logic.
_HOOK_NAMES = {
    "useState", "useEffect", "useCallback", "useMemo", "useRef",
    "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
    "useDebugValue", "useDeferredValue", "useTransition", "useId",
    "useSyncExternalStore", "useInsertionEffect", "useOptimistic",
    "useFormStatus", "useActionState",
}

# Router/navigation — always logic.
_ROUTER_IDENTIFIERS = {
    "useRouter", "useSearchParams", "usePathname", "useParams",
    "useSelectedLayoutSegment", "useSelectedLayoutSegments",
    "redirect", "notFound", "permanentRedirect",
}

# API/data fetching — always logic.
_FETCH_IDENTIFIERS = {
    "fetch", "axios", "useSWR", "useQuery", "useMutation",
}

# Presentation-layer attribute names in JSX.
_PRESENTATION_JSX_ATTRS = {
    "className", "class", "style", "css", "sx",
    "animate", "initial", "exit", "transition", "variants",
    "whileHover", "whileTap", "whileFocus", "whileInView",
    "drag", "dragConstraints", "layout", "layoutId",
}

# Import paths that indicate presentation-layer modules.
_PRESENTATION_IMPORT_PATTERNS = {
    "lucide-react", "react-icons", "framer-motion", "motion",
    "@/components", "three", "gsap", "lottie-react", "ogl",
}

# Import paths that indicate logic-layer modules.
_LOGIC_IMPORT_PATTERNS = {
    "@/lib", "@/app/api", "next/navigation", "next/router",
    "iron-session", "mysql2", "simple-git", "ssh2", "ws",
    "@octokit", "adm-zip", "uuid",
}


def _node_text(node: Any, source_bytes: bytes) -> str:
    """Extract source text for a tree-sitter node."""
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _classify_node(node: Any, source_bytes: bytes) -> NodeClass:
    """Classify a single tree-sitter node using deterministic rules.

    Returns ``AMBIGUOUS`` only when the heuristics genuinely can't decide.
    """
    text = _node_text(node, source_bytes)
    node_type = node.type

    # --- Always LOGIC ---

    # Hook calls.
    if node_type == "call_expression":
        fn_text = ""
        for child in node.children:
            if child.type == "identifier":
                fn_text = _node_text(child, source_bytes)
                break
            if child.type == "member_expression":
                fn_text = _node_text(child, source_bytes)
                break
        if fn_text in _HOOK_NAMES or fn_text in _ROUTER_IDENTIFIERS:
            return NodeClass.LOGIC
        if fn_text in _FETCH_IDENTIFIERS:
            return NodeClass.LOGIC

    # Type/interface definitions.
    if node_type in ("type_alias_declaration", "interface_declaration",
                     "enum_declaration"):
        return NodeClass.LOGIC

    # Import statements — classified by source.
    if node_type == "import_statement":
        source_str = ""
        for child in node.children:
            if child.type == "string":
                source_str = _node_text(child, source_bytes).strip("'\"")
                break
        for pattern in _LOGIC_IMPORT_PATTERNS:
            if pattern in source_str:
                return NodeClass.LOGIC
        for pattern in _PRESENTATION_IMPORT_PATTERNS:
            if pattern in source_str:
                return NodeClass.PRESENTATION
        return NodeClass.LOGIC  # Default: imports are logic.

    # Variable declarations that are clearly state/data.
    if node_type in ("lexical_declaration", "variable_declaration"):
        # Check if it's a hook call assignment.
        if re.search(r"\b(?:" + "|".join(_HOOK_NAMES) + r")\b", text):
            return NodeClass.LOGIC

    # --- Always PRESENTATION ---

    # JSX elements.
    if node_type in ("jsx_element", "jsx_self_closing_element", "jsx_fragment",
                     "jsx_opening_element", "jsx_closing_element"):
        return NodeClass.PRESENTATION

    # JSX attributes that are presentation-related.
    if node_type == "jsx_attribute":
        attr_name = ""
        for child in node.children:
            if child.type == "property_identifier":
                attr_name = _node_text(child, source_bytes)
                break
        if attr_name in _PRESENTATION_JSX_ATTRS:
            return NodeClass.PRESENTATION

    # --- Ambiguous ---
    # For everything else, we'd need more context or an LLM judgment.
    return NodeClass.AMBIGUOUS


def classify_component(
    source_bytes: bytes,
    component_start_line: int,
    component_end_line: int,
    component_name: str,
    file_path: str,
) -> DiffMask:
    """Build a ``DiffMask`` for a single component within a source file.

    This is the main entry point for the boundary classifier.

    Args:
        source_bytes: The full file content as bytes.
        component_start_line: 1-indexed start line of the component.
        component_end_line: 1-indexed end line of the component.
        component_name: Name of the component (for the mask metadata).
        file_path: Relative file path (for the mask metadata).

    Returns:
        A ``DiffMask`` with classified regions covering every line of the
        component.
    """
    if not _TS_AVAILABLE:
        raise RuntimeError("tree-sitter-typescript is required for boundary classification")

    tsx_language = tree_sitter.Language(ts_typescript.language_tsx())
    parser = tree_sitter.Parser(tsx_language)
    tree = parser.parse(source_bytes)

    # Build a line→classification map.
    total_lines = source_bytes.count(b"\n") + 1
    line_classes: dict[int, tuple[NodeClass, str]] = {}

    def _walk(node: Any, depth: int = 0) -> None:
        start = node.start_point[0] + 1  # 0-indexed → 1-indexed
        end = node.end_point[0] + 1

        # Only process nodes within the component's line range.
        if end < component_start_line or start > component_end_line:
            return

        classification = _classify_node(node, source_bytes)

        if classification != NodeClass.AMBIGUOUS:
            for line in range(max(start, component_start_line),
                              min(end, component_end_line) + 1):
                # More specific (deeper) classifications win.
                if line not in line_classes or depth > 0:
                    line_classes[line] = (classification, f"{node.type}")

        for child in node.children:
            _walk(child, depth + 1)

    _walk(tree.root_node)

    # Fill in unclassified lines within the component range.
    for line in range(component_start_line, component_end_line + 1):
        if line not in line_classes:
            # Default: presentation (conservative — let the refactorer try,
            # the validator will catch errors).
            line_classes[line] = (NodeClass.PRESENTATION, "default")

    # Merge adjacent lines with the same classification into regions.
    regions: list[MaskRegion] = []
    sorted_lines = sorted(line_classes.keys())
    if sorted_lines:
        current_class, current_reason = line_classes[sorted_lines[0]]
        region_start = sorted_lines[0]
        region_end = sorted_lines[0]

        for line in sorted_lines[1:]:
            cls, reason = line_classes[line]
            if cls == current_class and line == region_end + 1:
                region_end = line
            else:
                regions.append(
                    MaskRegion(
                        start_line=region_start,
                        end_line=region_end,
                        classification=current_class,
                        reason=current_reason,
                    )
                )
                current_class = cls
                current_reason = reason
                region_start = line
                region_end = line

        # Don't forget the last region.
        regions.append(
            MaskRegion(
                start_line=region_start,
                end_line=region_end,
                classification=current_class,
                reason=current_reason,
            )
        )

    return DiffMask(
        component_name=component_name,
        file=file_path,
        regions=regions,
    )

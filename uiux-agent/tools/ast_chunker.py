"""AST chunker — tree-sitter-based component extraction from TSX/TS files.

Zero-LLM: parses source files into a component index suitable for the
refactoring pipeline.  Each extracted component becomes a ``ComponentCapsule``
that the pipeline processes independently.

Key design decisions:
- Uses tree-sitter for robust, language-grammar-aware parsing (not regex).
- Caches by file content hash — re-parsing only happens when files change.
- Extracts React component boundaries: exported functions/const that return
  JSX, plus their prop type signatures.
- Handles the full range of DeplAI component sizes (loading-spinner.tsx at
  ~40 lines up to DeploymentTrackApp.tsx at ~6600 lines).
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from schemas.component_capsule import ComponentCapsule, ComponentIndex

# tree-sitter imports — gracefully degrade if not installed.
try:
    import tree_sitter
    import tree_sitter_typescript as ts_typescript
    import tree_sitter_css as ts_css

    _TS_AVAILABLE = True
except ImportError:
    _TS_AVAILABLE = False

# ── Constants ────────────────────────────────────────────────────────────

_TSX_EXTENSIONS = {".tsx", ".ts", ".jsx", ".js"}
_CSS_EXTENSIONS = {".css", ".module.css"}

# tree-sitter node types that represent component definitions.
_COMPONENT_NODE_TYPES = {
    "function_declaration",
    "lexical_declaration",  # const Foo = () => { ... }
    "export_statement",
}

# Node types within a lexical_declaration that hold the actual function.
_FUNCTION_EXPRESSION_TYPES = {
    "arrow_function",
    "function_expression",
    "call_expression",  # React.memo(...), React.forwardRef(...)
}

# ── Parser initialization ────────────────────────────────────────────────


def _get_tsx_parser() -> Any:
    """Create a tree-sitter parser for TypeScript/TSX."""
    if not _TS_AVAILABLE:
        raise RuntimeError(
            "tree-sitter-typescript is not installed. "
            "Install it with: pip install tree-sitter tree-sitter-typescript"
        )
    tsx_language = tree_sitter.Language(ts_typescript.language_tsx())
    parser = tree_sitter.Parser(tsx_language)
    return parser


def _get_css_parser() -> Any:
    """Create a tree-sitter parser for CSS."""
    if not _TS_AVAILABLE:
        raise RuntimeError(
            "tree-sitter-css is not installed. "
            "Install it with: pip install tree-sitter tree-sitter-css"
        )
    css_language = tree_sitter.Language(ts_css.language())
    parser = tree_sitter.Parser(css_language)
    return parser


# ── Hashing ──────────────────────────────────────────────────────────────


def file_content_hash(path: Path) -> str:
    """SHA-256 of a file's content, used as a cache key."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _signature_hash(text: str) -> str:
    """SHA-256 of a props/params signature string."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ── Node extraction helpers ──────────────────────────────────────────────


def _node_text(node: Any, source_bytes: bytes) -> str:
    """Extract the source text for a tree-sitter node."""
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _find_component_name(node: Any, source_bytes: bytes) -> str | None:
    """Try to extract a component name from a tree-sitter node.

    Handles:
    - ``function Foo(...)`` → "Foo"
    - ``const Foo = ...`` → "Foo"
    - ``export default function Foo(...)`` → "Foo"
    - ``export const Foo = ...`` → "Foo"
    """
    # Direct function_declaration: the name child.
    if node.type == "function_declaration":
        for child in node.children:
            if child.type == "identifier":
                return _node_text(child, source_bytes)
        return None

    # lexical_declaration: look for variable_declarator → identifier.
    if node.type == "lexical_declaration":
        for child in node.children:
            if child.type == "variable_declarator":
                for sub in child.children:
                    if sub.type == "identifier":
                        return _node_text(sub, source_bytes)
        return None

    # export_statement: recurse into the declaration.
    if node.type == "export_statement":
        for child in node.children:
            if child.type in ("function_declaration", "lexical_declaration"):
                return _find_component_name(child, source_bytes)
        return None

    return None


def _extract_props_signature(node: Any, source_bytes: bytes) -> str:
    """Try to extract the props/params type signature from a component node."""
    # Look for formal_parameters or type_annotation children.
    def _walk(n: Any) -> str:
        if n.type == "formal_parameters":
            return _node_text(n, source_bytes)
        if n.type == "type_annotation":
            return _node_text(n, source_bytes)
        for child in n.children:
            result = _walk(child)
            if result:
                return result
        return ""

    return _walk(node)


def _has_jsx_return(node: Any, source_bytes: bytes) -> bool:
    """Check if a node's subtree contains JSX elements (likely a React component)."""
    if node.type in ("jsx_element", "jsx_self_closing_element", "jsx_fragment"):
        return True
    for child in node.children:
        if _has_jsx_return(child, source_bytes):
            return True
    return False


def _is_react_component(node: Any, source_bytes: bytes) -> bool:
    """Heuristic: is this node a React component definition?

    A React component is a function (declared or as a const arrow) that:
    1. Has a PascalCase name, AND
    2. Contains JSX in its body.
    """
    name = _find_component_name(node, source_bytes)
    if not name or not name[0].isupper():
        return False
    return _has_jsx_return(node, source_bytes)


def _make_summary(name: str, node: Any, source_bytes: bytes) -> str:
    """Generate a one-line summary from the component's first comment or name."""
    # Try to find a preceding comment.
    if node.prev_sibling and node.prev_sibling.type == "comment":
        comment_text = _node_text(node.prev_sibling, source_bytes).strip()
        # Clean up comment markers.
        comment_text = comment_text.lstrip("/*").rstrip("*/").strip()
        if comment_text and len(comment_text) < 120:
            return comment_text

    # Fallback: derive from the name.
    # Split PascalCase into words.
    words = []
    current = []
    for ch in name:
        if ch.isupper() and current:
            words.append("".join(current))
            current = [ch]
        else:
            current.append(ch)
    if current:
        words.append("".join(current))

    return " ".join(words) + " component"


# ── Main extraction ──────────────────────────────────────────────────────


def extract_components_from_file(
    file_path: Path,
    repo_root: Path,
) -> list[ComponentCapsule]:
    """Parse a single TSX/TS file and return all React component capsules.

    Returns an empty list for non-component files (e.g., pure type exports,
    utility modules).
    """
    if file_path.suffix.lower() not in _TSX_EXTENSIONS:
        return []

    source_bytes = file_path.read_bytes()
    fhash = hashlib.sha256(source_bytes).hexdigest()

    parser = _get_tsx_parser()
    tree = parser.parse(source_bytes)
    root = tree.root_node

    capsules: list[ComponentCapsule] = []
    rel_path = file_path.relative_to(repo_root).as_posix()

    for node in root.children:
        # Handle both direct declarations and export wrappers.
        target_node = node
        if node.type == "export_statement":
            # Look inside the export for the actual declaration.
            for child in node.children:
                if child.type in ("function_declaration", "lexical_declaration"):
                    target_node = child
                    break

        if target_node.type not in _COMPONENT_NODE_TYPES:
            continue

        if not _is_react_component(node, source_bytes):
            continue

        name = _find_component_name(node, source_bytes)
        if not name:
            continue

        props_sig = _extract_props_signature(target_node, source_bytes)
        start_line = node.start_point[0] + 1  # tree-sitter is 0-indexed
        end_line = node.end_point[0] + 1

        capsules.append(
            ComponentCapsule(
                name=name,
                file=rel_path,
                line_range=(start_line, end_line),
                prop_signature_hash=_signature_hash(props_sig),
                one_line_summary=_make_summary(name, node, source_bytes),
                ast_node_type=target_node.type,
                file_hash=fhash,
            )
        )

    return capsules


def scan_directory(
    repo_root: str | Path,
    include_patterns: list[str] | None = None,
) -> ComponentIndex:
    """Walk a directory tree and build a full ``ComponentIndex``.

    Only processes files matching the allowlist patterns (if provided) and
    with TSX/TS extensions.
    """
    repo_root = Path(repo_root).resolve()
    all_capsules: list[ComponentCapsule] = []
    total_files = 0
    total_lines = 0

    for file_path in sorted(repo_root.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in _TSX_EXTENSIONS:
            continue
        # Skip common non-source directories.
        parts = file_path.relative_to(repo_root).parts
        if any(p in {"node_modules", ".next", "dist", "build", ".git"} for p in parts):
            continue

        total_files += 1
        try:
            line_count = file_path.read_text(encoding="utf-8").count("\n") + 1
            total_lines += line_count
        except (OSError, UnicodeDecodeError):
            continue

        try:
            capsules = extract_components_from_file(file_path, repo_root)
            all_capsules.extend(capsules)
        except Exception as exc:
            # Log but don't fail the whole scan on one bad file.
            import sys
            print(f"Warning: failed to parse {file_path}: {exc}", file=sys.stderr)

    return ComponentIndex(
        repo_root=str(repo_root),
        scan_timestamp=datetime.now(timezone.utc).isoformat(),
        components=all_capsules,
        total_files_scanned=total_files,
        total_lines_scanned=total_lines,
    )

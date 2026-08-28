"""Business-logic boundary detection. Deterministic, conservative, untrusted-repo-safe."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from frontend_customization.models import (
    FRONTEND_EXTENSIONS,
    LOGIC_TOKEN_HINTS,
    PRESENTATION_TOKEN_HINTS,
    PROTECTED_PATH_HINTS,
    empty_boundary,
)
from frontend_customization.workspace import iter_files, read_text, relative_posix

IMPORT_RE = re.compile(r"from\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\)")
FUNCTION_RE = re.compile(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(")


def build_boundary(working_root: str, frontend_manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    root = Path(working_root).resolve()
    files = iter_files(root)
    relatives = [relative_posix(root, path) for path in files]
    boundary = empty_boundary()
    protected_files: list[str] = []
    protected_directories: set[str] = set()
    protected_symbols: set[str] = set()
    protected_functions: set[str] = set()
    protected_imports: set[str] = set()
    allowed: list[str] = []

    for relative in relatives:
        posix = relative.replace("\\", "/")
        lowered = f"/{posix.lower()}"
        is_protected = any(hint in lowered or posix.lower().endswith(hint) for hint in PROTECTED_PATH_HINTS)
        if is_protected:
            protected_files.append(posix)
            parent = str(Path(posix).parent).replace("\\", "/")
            if parent not in {".", ""}:
                protected_directories.add(parent)
            text = read_text(root / relative) or ""
            for match in FUNCTION_RE.finditer(text):
                name = match.group(1) or match.group(2)
                if name:
                    protected_functions.add(name)
                    protected_symbols.add(name)
            for match in IMPORT_RE.finditer(text):
                spec = match.group(1) or match.group(2)
                if spec:
                    protected_imports.add(spec)
            continue

        suffix = Path(posix).suffix.lower()
        if suffix in FRONTEND_EXTENSIONS and not any(hint in lowered for hint in ("/api/", "/server/", "/backend/")):
            allowed.append(posix)
            continue
        if posix.endswith("tailwind.config.ts") or posix.endswith("tailwind.config.js") or posix.endswith("postcss.config.js"):
            allowed.append(posix)

    # Prefer explicit frontend files from the map when present.
    mapped = list((frontend_manifest or {}).get("frontend_files") or [])
    for item in mapped:
        posix = str(item).replace("\\", "/")
        if posix not in protected_files and posix not in allowed:
            allowed.append(posix)

    boundary.update(
        {
            "protected_files": sorted(set(protected_files))[:400],
            "protected_directories": sorted(protected_directories)[:80],
            "protected_symbols": sorted(protected_symbols)[:120],
            "protected_functions": sorted(protected_functions)[:120],
            "protected_imports": sorted(protected_imports)[:120],
            "allowed_frontend_surface": allowed[:500],
        }
    )
    return boundary


def classify_file_regions(path: str, content: str) -> dict[str, Any]:
    """Line-level presentation vs logic mask used by implementation agents."""
    presentation: list[list[int]] = []
    logic: list[list[int]] = []
    for index, line in enumerate(content.splitlines(), start=1):
        lowered = line.lower()
        logic_hit = any(token in lowered for token in LOGIC_TOKEN_HINTS)
        presentation_hit = any(token in lowered for token in PRESENTATION_TOKEN_HINTS)
        if logic_hit and not presentation_hit:
            logic.append([index, index])
        elif presentation_hit:
            presentation.append([index, index])
        elif logic_hit:
            logic.append([index, index])
    return {
        "file": path,
        "presentation": _merge_ranges(presentation),
        "logic": _merge_ranges(logic),
    }


def _merge_ranges(ranges: list[list[int]]) -> list[list[int]]:
    if not ranges:
        return []
    ordered = sorted(ranges)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        if start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged

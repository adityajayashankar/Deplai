"""Deterministic policy engine for frontend customization.

Important controls live here, not only in prompts. Repository content cannot
override these policies.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from frontend_customization.models import (
    BLOCKED_CHANGE_CLASSES,
    PERMITTED_CHANGE_CLASSES,
    POLICY_NAMES,
    SECRET_FILENAMES,
    SECRET_SUFFIXES,
    ChangeClass,
)

_ENV_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|secret|password|token|private[_-]?key|aws_secret|stripe_secret)\b\s*[:=]"
)
_DESTRUCTIVE_HINTS = (
    "rmtree",
    "unlink(",
    "drop table",
    "drop database",
    "format disk",
    "rm -rf",
    "shutil.rmtree",
)
_DEPENDENCY_FILES = {"package.json", "pnpm-workspace.yaml", "requirements.txt", "pyproject.toml", "go.mod"}


class PolicyViolation(Exception):
    def __init__(self, policy: str, detail: str, file_path: str = "") -> None:
        super().__init__(detail)
        self.policy = policy
        self.detail = detail
        self.file_path = file_path


def classify_change(path: str, before: str, after: str, boundary: dict[str, Any] | None = None) -> ChangeClass:
    """Classify a proposed file change. Conservative: unknown or logic → blocked."""
    relative = path.replace("\\", "/").lstrip("/")
    protected_files = set((boundary or {}).get("protected_files") or [])
    protected_dirs = [str(item).replace("\\", "/").rstrip("/") for item in (boundary or {}).get("protected_directories") or []]
    allowed = {(item or "").replace("\\", "/").lstrip("/") for item in (boundary or {}).get("allowed_frontend_surface") or []}

    if relative in protected_files or any(relative == d or relative.startswith(f"{d}/") for d in protected_dirs):
        return ChangeClass.BUSINESS_LOGIC
    if allowed and not _path_is_allowed(relative, allowed):
        posix = f"/{relative.lower()}"
        if relative.lower().endswith((".css", ".scss", ".sass")) and any(
            hint in posix for hint in ("/src/", "/app/", "/styles/", "/css/", "/frontend/")
        ):
            return ChangeClass.STYLE
        return ChangeClass.UNKNOWN

    lowered_after = after.lower()
    lowered_before = before.lower()
    logic_markers = ("fetch(", "axios.", "prisma.", "process.env", "authorization", "usecallback", "useeffect", "usememo")
    presentation_markers = ("classname", "style=", "padding", "margin", "font-", "color:", "aria-", "@media", ":root")

    if _ENV_ASSIGNMENT.search(after) and not _ENV_ASSIGNMENT.search(before):
        return ChangeClass.BUSINESS_LOGIC

    added = _added_lines(before, after)
    added_lower = "\n".join(added).lower()
    if any(marker in added_lower for marker in ("function ", "const fetch", "await ", "sql", "select ", "insert ", "password")):
        if not any(marker in added_lower for marker in presentation_markers):
            return ChangeClass.BUSINESS_LOGIC

    style_only = relative.endswith((".css", ".scss", ".sass", ".less"))
    if style_only:
        if any(marker in added_lower for marker in logic_markers) and "url(" not in added_lower:
            return ChangeClass.UNKNOWN
        return ChangeClass.STYLE

    presentation_hits = sum(1 for marker in presentation_markers if marker in lowered_after)
    logic_hits = sum(1 for marker in logic_markers if marker in added_lower)
    if logic_hits and not _logic_unchanged(before, after, logic_markers):
        return ChangeClass.BUSINESS_LOGIC
    if presentation_hits:
        return ChangeClass.UI if "aria-" in lowered_after or "role=" in lowered_after else ChangeClass.STYLE
    if before == after:
        return ChangeClass.STYLE
    if _mostly_markup(added_lower):
        return ChangeClass.UX
    return ChangeClass.UNKNOWN


def _path_is_allowed(relative: str, allowed: set[str]) -> bool:
    for item in allowed:
        candidate = item.replace("\\", "/").rstrip("/")
        if not candidate:
            continue
        if candidate.endswith("/**"):
            prefix = candidate[:-3]
            if relative == prefix or relative.startswith(f"{prefix}/"):
                return True
        if relative == candidate or relative.startswith(f"{candidate}/"):
            return True
    return False


def _added_lines(before: str, after: str) -> list[str]:
    before_set = set(before.splitlines())
    return [line for line in after.splitlines() if line not in before_set]


def _logic_unchanged(before: str, after: str, markers: tuple[str, ...]) -> bool:
    def extract(text: str) -> list[str]:
        lines = []
        for line in text.splitlines():
            lowered = line.lower()
            if any(marker in lowered for marker in markers):
                lines.append(line.strip())
        return lines

    return extract(before) == extract(after)


def _mostly_markup(text: str) -> bool:
    if not text.strip():
        return True
    tags = text.count("<") + text.count("class=") + text.count("classname")
    return tags >= 1 and "fetch(" not in text


def evaluate_change(
    *,
    path: str,
    before: str,
    after: str,
    classification: ChangeClass | str,
    boundary: dict[str, Any] | None = None,
    approved_dependencies: set[str] | None = None,
) -> list[dict[str, str]]:
    """Return a list of policy violations. Empty means the change may proceed."""
    relative = Path(path).as_posix().lstrip("/")
    name = Path(relative).name.lower()
    suffix = Path(relative).suffix.lower()
    violations: list[dict[str, str]] = []
    change_class = classification if isinstance(classification, ChangeClass) else ChangeClass(str(classification))

    if change_class in BLOCKED_CHANGE_CLASSES:
        violations.append(
            {
                "policy": "NO_BUSINESS_LOGIC_MODIFICATION",
                "detail": f"{relative} classified as {change_class.value} and cannot be auto-modified.",
                "file": relative,
            }
        )

    protected_files = {(item or "").replace("\\", "/") for item in (boundary or {}).get("protected_files") or []}
    protected_dirs = [(item or "").replace("\\", "/").rstrip("/") for item in (boundary or {}).get("protected_directories") or []]
    if relative in protected_files or any(relative == d or relative.startswith(f"{d}/") for d in protected_dirs):
        violations.append(
            {
                "policy": "NO_PROTECTED_FILE_MODIFICATION",
                "detail": f"{relative} is inside the business-logic boundary.",
                "file": relative,
            }
        )

    if name in SECRET_FILENAMES or suffix in SECRET_SUFFIXES:
        violations.append(
            {
                "policy": "NO_SECRET_ACCESS",
                "detail": f"Refusing to modify secret-bearing file {relative}.",
                "file": relative,
            }
        )

    if _ENV_ASSIGNMENT.search(after) and after != before:
        violations.append(
            {
                "policy": "NO_CREDENTIAL_EXFILTRATION",
                "detail": f"Change appears to introduce or alter credentials in {relative}.",
                "file": relative,
            }
        )

    if name in _DEPENDENCY_FILES and _dependency_delta(before, after):
        added = _dependency_delta(before, after)
        unapproved = sorted(added - (approved_dependencies or set()))
        if unapproved:
            violations.append(
                {
                    "policy": "NO_UNAPPROVED_DEPENDENCY",
                    "detail": f"Unapproved dependency changes: {', '.join(unapproved[:8])}.",
                    "file": relative,
                }
            )

    lowered = after.lower()
    if any(hint in lowered for hint in _DESTRUCTIVE_HINTS) and any(hint not in before.lower() for hint in _DESTRUCTIVE_HINTS):
        violations.append(
            {
                "policy": "NO_DESTRUCTIVE_OPERATION",
                "detail": f"Change introduces a destructive operation in {relative}.",
                "file": relative,
            }
        )

    if change_class not in PERMITTED_CHANGE_CLASSES and change_class not in BLOCKED_CHANGE_CLASSES:
        violations.append(
            {
                "policy": "NO_BUSINESS_LOGIC_MODIFICATION",
                "detail": f"Unsupported change class {change_class}.",
                "file": relative,
            }
        )

    return violations


def evaluate_preview_access(url: str | None) -> list[dict[str, str]]:
    if not url:
        return []
    lowered = url.lower()
    if lowered.startswith("http://127.0.0.1") or lowered.startswith("http://localhost") or lowered.startswith("/"):
        return []
    return [
        {
            "policy": "NO_UNSAFE_PREVIEW_ACCESS",
            "detail": "Preview URLs must stay on loopback or the platform proxy.",
            "file": "",
        }
    ]


def policy_catalog() -> list[str]:
    return list(POLICY_NAMES)


def _dependency_delta(before: str, after: str) -> set[str]:
    def names(text: str) -> set[str]:
        found: set[str] = set()
        for match in re.finditer(r'"([^"]+)":\s*"([^"]+)"', text):
            key = match.group(1)
            if key in {"name", "version", "description", "license", "private", "type", "main", "packageManager"}:
                continue
            if key.startswith("@" ) or re.match(r"^[a-z0-9][a-z0-9._-]*$", key, re.I):
                found.add(key)
        return found

    try:
        return names(after) - names(before)
    except Exception:
        return set()

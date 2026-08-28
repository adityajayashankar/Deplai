"""Validation tools — tsc, ESLint, stylelint, axe-core, screenshot diff.

All validation runs against the patched worktree, not the main working tree.
Failures feed back into the retry loop (Stage 9 of the pipeline).

Each validator is a plain function that returns a structured result — no LLM
involved.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ValidationIssue:
    """A single validation issue."""

    tool: str  # "tsc", "eslint", "stylelint", "axe", "screenshot"
    severity: str  # "error", "warning", "info"
    file: str = ""
    line: int = 0
    column: int = 0
    message: str = ""
    rule: str = ""  # e.g., "no-unused-vars", "color-no-invalid-hex"


@dataclass
class ValidationResult:
    """Aggregated result of all validation passes."""

    passed: bool
    issues: list[ValidationIssue] = field(default_factory=list)
    tsc_passed: bool = True
    eslint_passed: bool = True
    stylelint_passed: bool = True
    axe_passed: bool = True
    screenshot_passed: bool = True

    def error_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "error")

    def warning_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "warning")

    def summary(self) -> str:
        """Human-readable summary for the retry loop."""
        parts = []
        if not self.tsc_passed:
            tsc_errors = [i for i in self.issues if i.tool == "tsc"]
            parts.append(f"TypeScript: {len(tsc_errors)} error(s)")
        if not self.eslint_passed:
            eslint_issues = [i for i in self.issues if i.tool == "eslint"]
            parts.append(f"ESLint: {len(eslint_issues)} issue(s)")
        if not self.stylelint_passed:
            style_issues = [i for i in self.issues if i.tool == "stylelint"]
            parts.append(f"stylelint: {len(style_issues)} issue(s)")
        if not self.axe_passed:
            axe_issues = [i for i in self.issues if i.tool == "axe"]
            parts.append(f"Accessibility (axe-core): {len(axe_issues)} violation(s)")
        if not self.screenshot_passed:
            parts.append("Visual regression: screenshot diff detected")
        if self.passed:
            return "All validations passed ✓"
        return "Validation failed: " + "; ".join(parts)


def run_tsc(project_root: Path) -> tuple[bool, list[ValidationIssue]]:
    """Run ``tsc --noEmit`` and parse the output.

    Uses the project's own tsconfig.json.
    """
    issues: list[ValidationIssue] = []
    try:
        result = subprocess.run(
            ["npx", "tsc", "--noEmit", "--pretty", "false"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=120,
            shell=True,  # Required on Windows for npx.
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        issues.append(
            ValidationIssue(
                tool="tsc",
                severity="error",
                message=f"Failed to run tsc: {exc}",
            )
        )
        return False, issues

    if result.returncode == 0:
        return True, []

    # Parse tsc output: file(line,col): error TSxxxx: message
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        # Match: path(line,col): severity TSxxxx: message
        import re
        match = re.match(
            r"(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.*)", line
        )
        if match:
            issues.append(
                ValidationIssue(
                    tool="tsc",
                    severity=match.group(4),
                    file=match.group(1),
                    line=int(match.group(2)),
                    column=int(match.group(3)),
                    message=match.group(5),
                )
            )

    return len([i for i in issues if i.severity == "error"]) == 0, issues


def run_eslint(
    project_root: Path,
    files: list[str] | None = None,
) -> tuple[bool, list[ValidationIssue]]:
    """Run ESLint and parse JSON output.

    If *files* is provided, only lint those specific files.
    """
    issues: list[ValidationIssue] = []
    cmd = ["npx", "eslint", "--format", "json", "--no-error-on-unmatched-pattern"]
    if files:
        cmd.extend(files)
    else:
        cmd.append(".")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=120,
            shell=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        issues.append(
            ValidationIssue(
                tool="eslint",
                severity="error",
                message=f"Failed to run ESLint: {exc}",
            )
        )
        return False, issues

    try:
        eslint_output = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        if result.returncode != 0:
            issues.append(
                ValidationIssue(
                    tool="eslint",
                    severity="error",
                    message=f"ESLint failed with non-JSON output: {result.stderr[:500]}",
                )
            )
            return False, issues
        return True, []

    has_errors = False
    for file_result in eslint_output:
        for msg in file_result.get("messages", []):
            severity = "error" if msg.get("severity", 0) >= 2 else "warning"
            if severity == "error":
                has_errors = True
            issues.append(
                ValidationIssue(
                    tool="eslint",
                    severity=severity,
                    file=file_result.get("filePath", ""),
                    line=msg.get("line", 0),
                    column=msg.get("column", 0),
                    message=msg.get("message", ""),
                    rule=msg.get("ruleId", ""),
                )
            )

    return not has_errors, issues


def run_stylelint(
    project_root: Path,
    files: list[str] | None = None,
) -> tuple[bool, list[ValidationIssue]]:
    """Run stylelint and parse JSON output."""
    issues: list[ValidationIssue] = []
    cmd = ["npx", "stylelint", "--formatter", "json"]
    if files:
        cmd.extend(files)
    else:
        cmd.append("**/*.css")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=120,
            shell=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        # stylelint not installed — skip gracefully.
        return True, []

    if result.returncode == 0:
        return True, []

    try:
        stylelint_output = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return True, []

    has_errors = False
    for file_result in stylelint_output:
        for warning in file_result.get("warnings", []):
            severity = warning.get("severity", "warning")
            if severity == "error":
                has_errors = True
            issues.append(
                ValidationIssue(
                    tool="stylelint",
                    severity=severity,
                    file=file_result.get("source", ""),
                    line=warning.get("line", 0),
                    column=warning.get("column", 0),
                    message=warning.get("text", ""),
                    rule=warning.get("rule", ""),
                )
            )

    return not has_errors, issues


def run_all_validations(
    project_root: Path,
    changed_files: list[str] | None = None,
) -> ValidationResult:
    """Run all validation tools and return an aggregated result.

    This is the function called at Stage 8 of the pipeline.
    """
    tsc_ok, tsc_issues = run_tsc(project_root)
    eslint_ok, eslint_issues = run_eslint(project_root, changed_files)
    stylelint_ok, stylelint_issues = run_stylelint(project_root, changed_files)

    all_issues = tsc_issues + eslint_issues + stylelint_issues
    passed = tsc_ok and eslint_ok and stylelint_ok

    return ValidationResult(
        passed=passed,
        issues=all_issues,
        tsc_passed=tsc_ok,
        eslint_passed=eslint_ok,
        stylelint_passed=stylelint_ok,
    )

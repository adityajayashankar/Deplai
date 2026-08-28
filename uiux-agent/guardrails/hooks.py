"""Custom guardrail hooks for the UI/UX refactoring pipeline.

These hooks run as pre-processing steps before repo content reaches any LLM.
They sit on top of Agno's built-in ``PromptInjectionGuardrail`` and
``PIIDetectionGuardrail``, adding pipeline-specific checks.
"""

from __future__ import annotations

from typing import Any


class AllowlistGuardrail:
    """Pre-hook that validates all file paths in the agent's tool arguments
    against the pipeline's ``Allowlist`` before the tool executes.

    This is defense-in-depth: the tool itself also checks, but this hook
    catches violations *before* the tool function is even entered, which
    means the error message reaches the agent's reasoning trace for
    self-correction.
    """

    def __init__(self, allowlist: Any) -> None:
        self.allowlist = allowlist

    def __call__(self, tool_name: str, tool_args: dict[str, Any]) -> dict[str, Any]:
        """Check file path arguments against the allowlist.

        Raises ``PermissionError`` if any path is denied.
        """
        path_keys = {"file_path", "path", "target_file", "file", "component_file"}
        for key in path_keys:
            if key in tool_args:
                path_val = tool_args[key]
                if isinstance(path_val, str):
                    self.allowlist.check_write(path_val)
        return tool_args


class DiffMaskGuardrail:
    """Pre-hook that validates patch diffs against the boundary classifier's
    diff mask.

    Ensures that patches only touch lines classified as ``presentation``.
    Rejects any patch that modifies a ``logic`` line.
    """

    def __init__(self, masks: dict[str, Any]) -> None:
        """
        Args:
            masks: Mapping of component_name -> DiffMask.
        """
        self.masks = masks

    def __call__(self, tool_name: str, tool_args: dict[str, Any]) -> dict[str, Any]:
        """Validate that the patch diff only touches presentation lines."""
        if tool_name != "write_patch":
            return tool_args

        component_id = tool_args.get("component_id", "")
        diff_text = tool_args.get("diff", "")

        if component_id not in self.masks:
            raise ValueError(
                f"No diff mask found for component '{component_id}'. "
                f"The boundary classifier must run before the refactorer."
            )

        mask = self.masks[component_id]
        logic_lines = mask.logic_lines()

        # Parse the diff to find which lines are being modified.
        modified_lines = _parse_diff_target_lines(diff_text)
        violations = modified_lines & logic_lines

        if violations:
            violation_list = sorted(violations)[:10]
            raise PermissionError(
                f"Diff mask violation: patch for '{component_id}' modifies "
                f"logic-classified lines: {violation_list}"
                f"{' (and more)' if len(violations) > 10 else ''}. "
                f"Only presentation-classified lines may be changed."
            )

        return tool_args


def _parse_diff_target_lines(diff_text: str) -> set[int]:
    """Extract the set of target-file line numbers modified by a unified diff.

    Parses ``@@ -a,b +c,d @@`` hunks and counts ``-`` and `` `` lines to
    determine which original lines are being modified or removed.
    """
    import re

    modified: set[int] = set()
    current_line = 0

    for line in diff_text.splitlines():
        hunk_match = re.match(r"^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@", line)
        if hunk_match:
            current_line = int(hunk_match.group(1))
            continue

        if current_line == 0:
            continue

        if line.startswith("-"):
            # This line is being removed/modified in the original file.
            modified.add(current_line)
            current_line += 1
        elif line.startswith("+"):
            # Added line — doesn't consume a line number in the original.
            pass
        elif line.startswith(" ") or line == "":
            # Context line.
            current_line += 1

    return modified

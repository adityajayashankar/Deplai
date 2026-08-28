"""Reporter Agent — diff aggregation + PR description generation.

This agent implements Stage 11 of the pipeline.  It takes:
1. All successful patches from the Component Refactorer(s).
2. The design-token spec and style direction.

And produces a human-readable PR description summarizing what changed and why.

Model tier: SMALL (summarization, no creative coding).
"""

from __future__ import annotations

import os
from typing import Any

from agno.agent import Agent


REPORTER_INSTRUCTIONS = """You are the Reporter agent in a UI/UX refactoring pipeline.

## Your Role
You receive a list of patches that were applied to frontend components.
Your job is to produce a **PR description** that:

1. **Summarizes the overall change**: What style direction was applied and why.
2. **Lists each component** with a one-line summary of what changed.
3. **Highlights any notable decisions**: Token changes, accessibility
   improvements, responsive adjustments.
4. **Notes any components that failed** validation and were rolled back.
5. **Includes a "Before/After" section** if screenshot data is available.

## Format
Use Markdown. Structure:
```
## UI/UX Refactor: [Style Direction]

### Summary
[1-2 paragraph overview]

### Components Modified
| Component | File | Changes |
|-----------|------|---------|
| ... | ... | ... |

### Design Token Changes
- [List of new/modified tokens]

### Accessibility
- [WCAG compliance notes]

### Rollbacks
- [Any components that failed validation]
```

Keep it concise but informative — this will be read by reviewers."""


def build_reporter_agent(db: Any) -> Agent:
    """Factory function to create the Reporter agent."""
    model_id = os.environ.get("SMALL_MODEL", "anthropic:claude-haiku-3-20240307")

    return Agent(
        name="Reporter",
        model=model_id,
        instructions=REPORTER_INSTRUCTIONS,
        db=db,
        markdown=True,
    )


def aggregate_diffs(patches: list[dict[str, Any]]) -> str:
    """Aggregate multiple patch results into a summary for the Reporter.

    This is a pure function (no LLM) that prepares the input for the
    Reporter agent.
    """
    lines = [f"# Patch Summary ({len(patches)} components)\n"]

    succeeded = [p for p in patches if p.get("success")]
    failed = [p for p in patches if not p.get("success")]

    if succeeded:
        lines.append(f"## Succeeded ({len(succeeded)})")
        for p in succeeded:
            lines.append(
                f"- **{p.get('component_name', '?')}** ({p.get('file_path', '?')}): "
                f"+{p.get('lines_added', 0)} -{p.get('lines_removed', 0)}"
            )
        lines.append("")

    if failed:
        lines.append(f"## Failed ({len(failed)})")
        for p in failed:
            lines.append(
                f"- **{p.get('component_name', '?')}** ({p.get('file_path', '?')}): "
                f"{p.get('error', 'Unknown error')}"
            )
        lines.append("")

    return "\n".join(lines)

"""UI/UX Refactor Workflow — the 12-stage pipeline."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from agno.workflow import Condition, Step, Workflow
from agno.workflow.types import StepInput, StepOutput

from agents.component_refactor import set_allowlist
from tools.allowlist import Allowlist
from workflows.executors import (
    _load_envelope,
    _output,
    _state_from_envelope,
    aggregate_report,
    build_design_system_prompt,
    build_refactor_prompt,
    classify_boundaries,
    extract_design_tokens,
    finalize_run,
    init_run_context,
    merge_clarification,
    needs_clarification,
    run_vagueness_gate,
    scan_and_index,
    skip_clarification,
    validate_patches,
)

_DB: Any = None


def _has_llm_provider() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY"))


def _get_agents() -> dict[str, Any]:
    from agents.component_refactor import build_component_refactor_agent
    from agents.design_system import build_design_system_agent
    from agents.reporter import build_reporter_agent

    if _DB is None:
        raise RuntimeError("Workflow DB is not initialized.")
    return {
        "design_system": build_design_system_agent(_DB),
        "refactorer": build_component_refactor_agent(_DB),
        "reporter": build_reporter_agent(_DB),
    }


def _extract_first_json_object(text: str) -> dict[str, Any] | None:
    """Robustly extract the first balanced JSON object from noisy LLM output.

    Free models emit thinking prose, then ```json fenced JSON, then trailing
    text. Bracket-matching with quote-awareness picks the FIRST top-level
    object — not the outermost, which often catches reasoning.
    """
    raw = str(text or "")
    # Strip markdown code fences if present
    if "```" in raw:
        import re
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                raw = m.group(1)
    depth = 0
    in_str = False
    esc = False
    start = -1
    for i, ch in enumerate(raw):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start != -1:
                candidate = raw[start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    # Try a single-line sanitization pass for embedded newlines.
                    try:
                        return json.loads(candidate.replace("\n", "\\n").replace("\r", "\\r"))
                    except json.JSONDecodeError:
                        start = -1
                        continue
    return None


def _capture_design_tokens(step_input: StepInput) -> StepOutput:
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    agent_output = step_input.previous_step_content
    if isinstance(agent_output, StepOutput):
        agent_output = agent_output.content
    text = str(agent_output or "").strip()
    if text:
        # Use balanced JSON extraction, not bracket find — reasoning prose
        # routinely contains stray { and } that broke the old implementation.
        parsed = _extract_first_json_object(text)
        if isinstance(parsed, dict):
            try:
                from schemas.token_spec import DesignTokenSpec

                state.design_tokens = DesignTokenSpec.model_validate(parsed)
            except Exception as exc:
                envelope.summary = (
                    f"Design-system output did not match DesignTokenSpec: {exc}. "
                    "Continuing with extracted tokens only."
                )
        else:
            envelope.summary = (
                "Design-system output was not a single JSON object; "
                "continuing with extracted tokens only."
            )
    else:
        envelope.summary = "Design-system agent returned empty output; using extracted tokens only."
    envelope.stage = "design_system"
    if not envelope.summary or envelope.summary == "Design token specification updated.":
        envelope.summary = "Design token specification updated."
    envelope.state = state.to_dict()
    return _output(envelope)


def _capture_refactor_output(step_input: StepInput) -> StepOutput:
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    agent_output = step_input.previous_step_content
    if isinstance(agent_output, StepOutput):
        agent_output = agent_output.content

    text = str(agent_output or "").strip()
    patches_found: list[dict[str, Any]] = []
    if text:
        # The agent may have called write_patch (manifest in tool_calls) or
        # emitted diffs as JSON / fenced text. Try every channel.
        parsed = _extract_first_json_object(text)
        if isinstance(parsed, dict):
            for key in ("patches", "changes", "diffs", "results"):
                if isinstance(parsed.get(key), list):
                    for item in parsed[key]:
                        if isinstance(item, dict):
                            patches_found.append(
                                {
                                    "success": bool(item.get("success", True)),
                                    "component_name": str(item.get("component_name") or item.get("component_id") or "unknown"),
                                    "file_path": str(item.get("file_path") or item.get("path") or ""),
                                    "diff": str(item.get("diff") or ""),
                                    "summary": str(item.get("description") or item.get("summary") or "")[:2000],
                                }
                            )
                    break

    if patches_found:
        state.patches.extend(patches_found)
        envelope.summary = f"Component refactor produced {len(patches_found)} patch entry(s)."
    else:
        # Refactorer didn't emit structured output. Record raw for review
        # but do not lie about success — the downstream validator will catch it.
        state.patches.append(
            {
                "success": False,
                "component_name": "batch",
                "file_path": "",
                "summary": text[:2000] or "Refactorer produced no parseable patch set.",
            }
        )
        envelope.summary = (
            "Component refactor agent did not return a parseable patch set; "
            "recorded raw output for review."
        )
    envelope.stage = "refactor"
    envelope.state = state.to_dict()
    return _output(envelope)


def _design_system_executor(step_input: StepInput) -> StepOutput:
    if not _has_llm_provider():
        envelope = _load_envelope(step_input)
        envelope.stage = "design_system"
        envelope.summary = (
            "Skipped LLM design-system authoring (no ANTHROPIC_API_KEY/OPENAI_API_KEY). "
            "Using extracted tokens only."
        )
        return _output(envelope)
    prompt = build_design_system_prompt(step_input)
    response = _get_agents()["design_system"].run(prompt)
    return StepOutput(content=response.content or "")


def _refactor_executor(step_input: StepInput) -> StepOutput:
    if not _has_llm_provider():
        envelope = _load_envelope(step_input)
        envelope.stage = "refactor"
        envelope.summary = (
            "Skipped component refactor generation (no ANTHROPIC_API_KEY/OPENAI_API_KEY). "
            "Deterministic scan, token extraction, and validation still ran."
        )
        return _output(envelope)
    prompt = build_refactor_prompt(step_input)
    response = _get_agents()["refactorer"].run(prompt)
    return StepOutput(content=response.content or "")


def _reporter_executor(step_input: StepInput) -> StepOutput:
    prompt = str(step_input.input or step_input.previous_step_content or "")
    if not _has_llm_provider():
        return StepOutput(content=prompt)
    response = _get_agents()["reporter"].run(prompt)
    return StepOutput(content=response.content or "")


def build_uiux_refactor_workflow(db: Any) -> Workflow:
    """Build the complete UI/UX refactoring Workflow."""
    global _DB
    _DB = db

    repo_root = os.environ.get("TARGET_REPO_ROOT", "../Connector/src")
    repo_root_abs = Path(repo_root).resolve()
    allowlist = Allowlist(repo_root_abs)
    set_allowlist(allowlist)

    clarification_branch = Condition(
        name="ClarificationGate",
        evaluator=needs_clarification,
        steps=[
            Step(
                name="Clarifier",
                executor=merge_clarification,
                requires_user_input=True,
                user_input_message=(
                    "Before refactoring begins, provide a style direction and scope. "
                    "Example style: enterprise SaaS dashboard. Example scope: features/dashboard/*."
                ),
                user_input_schema=[
                    {"name": "style_direction", "type": "string", "required": True},
                    {"name": "scope", "type": "string", "required": True},
                    {"name": "constraints", "type": "string", "required": False},
                    {"name": "references", "type": "string", "required": False},
                ],
                description="HITL clarification for style direction and scope.",
            ),
        ],
        else_steps=[
            Step(
                name="SkipClarification",
                executor=skip_clarification,
                description="Proceed without clarifier when the request is specific.",
            ),
        ],
    )

    steps = [
        Step(name="InitContext", executor=init_run_context, description="Parse trusted run context."),
        Step(name="ScanComponents", executor=scan_and_index, description="AST scan and component index."),
        Step(name="ExtractTokens", executor=extract_design_tokens, description="Extract design tokens from CSS."),
        Step(name="VaguenessGate", executor=run_vagueness_gate, description="Deterministic vagueness gate."),
        clarification_branch,
        Step(
            name="DesignSystem",
            executor=_design_system_executor,
            description="Author or extend the design token specification.",
        ),
        Step(
            name="CaptureDesignTokens",
            executor=_capture_design_tokens,
            description="Persist design-system output.",
        ),
        Step(
            name="ClassifyBoundaries",
            executor=classify_boundaries,
            description="Build presentation/logic diff masks.",
        ),
        Step(
            name="ComponentRefactor",
            executor=_refactor_executor,
            description="Generate presentation-only patches for in-scope components.",
        ),
        Step(
            name="CaptureRefactorOutput",
            executor=_capture_refactor_output,
            description="Record refactor agent output.",
        ),
        Step(name="Validate", executor=validate_patches, description="Run tsc/eslint/stylelint."),
        Step(name="AggregateReport", executor=aggregate_report, description="Aggregate patch ledger."),
        Step(
            name="Reporter",
            executor=_reporter_executor,
            description="Generate PR-style summary.",
        ),
        Step(name="Finalize", executor=finalize_run, description="Finalize run for the Connector UI."),
    ]

    return Workflow(
        id="uiux-refactor-agent",
        name="UIUXRefactor",
        db=db,
        description=(
            "Multi-agent UI/UX refactoring pipeline. Upgrades frontend "
            "components to enterprise quality — component by component, "
            "patch by patch — without touching business logic."
        ),
        steps=steps,
    )

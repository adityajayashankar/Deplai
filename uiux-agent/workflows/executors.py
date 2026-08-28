"""Workflow step executors for the UI/UX refactor pipeline."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from agno.workflow.types import StepInput, StepOutput

from agents.clarifier import vagueness_gate
from agents.reporter import aggregate_diffs
from schemas.component_capsule import ComponentIndex
from schemas.token_spec import DesignTokenSpec
from tools.ast_chunker import scan_directory
from tools.boundary_classifier import classify_component
from tools.token_extractor import extract_tokens_from_file
from tools.validator import run_all_validations
from workflows.context import parse_run_context
from workflows.state import PipelineState


@dataclass
class StepEnvelope:
    """JSON-serializable payload passed between deterministic workflow steps."""

    stage: str
    summary: str
    user_message: str
    repo_root: str
    project_id: str
    state: dict[str, Any] = field(default_factory=dict)
    gate: dict[str, Any] = field(default_factory=dict)
    error: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: Any) -> StepEnvelope:
        if isinstance(raw, cls):
            return raw
        if isinstance(raw, dict):
            return cls(**raw)
        if isinstance(raw, str):
            text = raw.strip()
            if text.startswith("{"):
                return cls(**json.loads(text))
        return cls(
            stage="unknown",
            summary=str(raw or ""),
            user_message="",
            repo_root="",
            project_id="",
        )


def _fallback_repo_root() -> str:
    return os.environ.get("TARGET_REPO_ROOT", "../Connector/src")


def _load_envelope(step_input: StepInput) -> StepEnvelope:
    raw = step_input.get_last_step_content()
    if raw is None:
        raw = step_input.input
    if isinstance(raw, StepEnvelope):
        return raw
    if isinstance(raw, StepOutput):
        return StepEnvelope.from_json(raw.content)
    return StepEnvelope.from_json(raw)


def _state_from_envelope(envelope: StepEnvelope) -> PipelineState:
    repo_root = envelope.repo_root or _fallback_repo_root()
    state = PipelineState(repo_root=repo_root)
    data = envelope.state or {}
    if data.get("target_css"):
        state.target_css = data["target_css"]
    if data.get("clarification"):
        state.clarification = dict(data["clarification"])
    if data.get("style_direction"):
        state.style_direction = data["style_direction"]
    if data.get("scope"):
        state.scope = data["scope"]
    if data.get("patches"):
        state.patches = list(data["patches"])
    if data.get("component_index"):
        state.component_index = ComponentIndex.model_validate(data["component_index"])
    if data.get("design_tokens"):
        state.design_tokens = DesignTokenSpec.model_validate(data["design_tokens"])
    return state


def _envelope_from_state(
    state: PipelineState,
    *,
    stage: str,
    summary: str,
    user_message: str,
    project_id: str,
    gate: dict[str, Any] | None = None,
    error: str = "",
) -> StepEnvelope:
    return StepEnvelope(
        stage=stage,
        summary=summary,
        user_message=user_message,
        repo_root=str(state.repo_root),
        project_id=project_id,
        state=state.to_dict(),
        gate=gate or {},
        error=error,
    )


def _output(envelope: StepEnvelope, *, success: bool = True) -> StepOutput:
    body = envelope.to_json()
    if envelope.error:
        return StepOutput(content=body, success=False, error=envelope.error)
    return StepOutput(content=body, success=success)


def init_run_context(step_input: StepInput) -> StepOutput:
    """Stage 0: parse user instruction and trusted repo metadata."""
    raw = step_input.get_input_as_string()
    context = parse_run_context(raw, fallback_repo_root=_fallback_repo_root())
    if not context.repo_root:
        envelope = StepEnvelope(
            stage="init",
            summary="Missing repo_root in trusted execution context.",
            user_message=context.user_message,
            repo_root="",
            project_id=context.project_id,
            error="repo_root is required.",
        )
        return _output(envelope, success=False)

    repo_path = Path(context.repo_root)
    if not repo_path.exists():
        envelope = StepEnvelope(
            stage="init",
            summary=f"Repository path does not exist: {context.repo_root}",
            user_message=context.user_message,
            repo_root=context.repo_root,
            project_id=context.project_id,
            error=f"Repository not found: {context.repo_root}",
        )
        return _output(envelope, success=False)

    state = PipelineState(repo_root=context.repo_root)
    envelope = _envelope_from_state(
        state,
        stage="init",
        summary=f"Initialized refactor run for {context.repo_root}",
        user_message=context.user_message,
        project_id=context.project_id,
    )
    return _output(envelope)


def scan_and_index(step_input: StepInput) -> StepOutput:
    """Stage 1: AST scan → component index."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    try:
        index = scan_directory(state.repo_root)
        state.component_index = index
        summary = (
            f"Indexed {len(index.components)} components across "
            f"{index.total_files_scanned} files."
        )
        return _output(
            _envelope_from_state(
                state,
                stage="scan",
                summary=summary,
                user_message=envelope.user_message,
                project_id=envelope.project_id,
            )
        )
    except Exception as exc:
        envelope.error = str(exc)
        envelope.stage = "scan"
        envelope.summary = f"Component scan failed: {exc}"
        return _output(envelope, success=False)


def extract_design_tokens(step_input: StepInput) -> StepOutput:
    """Stage 2: extract CSS / Tailwind design tokens."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    try:
        tokens = extract_tokens_from_file(state.target_css)
        state.design_tokens = tokens
        color_count = len(tokens.colors)
        summary = f"Extracted {color_count} color tokens from {state.target_css}."
        return _output(
            _envelope_from_state(
                state,
                stage="tokens",
                summary=summary,
                user_message=envelope.user_message,
                project_id=envelope.project_id,
            )
        )
    except Exception as exc:
        envelope.error = str(exc)
        envelope.stage = "tokens"
        envelope.summary = f"Token extraction failed: {exc}"
        return _output(envelope, success=False)


def run_vagueness_gate(step_input: StepInput) -> StepOutput:
    """Stage 3: deterministic vagueness gate."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    gate = vagueness_gate(envelope.user_message)
    if not gate.get("needs_clarification"):
        state.style_direction = envelope.user_message
        state.scope = "all"
    summary = (
        "Clarification required before generation."
        if gate.get("needs_clarification")
        else "Request is specific enough to proceed without clarification."
    )
    return _output(
        _envelope_from_state(
            state,
            stage="vagueness_gate",
            summary=summary,
            user_message=envelope.user_message,
            project_id=envelope.project_id,
            gate=gate,
        )
    )


def needs_clarification(step_input: StepInput) -> bool:
    """Condition evaluator for the clarifier branch."""
    envelope = _load_envelope(step_input)
    return bool(envelope.gate.get("needs_clarification"))


def merge_clarification(step_input: StepInput) -> StepOutput:
    """Stage 4b: merge clarifier answers into pipeline state."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)

    clarification: dict[str, str] = {}
    user_input = (step_input.additional_data or {}).get("user_input")
    if isinstance(user_input, dict):
        clarification = {k: str(v) for k, v in user_input.items() if v is not None}
    else:
        clarifier_text = step_input.previous_step_content
        if isinstance(clarifier_text, StepOutput):
            clarifier_text = clarifier_text.content
        clarifier_raw = str(clarifier_text or "").strip()
        if clarifier_raw.startswith("{"):
            try:
                parsed = json.loads(clarifier_raw)
                if isinstance(parsed, dict):
                    clarification = {k: str(v) for k, v in parsed.items()}
            except json.JSONDecodeError:
                clarification = {"notes": clarifier_raw}
        elif clarifier_raw:
            clarification = {"notes": clarifier_raw}

    state.clarification = clarification
    state.style_direction = clarification.get("style_direction") or state.style_direction
    state.scope = clarification.get("scope") or state.scope or "all"

    return _output(
        _envelope_from_state(
            state,
            stage="clarification",
            summary="Clarification captured.",
            user_message=envelope.user_message,
            project_id=envelope.project_id,
            gate=envelope.gate,
        )
    )


def skip_clarification(step_input: StepInput) -> StepOutput:
    """Stage 4a: pass-through when the vagueness gate passes."""
    envelope = _load_envelope(step_input)
    return _output(envelope)


def classify_boundaries(step_input: StepInput) -> StepOutput:
    """Stage 6: build diff masks for in-scope components."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    if not state.component_index:
        envelope.error = "Component index missing."
        return _output(envelope, success=False)

    masks: dict[str, Any] = {}
    scoped = _components_in_scope(state)
    for capsule in scoped:
        file_path = state.repo_root / capsule.file
        if not file_path.exists():
            continue
        source_bytes = file_path.read_bytes()
        mask = classify_component(
            source_bytes=source_bytes,
            component_start_line=capsule.line_range[0],
            component_end_line=capsule.line_range[1],
            component_name=capsule.name,
            file_path=capsule.file,
        )
        masks[capsule.name] = {"hash": mask.hash, "presentation_lines": len(mask.presentation_lines())}
        capsule.mask_hash = mask.hash

    state.diff_masks = masks
    summary = f"Classified presentation boundaries for {len(masks)} components."
    return _output(
        _envelope_from_state(
            state,
            stage="boundaries",
            summary=summary,
            user_message=envelope.user_message,
            project_id=envelope.project_id,
            gate=envelope.gate,
        )
    )


def validate_patches(step_input: StepInput) -> StepOutput:
    """Stage 8: run tsc/eslint/stylelint against changed files."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    changed_files = [p["file_path"] for p in state.patches if p.get("success")]
    result = run_all_validations(state.repo_root, changed_files)
    result_dict = {
        "passed": result.passed,
        "summary": result.summary(),
        "error_count": result.error_count(),
        "warning_count": result.warning_count(),
    }
    state.validation_results.append(result_dict)
    summary = result.summary()
    return _output(
        _envelope_from_state(
            state,
            stage="validation",
            summary=summary,
            user_message=envelope.user_message,
            project_id=envelope.project_id,
            gate={**envelope.gate, "validation": result_dict},
        )
    )


def aggregate_report(step_input: StepInput) -> StepOutput:
    """Stage 11: aggregate patch ledger (deterministic reporter input)."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    report = aggregate_diffs(state.patches)
    index_summary = (
        state.component_index.summary_for_context()
        if state.component_index
        else "No component index."
    )
    combined = (
        f"{report}\n\n## Component Index\n{index_summary}\n\n"
        f"Style direction: {state.style_direction or 'unspecified'}\n"
        f"Scope: {state.scope or 'all'}"
    )
    envelope.stage = "report"
    envelope.summary = f"Prepared report for {len(state.patches)} patch entries."
    envelope.state = state.to_dict()
    return StepOutput(content=combined)


def finalize_run(step_input: StepInput) -> StepOutput:
    """Stage 12: finalize run output for the Connector UI."""
    envelope = _load_envelope(step_input)
    reporter_text = step_input.previous_step_content
    if isinstance(reporter_text, StepOutput):
        reporter_text = reporter_text.content
    report_body = str(reporter_text or envelope.summary)
    envelope.stage = "complete"
    envelope.summary = report_body[:4000]
    return _output(envelope)


def _components_in_scope(state: PipelineState) -> list[Any]:
    if not state.component_index:
        return []
    scope = (state.scope or "all").strip().lower()
    if scope in {"all", "everything", "entire", "whole", "*"}:
        return state.component_index.components

    tokens = [part.strip() for part in scope.replace(",", " ").split() if part.strip()]
    selected: list[Any] = []
    for capsule in state.component_index.components:
        haystack = f"{capsule.name} {capsule.file}".lower()
        if any(token in haystack for token in tokens):
            selected.append(capsule)
    return selected or state.component_index.components[:5]


def build_design_system_prompt(step_input: StepInput) -> str:
    """Prompt builder for the design-system agent step."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    tokens_json = (
        json.dumps(state.design_tokens.model_dump(), indent=2)
        if state.design_tokens
        else "{}"
    )
    clarification_json = json.dumps(state.clarification or {}, indent=2)
    return (
        "Extend the design token specification for this UI/UX refactor.\n\n"
        f"Style direction: {state.style_direction or envelope.user_message}\n"
        f"Scope: {state.scope or 'all'}\n"
        f"Clarification: {clarification_json}\n\n"
        f"Extracted tokens:\n{tokens_json}\n\n"
        "Return JSON matching DesignTokenSpec."
    )


def build_refactor_prompt(step_input: StepInput) -> str:
    """Prompt builder for the component refactor agent step."""
    envelope = _load_envelope(step_input)
    state = _state_from_envelope(envelope)
    scoped = _components_in_scope(state)
    max_components = int(os.environ.get("UIUX_MAX_COMPONENTS", "3"))
    targets = scoped[:max_components]
    lines = [
        "Generate presentation-only unified diff patches for these components.",
        f"Style direction: {state.style_direction or envelope.user_message}",
        "",
        "Targets:",
    ]
    for capsule in targets:
        lines.append(
            f"- {capsule.name} ({capsule.file}:{capsule.line_range[0]}-{capsule.line_range[1]})"
        )
    if state.design_tokens:
        token_names = ", ".join(state.design_tokens.all_token_names()[:40])
        lines.extend(["", f"Design tokens ({state.design_tokens.token_count_estimate()} est. tokens):", token_names])
    lines.extend(
        [
            "",
            "Use write_patch for each component. Never modify logic-classified lines.",
            "Require confirmation before any patch is accepted.",
        ]
    )
    return "\n".join(lines)

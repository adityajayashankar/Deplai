"""LangGraph topology for enterprise frontend customization."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from langgraph.graph import END, START, StateGraph

from frontend_customization.boundary import build_boundary
from frontend_customization.delivery import build_zip, final_review, github_metadata
from frontend_customization.implementation import apply_agent_work
from frontend_customization.intake import analyze_repository, map_frontend
from frontend_customization.intelligence import (
    design_system_plan,
    maybe_refine_with_llm,
    product_ux_model,
    screen_tasks,
    ux_strategy,
)
from frontend_customization.models import PIPELINE_STAGES, STAGE_LABELS, FailureClass, RunStatus
from frontend_customization.persistence import append_event, write_artifact
from frontend_customization.state import FrontendCustomizationState
from frontend_customization.validation import quality_scores, should_repair, validate_changes
from frontend_customization.workspace import create_checkpoint, lock_snapshot

_BACKEND_DIR: Path | None = None
MAX_REPAIR = 2


def set_backend_dir(path: Path) -> None:
    global _BACKEND_DIR
    _BACKEND_DIR = path


def _backend_dir() -> Path:
    if _BACKEND_DIR is None:
        raise RuntimeError("Frontend customization backend directory is not configured.")
    return _BACKEND_DIR


def _complete(state: FrontendCustomizationState, stage: str, summary: str, extra: dict[str, Any] | None = None) -> FrontendCustomizationState:
    next_state: dict[str, Any] = dict(state)
    completed = list(next_state.get("completed_nodes") or [])
    if stage not in completed:
        completed.append(stage)
    next_state["completed_nodes"] = completed
    next_state["file_locks"] = lock_snapshot(str(next_state.get("run_id") or ""))
    append_event(next_state, stage, summary, extra)
    try:
        workspace = {
            "workspace_root": next_state["workspace_root"],
            "original_root": next_state["original_root"],
            "working_root": next_state["working_root"],
            "checkpoints": str(Path(next_state["workspace_root"]) / "checkpoints"),
            "patches": str(Path(next_state["workspace_root"]) / "patches"),
            "artifacts": str(Path(next_state["workspace_root"]) / "artifacts"),
            "preview": str(Path(next_state["workspace_root"]) / "preview"),
            "metadata": str(Path(next_state["workspace_root"]) / "metadata"),
        }
        checkpoint = create_checkpoint(workspace, stage, summary)
        checkpoints = list(next_state.get("checkpoints") or [])
        checkpoints.append(
            {
                "checkpoint_id": checkpoint["checkpoint_id"],
                "stage": stage,
                "summary": summary,
                "created_at": checkpoint["created_at"],
                "files_changed": len(checkpoint.get("files_changed") or []),
            }
        )
        next_state["checkpoints"] = checkpoints
        artifact_ids = dict(next_state.get("artifact_ids") or {})
        artifact_ids[stage] = write_artifact(_backend_dir(), str(next_state["run_id"]), stage, extra or {"summary": summary})
        next_state["artifact_ids"] = artifact_ids
    except Exception as exc:
        warnings = list(next_state.get("warnings") or [])
        warnings.append(f"Checkpoint warning at {stage}: {exc}")
        next_state["warnings"] = warnings
    if next_state.get("status") != RunStatus.AWAITING_REVIEW.value:
        next_state["status"] = RunStatus.RUNNING.value
    return next_state  # type: ignore[return-value]


def _fail(state: FrontendCustomizationState, stage: str, detail: str, failure: FailureClass) -> FrontendCustomizationState:
    next_state: dict[str, Any] = dict(state)
    errors = list(next_state.get("errors") or [])
    errors.append({"stage": stage, "class": failure.value, "detail": detail})
    next_state["errors"] = errors
    next_state["status"] = RunStatus.FAILED.value
    append_event(next_state, stage, detail, {"failure": failure.value})
    return next_state  # type: ignore[return-value]


def intake_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        manifest = analyze_repository(str(state["working_root"]))
        next_state = dict(state)
        next_state["repository_manifest"] = manifest
        unusual = manifest.get("frontend_framework") == "unknown" and manifest.get("framework") == "unknown"
        if unusual and not manifest.get("has_frontend_surface"):
            next_state["interrupt_required"] = True
            next_state["interrupt_kind"] = "confirm_mode"
            next_state["interrupt_reason"] = "We could not find a frontend to customize. Confirm a mode if you still want to continue."
            next_state["interrupt_schema"] = [
                {"name": "mode", "type": "string", "required": False},
                {"name": "confirmed", "type": "boolean", "required": True},
            ]
            next_state["status"] = RunStatus.AWAITING_REVIEW.value
        elif unusual:
            warnings = list(next_state.get("warnings") or [])
            warnings.append("Frontend stack was not auto-detected; continuing with the selected customization mode.")
            next_state["warnings"] = warnings
        return _complete(next_state, "intake", STAGE_LABELS["intake"], {"manifest": manifest})
    except Exception as exc:
        return _fail(state, "intake", str(exc), FailureClass.TOOL_FAILURE)


def mapping_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        frontend = map_frontend(str(state["working_root"]), dict(state.get("repository_manifest") or {}))
        next_state = dict(state)
        next_state["frontend_manifest"] = frontend
        return _complete(next_state, "mapping", STAGE_LABELS["mapping"], {"routes": len(frontend.get("routes") or [])})
    except Exception as exc:
        return _fail(state, "mapping", str(exc), FailureClass.CONTEXT_FAILURE)


def business_logic_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        boundary = build_boundary(str(state["working_root"]), dict(state.get("frontend_manifest") or {}))
        next_state = dict(state)
        next_state["business_logic_boundary"] = boundary
        return _complete(
            next_state,
            "business_logic",
            STAGE_LABELS["business_logic"],
            {
                "protected": len(boundary.get("protected_files") or []),
                "allowed": len(boundary.get("allowed_frontend_surface") or []),
            },
        )
    except Exception as exc:
        return _fail(state, "business_logic", str(exc), FailureClass.VALIDATION_FAILURE)


def ux_research_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        model = product_ux_model(dict(state.get("frontend_manifest") or {}), str(state.get("goal") or ""))
        model = maybe_refine_with_llm("ux_research", model, dict(state))
        next_state = dict(state)
        next_state["product_ux_model"] = model
        return _complete(next_state, "ux_research", STAGE_LABELS["ux_research"])
    except Exception as exc:
        return _fail(state, "ux_research", str(exc), FailureClass.CONTEXT_FAILURE)


def ux_strategy_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        selected = list(state.get("selected_screens") or [])
        strategy = ux_strategy(
            dict(state.get("product_ux_model") or {}),
            dict(state.get("repository_manifest") or {}),
            str(state.get("mode") or "full_transformation"),
            selected or None,
        )
        strategy = maybe_refine_with_llm("ux_strategy", strategy, dict(state))
        next_state = dict(state)
        next_state["screen_plans"] = list(strategy.get("screens") or [])
        next_state["ux_strategy"] = strategy
        return _complete(next_state, "ux_strategy", STAGE_LABELS["ux_strategy"], {"screens": len(strategy.get("screens") or [])})
    except Exception as exc:
        return _fail(state, "ux_strategy", str(exc), FailureClass.CONTEXT_FAILURE)


def design_system_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        plan = design_system_plan(
            str(state["working_root"]),
            dict(state.get("repository_manifest") or {}),
            dict(state.get("ux_strategy") or {}),
        )
        plan = maybe_refine_with_llm("design_system", plan, dict(state))
        next_state = dict(state)
        next_state["design_system_plan"] = plan
        return _complete(next_state, "design_system", STAGE_LABELS["design_system"])
    except Exception as exc:
        return _fail(state, "design_system", str(exc), FailureClass.CONTEXT_FAILURE)


def screen_planner_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    try:
        tasks = screen_tasks(
            dict(state.get("ux_strategy") or {"screens": state.get("screen_plans") or []}),
            dict(state.get("business_logic_boundary") or {}),
            dict(state.get("frontend_manifest") or {}),
            str(state.get("mode") or "full_transformation"),
        )
        next_state = dict(state)
        next_state["tasks"] = tasks
        next_state["active_tasks"] = [item["id"] for item in tasks]
        return _complete(next_state, "screen_planner", STAGE_LABELS["screen_planner"], {"tasks": len(tasks)})
    except Exception as extra:
        return _fail(state, "screen_planner", str(extra), FailureClass.CONTEXT_FAILURE)


def _implement(state: FrontendCustomizationState, stage: str, agent_id: str, task_agents: set[str]) -> FrontendCustomizationState:
    tasks = [item for item in (state.get("tasks") or []) if item.get("agent") in task_agents]
    files: list[str] = []
    for task in tasks:
        files.extend(list(task.get("files_to_modify") or []))
    result = apply_agent_work(
        run_id=str(state.get("run_id") or ""),
        agent_id=agent_id,
        working_root=str(state["working_root"]),
        original_root=str(state["original_root"]),
        files=files,
        boundary=dict(state.get("business_logic_boundary") or {}),
        design=dict(state.get("design_system_plan") or {}),
        stage=stage,
        goal=str(state.get("goal") or ""),
        state=dict(state),
    )
    next_state = dict(state)
    changesets = list(next_state.get("changesets") or [])
    changesets.extend(result.get("changeset") or [])
    next_state["changesets"] = changesets
    warnings = list(next_state.get("warnings") or [])
    warnings.extend(result.get("warnings") or [])
    next_state["warnings"] = warnings
    errors = list(result.get("errors") or [])
    if errors:
        policy_hits = [item for item in errors if "NO_" in item]
        if policy_hits:
            next_state["interrupt_required"] = True
            next_state["interrupt_kind"] = "policy"
            next_state["interrupt_reason"] = "A proposed change touched protected business logic and was blocked."
            next_state["status"] = RunStatus.AWAITING_REVIEW.value
            next_state["errors"] = list(next_state.get("errors") or []) + [
                {"stage": stage, "class": FailureClass.POLICY_VIOLATION.value, "detail": item} for item in policy_hits
            ]
        else:
            next_state["errors"] = list(next_state.get("errors") or []) + [
                {"stage": stage, "class": FailureClass.CODE_FAILURE.value, "detail": item} for item in errors
            ]
    return _complete(next_state, stage, STAGE_LABELS[stage], {"files": len(result.get("changeset") or [])})


def implement_shell_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    return _implement(state, "implement_shell", "shell", {"shell"})


def implement_screens_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    mode = str(state.get("mode") or "full_transformation")
    if mode in {"design_system", "responsive", "accessibility"}:
        next_state = dict(state)
        return _complete(next_state, "implement_screens", "Screen implementation skipped for this mode.")
    return _implement(state, "implement_screens", "screen", {"screen"})


def implement_responsive_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    mode = str(state.get("mode") or "full_transformation")
    if mode in {"targeted_screen", "design_system", "accessibility"}:
        return _complete(dict(state), "implement_responsive", "Responsive pass skipped for this mode.")
    return _implement(state, "implement_responsive", "responsive", {"responsive"})


def implement_a11y_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    mode = str(state.get("mode") or "full_transformation")
    if mode in {"targeted_screen", "design_system", "responsive"}:
        return _complete(dict(state), "implement_a11y", "Accessibility pass skipped for this mode.")
    return _implement(state, "implement_a11y", "accessibility", {"accessibility"})


def visual_qa_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    validation = validate_changes(
        str(state["working_root"]),
        str(state["original_root"]),
        dict(state.get("business_logic_boundary") or {}),
        list(state.get("changesets") or []),
    )
    next_state = dict(state)
    results = list(next_state.get("validation_results") or [])
    results.append(validation)
    next_state["validation_results"] = results
    next_state["quality_scores"] = quality_scores(validation, len(next_state.get("changesets") or []))
    if should_repair(validation, int(next_state.get("repair_attempts") or 0)):
        next_state["needs_repair"] = True
        return _complete(next_state, "visual_qa", "Visual QA requested a repair pass.", {"validation": validation})
    next_state["needs_repair"] = False
    return _complete(next_state, "visual_qa", STAGE_LABELS["visual_qa"], {"validation": validation})


def functional_safety_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    validation = validate_changes(
        str(state["working_root"]),
        str(state["original_root"]),
        dict(state.get("business_logic_boundary") or {}),
        list(state.get("changesets") or []),
    )
    next_state = dict(state)
    results = list(next_state.get("validation_results") or [])
    results.append(validation)
    next_state["validation_results"] = results
    if validation.get("blocked"):
        next_state["interrupt_required"] = True
        next_state["interrupt_kind"] = "safety"
        next_state["interrupt_reason"] = "Functional safety found a protected-file modification. Review required."
        next_state["status"] = RunStatus.AWAITING_REVIEW.value
        next_state["needs_repair"] = True
    return _complete(next_state, "functional_safety", STAGE_LABELS["functional_safety"], {"blocked": validation.get("blocked") or []})


def repair_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    attempts = int(state.get("repair_attempts") or 0) + 1
    next_state = dict(state)
    next_state["repair_attempts"] = attempts
    result = apply_agent_work(
        run_id=str(state.get("run_id") or ""),
        agent_id="repair",
        working_root=str(state["working_root"]),
        original_root=str(state["original_root"]),
        files=[item.get("file") for item in (state.get("changesets") or []) if item.get("file")],
        boundary=dict(state.get("business_logic_boundary") or {}),
        design=dict(state.get("design_system_plan") or {}),
        stage="repair",
        goal="Repair frontend-only validation issues without touching business logic.",
        state=dict(state),
    )
    changesets = list(next_state.get("changesets") or [])
    changesets.extend(result.get("changeset") or [])
    next_state["changesets"] = changesets
    next_state["needs_repair"] = attempts < MAX_REPAIR and bool(result.get("errors"))
    completed = [item for item in (next_state.get("completed_nodes") or []) if item not in {"visual_qa", "functional_safety"}]
    next_state["completed_nodes"] = completed
    return _complete(next_state, "repair", f"Repair pass {attempts} completed.")


def preview_verify_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    next_state = dict(state)
    preview = dict(next_state.get("preview_state") or {})
    preview.setdefault("status", "skipped")
    preview.setdefault("detail", "Preview is served through the platform sandbox iframe.")
    next_state["preview_state"] = preview
    return _complete(next_state, "preview_verify", STAGE_LABELS["preview_verify"])


def final_review_node(state: FrontendCustomizationState) -> FrontendCustomizationState:
    validation = (state.get("validation_results") or [{}])[-1] if state.get("validation_results") else validate_changes(
        str(state["working_root"]),
        str(state["original_root"]),
        dict(state.get("business_logic_boundary") or {}),
        list(state.get("changesets") or []),
    )
    review = final_review(dict(state), validation)
    next_state = dict(state)
    next_state["final_review"] = review
    next_state["gate_passed"] = bool(review.get("gate_passed"))
    next_state["github"] = github_metadata(str(state.get("run_id") or "run"), next_state)
    try:
        zip_path = Path(state["workspace_root"]) / "artifacts" / "customized-repository.zip"
        build_zip(str(state["working_root"]), zip_path)
        next_state["zip_path"] = str(zip_path)
    except Exception as extra:
        warnings = list(next_state.get("warnings") or [])
        warnings.append(f"ZIP export warning: {extra}")
        next_state["warnings"] = warnings
    if not review.get("gate_passed"):
        next_state["status"] = RunStatus.AWAITING_REVIEW.value
        next_state["interrupt_required"] = True
        next_state["interrupt_kind"] = "review"
        next_state["interrupt_reason"] = review.get("summary") or "Final review gate did not pass."
        return _complete(next_state, "review_gate", "Final review requires operator attention.", review)
    next_state["status"] = RunStatus.COMPLETED.value
    return _complete(next_state, "review_gate", STAGE_LABELS["review_gate"], review)


NODE_FUNCTIONS = {
    "intake": intake_node,
    "mapping": mapping_node,
    "business_logic": business_logic_node,
    "ux_research": ux_research_node,
    "ux_strategy": ux_strategy_node,
    "design_system": design_system_node,
    "screen_planner": screen_planner_node,
    "implement_shell": implement_shell_node,
    "implement_screens": implement_screens_node,
    "implement_responsive": implement_responsive_node,
    "implement_a11y": implement_a11y_node,
    "visual_qa": visual_qa_node,
    "functional_safety": functional_safety_node,
    "repair": repair_node,
    "preview_verify": preview_verify_node,
    "review_gate": final_review_node,
}


def next_node(state: FrontendCustomizationState) -> str:
    if state.get("status") == RunStatus.FAILED.value:
        return END
    if state.get("interrupt_required") and state.get("status") == RunStatus.AWAITING_REVIEW.value:
        if state.get("current_stage") and state.get("current_stage") in (state.get("completed_nodes") or []):
            return END
    if (
        state.get("needs_repair")
        and int(state.get("repair_attempts") or 0) < MAX_REPAIR
        and state.get("current_stage") != "repair"
    ):
        return "repair"
    completed = set(state.get("completed_nodes") or [])
    for name in PIPELINE_STAGES:
        if name == "repair":
            continue
        if name not in completed:
            return name
    return END


def build_frontend_customization_graph():
    graph = StateGraph(FrontendCustomizationState)
    for name, fn in NODE_FUNCTIONS.items():
        graph.add_node(name, fn)
    destinations = {name: name for name in NODE_FUNCTIONS}
    destinations[END] = END
    graph.add_conditional_edges(START, next_node, destinations)
    for name in NODE_FUNCTIONS:
        graph.add_conditional_edges(name, next_node, destinations)
    return graph.compile(recursion_limit=50)

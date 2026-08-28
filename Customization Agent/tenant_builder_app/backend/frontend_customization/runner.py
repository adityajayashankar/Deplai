"""Run lifecycle: start, stream, persist, resume, restore."""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from frontend_customization.delivery import public_run_view
from frontend_customization.graph import build_frontend_customization_graph, set_backend_dir
from frontend_customization.models import CustomizationMode, RunStatus
from frontend_customization.model_router import sanitize_llm_config
from frontend_customization.persistence import load_run, runtime_root, save_run
from frontend_customization.workspace import ensure_workspace, restore_checkpoint as restore_workspace_checkpoint

_RUN_THREADS: dict[str, threading.Thread] = {}
_RUN_LOCK = threading.Lock()


def start_run(
    *,
    backend_dir: Path,
    base_repo_path: str,
    project_id: str,
    tenant_id: str,
    user_id: str,
    goal: str,
    mode: str | None = None,
    selected_screens: list[str] | None = None,
    llm_config: dict[str, Any] | None = None,
    wait: bool = False,
) -> dict[str, Any]:
    set_backend_dir(backend_dir)
    run_id = uuid.uuid4().hex
    workspace = ensure_workspace(run_id, base_repo_path, runtime_root(backend_dir))
    resolved_mode = _normalize_mode(mode)
    state: dict[str, Any] = {
        "run_id": run_id,
        "repository_id": project_id or tenant_id or run_id,
        "project_id": project_id,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "base_repo_path": base_repo_path,
        "workspace_root": workspace["workspace_root"],
        "original_root": workspace["original_root"],
        "working_root": workspace["working_root"],
        "mode": resolved_mode,
        "goal": (goal or "Improve overall UI/UX").strip(),
        "selected_screens": selected_screens or [],
        "llm_config": sanitize_llm_config(llm_config),
        "completed_nodes": [],
        "events": [],
        "errors": [],
        "warnings": [],
        "changesets": [],
        "checkpoints": [],
        "tasks": [],
        "screen_plans": [],
        "validation_results": [],
        "file_locks": [],
        "repair_attempts": 0,
        "needs_repair": False,
        "interrupt_required": False,
        "gate_passed": False,
        "status": RunStatus.QUEUED.value,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_run(backend_dir, state)
    if wait:
        return run_sync(backend_dir, run_id)
    _spawn(backend_dir, run_id)
    return public_run_view(state)


def continue_run(*, backend_dir: Path, run_id: str, user_input: dict[str, Any] | None = None, confirmed: bool = False, wait: bool = False) -> dict[str, Any]:
    set_backend_dir(backend_dir)
    state = load_run(backend_dir, run_id)
    incoming = dict(user_input or {})
    if incoming.get("mode"):
        state["mode"] = _normalize_mode(str(incoming.get("mode")))
    if incoming.get("goal"):
        state["goal"] = str(incoming["goal"]).strip()
    if incoming.get("selected_screens"):
        screens = incoming["selected_screens"]
        if isinstance(screens, list):
            state["selected_screens"] = [str(item) for item in screens]
    state["user_input"] = incoming
    if confirmed or incoming.get("confirmed") is True:
        state["interrupt_required"] = False
        state["interrupt_kind"] = ""
        if state.get("status") == RunStatus.AWAITING_REVIEW.value:
            state["status"] = RunStatus.RUNNING.value
    save_run(backend_dir, state)
    if wait:
        return run_sync(backend_dir, run_id)
    _spawn(backend_dir, run_id)
    return public_run_view(state)


def restore_checkpoint(*, backend_dir: Path, run_id: str, checkpoint_id: str) -> dict[str, Any]:
    set_backend_dir(backend_dir)
    state = load_run(backend_dir, run_id)
    workspace = {
        "workspace_root": state["workspace_root"],
        "original_root": state["original_root"],
        "working_root": state["working_root"],
        "checkpoints": str(Path(state["workspace_root"]) / "checkpoints"),
        "patches": str(Path(state["workspace_root"]) / "patches"),
        "artifacts": str(Path(state["workspace_root"]) / "artifacts"),
        "preview": str(Path(state["workspace_root"]) / "preview"),
        "metadata": str(Path(state["workspace_root"]) / "metadata"),
    }
    payload = restore_workspace_checkpoint(workspace, checkpoint_id)
    stage = str(payload.get("stage") or "")
    completed = list(state.get("completed_nodes") or [])
    if stage in completed:
        # Resume from the restored stage: drop later nodes so the graph re-runs them.
        index = completed.index(stage)
        state["completed_nodes"] = completed[: index + 1]
    state["interrupt_required"] = False
    state["status"] = RunStatus.RUNNING.value
    state["needs_repair"] = False
    events = list(state.get("events") or [])
    events.append({"stage": "restore", "summary": f"Restored checkpoint {checkpoint_id}", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    state["events"] = events
    save_run(backend_dir, state)
    return public_run_view(state)


def get_run(*, backend_dir: Path, run_id: str) -> dict[str, Any]:
    return public_run_view(load_run(backend_dir, run_id))


def run_sync(backend_dir: Path, run_id: str) -> dict[str, Any]:
    """Execute the graph for a run on the current thread. Used by tests and the worker."""
    set_backend_dir(backend_dir)
    state = load_run(backend_dir, run_id)
    state["status"] = RunStatus.RUNNING.value
    graph = build_frontend_customization_graph()
    last = dict(state)
    try:
        for update in graph.stream(state, stream_mode="updates"):
            if not isinstance(update, dict):
                continue
            for _node, payload in update.items():
                if isinstance(payload, dict):
                    last.update(payload)
                    save_run(backend_dir, last)
                    if last.get("interrupt_required") and last.get("status") == RunStatus.AWAITING_REVIEW.value:
                        return public_run_view(last)
                    if last.get("status") == RunStatus.FAILED.value:
                        return public_run_view(last)
        if last.get("status") not in {RunStatus.COMPLETED.value, RunStatus.FAILED.value, RunStatus.AWAITING_REVIEW.value}:
            last["status"] = RunStatus.COMPLETED.value if last.get("gate_passed") else last.get("status") or RunStatus.COMPLETED.value
        save_run(backend_dir, last)
    except Exception as extra:
        last["status"] = RunStatus.FAILED.value
        errors = list(last.get("errors") or [])
        errors.append({"stage": last.get("current_stage") or "graph", "class": "UNKNOWN", "detail": str(extra)})
        last["errors"] = errors
        save_run(backend_dir, last)
    return public_run_view(last)


def _spawn(backend_dir: Path, run_id: str) -> None:
    with _RUN_LOCK:
        existing = _RUN_THREADS.get(run_id)
        if existing and existing.is_alive():
            return

        def worker() -> None:
            run_sync(backend_dir, run_id)

        thread = threading.Thread(target=worker, name=f"frontend-customization-{run_id[:8]}", daemon=True)
        _RUN_THREADS[run_id] = thread
        thread.start()


def _normalize_mode(mode: str | None) -> str:
    raw = (mode or CustomizationMode.FULL.value).strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "full": CustomizationMode.FULL.value,
        "full_uiux_transformation": CustomizationMode.FULL.value,
        "full_ui_ux_transformation": CustomizationMode.FULL.value,
        "targeted": CustomizationMode.TARGETED.value,
        "targeted_screen_transformation": CustomizationMode.TARGETED.value,
        "design": CustomizationMode.DESIGN_SYSTEM.value,
        "design_system_upgrade": CustomizationMode.DESIGN_SYSTEM.value,
        "responsive_upgrade": CustomizationMode.RESPONSIVE.value,
        "accessibility_upgrade": CustomizationMode.ACCESSIBILITY.value,
        "a11y": CustomizationMode.ACCESSIBILITY.value,
    }
    resolved = aliases.get(raw, raw)
    try:
        return CustomizationMode(resolved).value
    except ValueError:
        return CustomizationMode.FULL.value

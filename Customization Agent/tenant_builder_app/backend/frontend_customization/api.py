"""FastAPI router for the frontend customization engine."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from frontend_customization.delivery import public_run_view
from frontend_customization.intake import list_frontend_paths
from frontend_customization.persistence import load_run
from frontend_customization.runner import continue_run, get_run, restore_checkpoint, start_run
from frontend_customization.workspace import changed_files, diff_entries
from services.repo_service import ensure_tenant_repo, get_tenant_repo_path
from services.snapshot_manager import SnapshotError, create_snapshot

BACKEND_DIR = Path(__file__).resolve().parents[1]
router = APIRouter(prefix="/api/frontend-customization", tags=["frontend-customization"])


class LlmConfigIn(BaseModel):
    provider: str = ""
    model: str = ""
    access_mode: str = "auto"
    user_id: str | None = None


class StartRunRequest(BaseModel):
    project_id: str = ""
    tenant_id: str = ""
    user_id: str = ""
    base_repo_path: str
    goal: str = "Improve overall UI/UX"
    mode: str = "full_transformation"
    selected_screens: list[str] = Field(default_factory=list)
    llm_config: LlmConfigIn | None = None


class ContinueRunRequest(BaseModel):
    user_input: dict[str, Any] = Field(default_factory=dict)
    confirmed: bool = False


class RestoreRequest(BaseModel):
    checkpoint_id: str


class FinalizeRequest(BaseModel):
    tenant_id: str
    base_repo_path: str | None = None
    quality_report: dict[str, Any] | None = None


@router.post("/runs")
def create_run(payload: StartRunRequest) -> dict[str, Any]:
    if not payload.base_repo_path:
        raise HTTPException(status_code=400, detail="base_repo_path is required.")
    llm_config = payload.llm_config.model_dump() if payload.llm_config else {}
    llm_config.pop("api_key", None)
    if payload.user_id:
        llm_config["user_id"] = payload.user_id
    try:
        return start_run(
            backend_dir=BACKEND_DIR,
            base_repo_path=payload.base_repo_path,
            project_id=payload.project_id,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            goal=payload.goal,
            mode=payload.mode,
            selected_screens=payload.selected_screens,
            llm_config=llm_config,
        )
    except FileNotFoundError as extra:
        raise HTTPException(status_code=400, detail=str(extra)) from extra
    except Exception as extra:
        raise HTTPException(status_code=500, detail=str(extra)) from extra


@router.get("/runs/{run_id}")
def read_run(run_id: str) -> dict[str, Any]:
    try:
        return get_run(backend_dir=BACKEND_DIR, run_id=run_id)
    except FileNotFoundError as extra:
        raise HTTPException(status_code=404, detail=str(extra)) from extra


@router.post("/runs/{run_id}/continue")
def resume_run(run_id: str, payload: ContinueRunRequest) -> dict[str, Any]:
    try:
        return continue_run(
            backend_dir=BACKEND_DIR,
            run_id=run_id,
            user_input=payload.user_input,
            confirmed=payload.confirmed,
        )
    except FileNotFoundError as extra:
        raise HTTPException(status_code=404, detail=str(extra)) from extra


@router.post("/runs/{run_id}/restore")
def restore_run(run_id: str, payload: RestoreRequest) -> dict[str, Any]:
    try:
        return restore_checkpoint(backend_dir=BACKEND_DIR, run_id=run_id, checkpoint_id=payload.checkpoint_id)
    except FileNotFoundError as extra:
        raise HTTPException(status_code=404, detail=str(extra)) from extra


@router.get("/runs/{run_id}/files")
def list_files(run_id: str) -> dict[str, Any]:
    state = _load(run_id)
    original = Path(str(state["original_root"]))
    working = Path(str(state["working_root"]))
    changes = changed_files(original, working)
    changed_by_path = {item["file"]: item["status"] for item in changes if item.get("file")}
    mapped = list((state.get("frontend_manifest") or {}).get("frontend_files") or [])
    tree_paths = mapped or list_frontend_paths(str(working))
    seen: set[str] = set()
    tree: list[dict[str, str]] = []
    for path in [*tree_paths, *changed_by_path.keys()]:
        if not path or path in seen:
            continue
        seen.add(path)
        tree.append({"file": path, "status": changed_by_path.get(path, "unchanged")})
    return {
        "run_id": run_id,
        "files_changed": [item for item in changes if item["status"] == "modified"],
        "files_added": [item for item in changes if item["status"] == "added"],
        "files_deleted": [item for item in changes if item["status"] == "deleted"],
        "tree": tree,
        "changesets": state.get("changesets") or [],
        "boundary": state.get("business_logic_boundary") or {},
    }


@router.get("/runs/{run_id}/diff")
def list_diffs(run_id: str, file: str | None = None) -> dict[str, Any]:
    state = _load(run_id)
    files = [file] if file else None
    return {
        "run_id": run_id,
        "entries": diff_entries(Path(str(state["original_root"])), Path(str(state["working_root"])), files),
    }


@router.get("/runs/{run_id}/zip")
def download_zip(run_id: str) -> FileResponse:
    state = _load(run_id)
    if not state.get("gate_passed"):
        raise HTTPException(status_code=409, detail="Final review gate has not passed. Repair or review the run before downloading.")
    zip_path = Path(str(state.get("zip_path") or ""))
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="ZIP artifact is not available yet.")
    return FileResponse(
        path=str(zip_path),
        filename="customized-repository.zip",
        media_type="application/zip",
    )


@router.post("/runs/{run_id}/finalize")
def finalize_run(run_id: str, payload: FinalizeRequest) -> dict[str, Any]:
    state = _load(run_id)
    review = state.get("final_review") or {}
    if not state.get("gate_passed") and not review.get("gate_passed"):
        raise HTTPException(status_code=409, detail="Final review gate has not passed.")
    tenant_id = (payload.tenant_id or str(state.get("tenant_id") or "")).strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required to finalize.")
    base_repo_path = payload.base_repo_path or str(state.get("base_repo_path") or "")
    try:
        tenant_path = Path(ensure_tenant_repo(base_repo_path, tenant_id))
        working = Path(str(state["working_root"]))
        _sync_working_into_tenant(working, tenant_path)
        snapshot = create_snapshot(
            tenant_id=tenant_id,
            base_repo_path=base_repo_path,
            manifest={"frontend_customization_run_id": run_id, "mode": state.get("mode")},
            quality_report=payload.quality_report or (state.get("validation_results") or [{}])[-1],
        )
        return {
            "run_id": run_id,
            "tenant_id": tenant_id,
            "tenant_repo_path": str(tenant_path),
            "snapshot": snapshot,
            "github": state.get("github") or {},
            "view": public_run_view(state),
        }
    except SnapshotError as extra:
        raise HTTPException(status_code=400, detail=str(extra)) from extra
    except Exception as extra:
        raise HTTPException(status_code=500, detail=str(extra)) from extra


def _load(run_id: str) -> dict[str, Any]:
    try:
        return load_run(BACKEND_DIR, run_id)
    except FileNotFoundError as extra:
        raise HTTPException(status_code=404, detail=str(extra)) from extra


def _sync_working_into_tenant(working: Path, tenant: Path) -> None:
    expected = Path(get_tenant_repo_path(str(tenant.parent / "placeholder"), tenant.name.replace("SubSpace-", "", 1)))
    # Tenant path is already SubSpace-*; copy working contents into it without deleting node_modules.
    for child in working.iterdir():
        if child.name in {".git", "node_modules", ".next", "dist", "build"}:
            continue
        destination = tenant / child.name
        if destination.exists():
            if destination.is_dir() and not destination.is_symlink():
                shutil.rmtree(destination)
            else:
                destination.unlink()
        if child.is_dir():
            shutil.copytree(child, destination, dirs_exist_ok=False)
        else:
            shutil.copy2(child, destination)
    _ = expected

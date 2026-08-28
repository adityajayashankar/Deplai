import json
import difflib
import hashlib
import http.client
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Request as FastAPIRequest, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from chat_agent import ChatAgent
from frontend_customization.api import router as frontend_customization_router
from manifest_state import ManifestState
from runner import run_customization
from services.asset_service import (
    SUPPORTED_ASSET_TYPES,
    get_asset_file_path,
    get_assets_metadata,
    store_asset,
)
from services.manifest_validator import ManifestValidationError
from services.preview_manager import (
    get_preview_upstream_url,
    preview_status,
    start_preview,
    stop_preview,
)
from services.repo_service import containerize_connector_workspace_path, get_tenant_repo_path, reset_tenant_repo
from services.snapshot_manager import (
    SnapshotError,
    create_snapshot,
    get_latest_snapshot,
    get_snapshot,
    load_implementation_record,
    write_implementation_record,
)


class LlmConfig(BaseModel):
    """Resolved platform/BYOK routing. Keys stay in the Connector vault, never here."""
    provider: str = ""
    model: str = ""
    access_mode: str = "auto"
    user_id: str | None = None


class ChatRequest(BaseModel):
    tenant_id: str
    message: str
    llm_config: LlmConfig | None = None  # Optional BYOK override
    user_id: str | None = None


class ImplementRequest(BaseModel):
    tenant_id: str
    base_repo_path: str | None = None
    app_targets: list[str] | None = None
    validator_issues: list[str] | None = None
    pipeline_mode: str | None = None
    run_quality_gates: bool = True
    start_preview: bool = True
    user_id: str | None = None
    llm_config: LlmConfig | None = None


class TenantRequest(BaseModel):
    tenant_id: str


class AdminRepoResetRequest(BaseModel):
    tenant_id: str
    base_repo_path: str | None = None


class PreviewRequest(BaseModel):
    tenant_id: str
    base_repo_path: str | None = None
    app_targets: list[str] | None = None
    force_restart: bool = False


class SnapshotCreateRequest(BaseModel):
    tenant_id: str
    base_repo_path: str | None = None
    quality_report: dict[str, Any] | None = None


app = FastAPI(title="Tenant Builder API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(frontend_customization_router)

state = ManifestState(base_dir=Path(__file__).resolve().parent)
agent = ChatAgent(state=state)
BASE_REPO_PATH = Path(__file__).resolve().parents[2] / "CulturePlace-main"
BACKEND_DIR = Path(__file__).resolve().parent
ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}
MAX_DIFF_FILES = 30
MAX_DIFF_CHARS_PER_FILE = 32000
SNAPSHOT_IGNORED_DIR_NAMES = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
}


def _bind_llm(config: LlmConfig | None, user_id: str | None) -> LlmConfig | None:
    uid = (user_id or "").strip()
    if config is None:
        return LlmConfig(user_id=uid) if uid else None
    if uid and not (config.user_id or "").strip():
        config.user_id = uid
    return config


@app.get("/health")
def health_check() -> dict[str, str]:
    """Container readiness endpoint; the Connector remains the public gateway."""
    return {"status": "healthy", "service": "customization-backend"}


@app.get("/ready")
def readiness_check() -> dict[str, str]:
    """Readiness endpoint used by the production Compose health check."""
    return {"status": "ready", "service": "customization-backend"}


def _normalize_app_targets(raw_targets: object) -> list[str]:
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]

    normalized: list[str] = []
    for target in raw_targets:
        if not isinstance(target, str):
            continue
        candidate = target.strip().lower()
        if candidate in ALLOWED_APP_TARGETS and candidate not in normalized:
            normalized.append(candidate)

    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _load_saved_manifest(tenant_id: str) -> dict:
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    tenant_path = Path(__file__).resolve().parent / "tenants" / normalized_tenant_id / "manifest.json"
    if not tenant_path.exists():
        raise HTTPException(status_code=404, detail=f"Confirmed manifest not found for tenant '{normalized_tenant_id}'.")
    return json.loads(tenant_path.read_text(encoding="utf-8"))


def _resolve_base_repo_path(raw_base_repo_path: str | None) -> Path:
    if raw_base_repo_path:
        candidate = Path(containerize_connector_workspace_path(raw_base_repo_path)).expanduser()
    else:
        candidate = BASE_REPO_PATH.resolve()
    if candidate.exists() and candidate.is_dir():
        return candidate.resolve()
    raise HTTPException(status_code=400, detail=f"Base repository path is invalid or missing: {candidate}")


def _is_within_root(root: Path, candidate: Path) -> bool:
    resolved_root = root.resolve()
    resolved_candidate = candidate.resolve()
    try:
        resolved_candidate.relative_to(resolved_root)
        return True
    except ValueError:
        return False


def _read_text_lines(file_path: Path) -> list[str] | None:
    try:
        return file_path.read_text(encoding="utf-8").splitlines(keepends=True)
    except (OSError, UnicodeDecodeError):
        return None


def _build_modified_file_diffs(base_repo_path: Path, tenant_repo_path: Path, modified_files: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    for relative_path in modified_files[:MAX_DIFF_FILES]:
        rel = Path(relative_path)
        before_path = (base_repo_path / rel).resolve()
        after_path = (tenant_repo_path / rel).resolve()

        if not _is_within_root(base_repo_path, before_path) or not _is_within_root(tenant_repo_path, after_path):
            continue
        if not after_path.exists() or not after_path.is_file():
            continue

        before_lines = []
        if before_path.exists() and before_path.is_file():
            loaded_before = _read_text_lines(before_path)
            if loaded_before is None:
                entries.append({
                    "file": relative_path,
                    "diff": "[Unable to produce text diff: source file is binary or unreadable]",
                    "truncated": False,
                })
                continue
            before_lines = loaded_before

        after_lines = _read_text_lines(after_path)
        if after_lines is None:
            entries.append({
                "file": relative_path,
                "diff": "[Unable to produce text diff: target file is binary or unreadable]",
                "truncated": False,
            })
            continue

        diff_text = "".join(
            difflib.unified_diff(
                before_lines,
                after_lines,
                fromfile=f"a/{relative_path}",
                tofile=f"b/{relative_path}",
                n=3,
            )
        )

        if not diff_text:
            continue

        truncated = False
        if len(diff_text) > MAX_DIFF_CHARS_PER_FILE:
            diff_text = f"{diff_text[:MAX_DIFF_CHARS_PER_FILE]}\n... [diff truncated]"
            truncated = True

        entries.append({
            "file": relative_path,
            "diff": diff_text,
            "truncated": truncated,
        })

    if len(modified_files) > MAX_DIFF_FILES:
        entries.append({
            "file": "_meta",
            "diff": f"Only first {MAX_DIFF_FILES} modified files are shown in diff output.",
            "truncated": False,
        })

    return entries


def _source_by_file(change_sources: object) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    if not isinstance(change_sources, list):
        return lookup
    for entry in change_sources:
        if not isinstance(entry, dict):
            continue
        file_path = entry.get("file")
        if isinstance(file_path, str) and file_path not in lookup:
            lookup[file_path] = entry
    return lookup


def _snapshot_repo_files(repo_root: Path) -> dict[str, str]:
    """
    Build a stable file hash snapshot for a repo tree, excluding heavyweight build dirs.
    """
    snapshot: dict[str, str] = {}
    if not repo_root.exists() or not repo_root.is_dir():
        return snapshot

    for current_root, dir_names, file_names in os.walk(repo_root):
        dir_names[:] = [
            name for name in dir_names
            if name not in SNAPSHOT_IGNORED_DIR_NAMES
        ]
        current_path = Path(current_root)
        for file_name in file_names:
            absolute_path = current_path / file_name
            if not absolute_path.is_file():
                continue

            try:
                relative_path = absolute_path.relative_to(repo_root).as_posix()
            except ValueError:
                continue

            hasher = hashlib.sha256()
            try:
                with absolute_path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        hasher.update(chunk)
            except OSError:
                continue

            snapshot[relative_path] = hasher.hexdigest()

    return snapshot


def _derive_snapshot_modified_files(before: dict[str, str], after: dict[str, str]) -> list[str]:
    all_keys = sorted(set(before) | set(after))
    return [path for path in all_keys if before.get(path) != after.get(path)]


def _merge_modified_file_lists(primary: list[str], secondary: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()

    for path in [*primary, *secondary]:
        normalized = path.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        merged.append(normalized)

    return merged


@app.get("/health")
def healthcheck() -> dict:
    return {"status": "ok"}


@app.post("/chat")
def chat(request: ChatRequest) -> dict:
    tenant_id = request.tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    try:
        result = agent.handle_message(normalized_tenant_id, request.message, byok_config=_bind_llm(request.llm_config, request.user_id))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    result["confirmation"] = state.get_confirmation_state(normalized_tenant_id)
    result["tenant_id"] = normalized_tenant_id
    return result


@app.get("/manifest")
def get_manifest(tenant_id: str) -> dict:
    tenant_id = tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    return {
        "tenant_id": normalized_tenant_id,
        "manifest": state.get_manifest(normalized_tenant_id),
        "confirmation": state.get_confirmation_state(normalized_tenant_id),
    }


@app.post("/confirm")
def confirm_manifest(request: TenantRequest) -> dict:
    tenant_id = request.tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    save_path = state.confirm_manifest(normalized_tenant_id)
    return {
        "status": "confirmed",
        "tenant_id": normalized_tenant_id,
        "path": str(save_path),
        "confirmation": state.get_confirmation_state(normalized_tenant_id),
    }


@app.post("/api/tenant/implement")
def implement_tenant(request: ImplementRequest) -> dict:
    tenant_id = request.tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    resolved_base_repo_path = _resolve_base_repo_path(request.base_repo_path)
    confirmation = state.get_confirmation_state(normalized_tenant_id)
    if not confirmation.get("is_confirmed"):
        raise HTTPException(
            status_code=409,
            detail="Manifest must be confirmed before implementation.",
        )
    if confirmation.get("has_unconfirmed_changes"):
        raise HTTPException(
            status_code=409,
            detail="Manifest has unconfirmed changes. Confirm the manifest again before implementation.",
        )

    manifest = _load_saved_manifest(normalized_tenant_id)
    app_targets = _normalize_app_targets(request.app_targets)

    tenant_repo_snapshot_root = Path(get_tenant_repo_path(
        base_repo_path=str(resolved_base_repo_path),
        tenant_name=normalized_tenant_id,
    )).resolve()
    tenant_repo_existed_before = tenant_repo_snapshot_root.exists() and tenant_repo_snapshot_root.is_dir()
    snapshot_before = _snapshot_repo_files(tenant_repo_snapshot_root) if tenant_repo_existed_before else {}

    try:
        result = run_customization(
            manifest=manifest,
            base_repo_path=str(resolved_base_repo_path),
            app_targets=app_targets,
            validator_issues=request.validator_issues,
            pipeline_mode=request.pipeline_mode,
            run_quality_gates_enabled=request.run_quality_gates,
            start_preview_enabled=request.start_preview,
            byok_config=_bind_llm(request.llm_config, request.user_id),
        )
    except ManifestValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Manifest validation failed before implementation.",
                "errors": exc.errors,
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    tenant_repo_path = Path(str(result.get("repo_path", ""))).resolve()
    snapshot_after = _snapshot_repo_files(tenant_repo_path)
    snapshot_modified_files = _derive_snapshot_modified_files(snapshot_before, snapshot_after) if tenant_repo_existed_before else []

    modified_files = result.get("modified_files", [])
    runner_modified_files = [
        item for item in modified_files
        if isinstance(item, str) and item.strip()
    ]
    normalized_modified_files = _merge_modified_file_lists(runner_modified_files, snapshot_modified_files)
    errors = result.get("errors", [])

    modified_file_diffs: list[dict[str, Any]] = []
    if normalized_modified_files and tenant_repo_path.exists() and tenant_repo_path.is_dir():
        modified_file_diffs = _build_modified_file_diffs(
            base_repo_path=resolved_base_repo_path,
            tenant_repo_path=tenant_repo_path,
            modified_files=normalized_modified_files,
        )
        source_lookup = _source_by_file(result.get("change_sources", []))
        for entry in modified_file_diffs:
            source = source_lookup.get(entry.get("file", ""))
            if source:
                entry["source"] = source.get("source")
                if source.get("operation"):
                    entry["operation"] = source.get("operation")

    quality_report = result.get("quality_report", {"status": "not_run", "checks": []})
    implementation_record_path = (
        BACKEND_DIR
        / "tenants"
        / normalized_tenant_id
        / "latest-implementation.json"
    )
    try:
        write_implementation_record(
            record_path=implementation_record_path,
            tenant_id=normalized_tenant_id,
            base_repo_path=str(resolved_base_repo_path),
            source_repo_path=str(tenant_repo_path),
            manifest=manifest,
            quality_report=quality_report,
            run_id=str(result.get("run_id", "")),
        )
    except (OSError, SnapshotError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Implementation completed but its snapshot handoff record could not be written: {exc}",
        ) from exc

    return {
        "status": "implementation_complete" if normalized_modified_files else "no_changes",
        "run_id": result.get("run_id", ""),
        "pipeline_mode": result.get("pipeline_mode", request.pipeline_mode or "hybrid"),
        "tenant_id": result["tenant_id"],
        "app_targets": result.get("app_targets", app_targets),
        "repo_path": result["repo_path"],
        "base_repo_path": str(resolved_base_repo_path),
        "modified_files": normalized_modified_files,
        "modified_file_diffs": modified_file_diffs,
        "change_sources": result.get("change_sources", []),
        "quality_report": quality_report,
        "preview": result.get("preview"),
        "diagnostic": result.get("diagnostic"),
        "errors": errors,
        "warnings": result.get("warnings", []),
        "plan_markdown_path": result.get("plan_markdown_path", ""),
    }


@app.post("/api/tenant/preview/start")
def start_tenant_preview(request: PreviewRequest) -> dict:
    tenant_id = state.ensure_tenant(request.tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(request.base_repo_path)
    app_targets = _normalize_app_targets(request.app_targets)
    return start_preview(
        tenant_id=tenant_id,
        base_repo_path=str(resolved_base_repo_path),
        app_targets=app_targets,
        force_restart=request.force_restart,
    )


@app.post("/api/tenant/preview/restart")
def restart_tenant_preview(request: PreviewRequest) -> dict:
    tenant_id = state.ensure_tenant(request.tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(request.base_repo_path)
    app_targets = _normalize_app_targets(request.app_targets)
    return start_preview(
        tenant_id=tenant_id,
        base_repo_path=str(resolved_base_repo_path),
        app_targets=app_targets,
        force_restart=True,
    )


@app.get("/api/tenant/preview/status")
def get_tenant_preview_status(tenant_id: str, base_repo_path: str | None = None) -> dict:
    normalized_tenant_id = state.ensure_tenant(tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(base_repo_path)
    return preview_status(
        tenant_id=normalized_tenant_id,
        base_repo_path=str(resolved_base_repo_path),
    )


@app.post("/api/tenant/preview/stop")
def stop_tenant_preview(request: PreviewRequest) -> dict:
    tenant_id = state.ensure_tenant(request.tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(request.base_repo_path)
    return stop_preview(
        tenant_id=tenant_id,
        base_repo_path=str(resolved_base_repo_path),
    )


def _proxy_tenant_preview_content(
    *,
    http_request: FastAPIRequest,
    tenant_id: str,
    base_repo_path: str | None,
    asset_path: str,
) -> Response:
    normalized_tenant_id = state.ensure_tenant(tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(base_repo_path)
    status = preview_status(
        tenant_id=normalized_tenant_id,
        base_repo_path=str(resolved_base_repo_path),
    )
    if (
        status.get("kind") != "live_server"
        or status.get("status") != "ready"
    ):
        raise HTTPException(
            status_code=503,
            detail=status.get("detail") or "Live preview is not ready.",
        )

    upstream_url = get_preview_upstream_url(
        tenant_id=normalized_tenant_id,
        base_repo_path=str(resolved_base_repo_path),
    )
    if not upstream_url:
        raise HTTPException(status_code=503, detail="Live preview process is no longer available.")
    parsed_url = urlsplit(upstream_url)
    if parsed_url.scheme != "http" or parsed_url.hostname != "127.0.0.1" or parsed_url.port is None:
        raise HTTPException(status_code=502, detail="Preview manager returned an unsafe upstream URL.")
    normalized_asset_path = str(asset_path or "").replace("\\", "/").lstrip("/")
    if "\0" in normalized_asset_path:
        raise HTTPException(status_code=400, detail="Invalid preview asset path.")
    upstream_path = "/" + quote(normalized_asset_path, safe="/@._~-")
    forwarded_query = [
        (key, value)
        for key, value in http_request.query_params.multi_items()
        if key not in {"tenant_id", "tenantId", "base_repo_path", "project_id", "projectId", "meta"}
    ]
    if forwarded_query:
        upstream_path = f"{upstream_path}?{urlencode(forwarded_query)}"

    connection = http.client.HTTPConnection("127.0.0.1", parsed_url.port, timeout=20)
    try:
        connection.request(
            "GET",
            upstream_path,
            headers={
                "Accept": http_request.headers.get("accept", "*/*"),
                "User-Agent": http_request.headers.get("user-agent", "DeplAI Preview Proxy"),
            },
        )
        upstream = connection.getresponse()
        body = upstream.read(25 * 1024 * 1024 + 1)
        if len(body) > 25 * 1024 * 1024:
            raise HTTPException(status_code=502, detail="Preview response exceeded the 25 MB proxy limit.")
        headers: dict[str, str] = {}
        content_type = upstream.getheader("content-type")
        location = upstream.getheader("location")
        if content_type:
            headers["content-type"] = content_type
        if location:
            headers["location"] = location
        return Response(content=body, status_code=upstream.status, headers=headers)
    except (OSError, http.client.HTTPException) as exc:
        raise HTTPException(status_code=502, detail=f"Live preview proxy failed: {exc}") from exc
    finally:
        connection.close()


@app.get("/api/tenant/preview/content")
def proxy_tenant_preview_root(
    http_request: FastAPIRequest,
    tenant_id: str,
    base_repo_path: str | None = None,
) -> Response:
    return _proxy_tenant_preview_content(
        http_request=http_request,
        tenant_id=tenant_id,
        base_repo_path=base_repo_path,
        asset_path="",
    )


@app.get("/api/tenant/preview/content/{asset_path:path}")
def proxy_tenant_preview_asset(
    asset_path: str,
    http_request: FastAPIRequest,
    tenant_id: str,
    base_repo_path: str | None = None,
) -> Response:
    return _proxy_tenant_preview_content(
        http_request=http_request,
        tenant_id=tenant_id,
        base_repo_path=base_repo_path,
        asset_path=asset_path,
    )


def _snapshot_request_context(
    tenant_id: str,
    base_repo_path: str | None,
) -> tuple[str, Path, dict[str, Any], dict[str, Any]]:
    normalized_tenant_id = state.ensure_tenant(tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(base_repo_path)
    manifest = _load_saved_manifest(normalized_tenant_id)
    record_path = (
        BACKEND_DIR
        / "tenants"
        / normalized_tenant_id
        / "latest-implementation.json"
    )
    try:
        implementation_record = load_implementation_record(record_path)
    except SnapshotError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if (
        not implementation_record.get("manifest_hash")
        or not implementation_record.get("base_revision")
    ):
        raise HTTPException(
            status_code=409,
            detail="Latest implementation record is incomplete; run implementation again.",
        )
    expected_source_path = Path(
        get_tenant_repo_path(
            base_repo_path=str(resolved_base_repo_path),
            tenant_name=normalized_tenant_id,
        )
    ).resolve()
    if (
        implementation_record.get("tenant_id") != normalized_tenant_id
        or Path(str(implementation_record.get("base_repo_path") or "")).resolve()
        != resolved_base_repo_path
        or Path(str(implementation_record.get("source_repo_path") or "")).resolve()
        != expected_source_path
    ):
        raise HTTPException(
            status_code=409,
            detail="Tenant source is stale for the requested base repository.",
        )
    return (
        normalized_tenant_id,
        resolved_base_repo_path,
        manifest,
        implementation_record,
    )


@app.post("/api/tenant/snapshots")
def create_tenant_snapshot(request: SnapshotCreateRequest) -> dict:
    tenant_id, base_repo_path, manifest, implementation_record = _snapshot_request_context(
        request.tenant_id,
        request.base_repo_path,
    )
    quality_report = request.quality_report
    if quality_report is None:
        stored_quality = implementation_record.get("quality_report")
        quality_report = (
            stored_quality
            if isinstance(stored_quality, dict)
            else {"status": "not_run", "checks": []}
        )
    try:
        return create_snapshot(
            tenant_id=tenant_id,
            base_repo_path=str(base_repo_path),
            manifest=manifest,
            quality_report=quality_report,
            expected_manifest_hash=str(implementation_record.get("manifest_hash") or ""),
            expected_base_revision=str(implementation_record.get("base_revision") or ""),
        )
    except SnapshotError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Snapshot creation failed: {exc}") from exc


@app.get("/api/tenant/snapshots/latest")
def get_latest_tenant_snapshot(
    tenant_id: str,
    base_repo_path: str | None = None,
) -> dict:
    normalized_tenant_id = state.ensure_tenant(tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(base_repo_path)
    try:
        return get_latest_snapshot(
            tenant_id=normalized_tenant_id,
            base_repo_path=str(resolved_base_repo_path),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SnapshotError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/tenant/snapshots/{snapshot_id}")
def get_tenant_snapshot(
    snapshot_id: str,
    tenant_id: str,
    base_repo_path: str | None = None,
) -> dict:
    normalized_tenant_id = state.ensure_tenant(tenant_id.strip())
    resolved_base_repo_path = _resolve_base_repo_path(base_repo_path)
    try:
        return get_snapshot(
            tenant_id=normalized_tenant_id,
            base_repo_path=str(resolved_base_repo_path),
            snapshot_id=snapshot_id,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SnapshotError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/admin/tenant/reset-repo")
def admin_reset_tenant_repo(request: AdminRepoResetRequest) -> dict:
    """
    Explicit maintenance endpoint that rebuilds a tenant repository from base.

    This is intentionally separate from normal implementation to preserve
    one-tenant-one-repo continuity unless a manual reset is requested.
    """
    tenant_id = request.tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    resolved_base_repo_path = _resolve_base_repo_path(request.base_repo_path)

    normalized_tenant_id = state.ensure_tenant(tenant_id)
    target_repo_path = get_tenant_repo_path(
        base_repo_path=str(resolved_base_repo_path),
        tenant_name=normalized_tenant_id,
    )
    target_repo = Path(target_repo_path)
    existed_before = target_repo.exists()
    previous_inode = target_repo.stat().st_ino if existed_before else None
    repo_path = reset_tenant_repo(
        base_repo_path=str(resolved_base_repo_path),
        tenant_name=normalized_tenant_id,
    )
    new_inode = Path(repo_path).stat().st_ino
    state.reset(normalized_tenant_id)

    reset_manifest = state.get_manifest(normalized_tenant_id)
    reset_confirmation = state.get_confirmation_state(normalized_tenant_id)
    return {
        "status": "repo_reset",
        "tenant_id": normalized_tenant_id,
        "deleted_existing_repo": existed_before,
        "previous_inode": previous_inode,
        "new_inode": new_inode,
        "recreated": previous_inode != new_inode if previous_inode is not None else True,
        "session_reset": True,
        "manifest": reset_manifest,
        "confirmation": reset_confirmation,
        "reset_source_repo": str(resolved_base_repo_path),
        "repo_path": repo_path,
    }


@app.post("/api/tenant/assets/upload")
async def upload_asset(
    tenant_id: str = Form(...),
    asset_type: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    """
    Upload a branding asset for a tenant.

    The file is validated (image-only, ≤5 MB), stored under
    tenants/{tenant_id}/assets/, and the in-memory manifest is patched with
    the stored path so the next /confirm + /implement run will apply it.
    """
    tenant_id = tenant_id.strip()
    asset_type = asset_type.strip()

    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    if asset_type not in SUPPORTED_ASSET_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"asset_type must be one of: {sorted(SUPPORTED_ASSET_TYPES)}",
        )
    if file.filename is None or file.filename == "":
        raise HTTPException(status_code=400, detail="Uploaded file must have a filename.")

    file_data = await file.read()
    content_type = file.content_type or "application/octet-stream"

    try:
        stored_path = store_asset(
            base_dir=BACKEND_DIR,
            tenant_id=normalized_tenant_id,
            asset_type=asset_type,
            file_data=file_data,
            original_filename=file.filename,
            content_type=content_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Patch the in-memory manifest so the branding section reflects the asset
    patch: dict = {"categories": {"branding": {asset_type: stored_path}}}
    state.apply_patch(normalized_tenant_id, patch)

    return {
        "status": "uploaded",
        "tenant_id": normalized_tenant_id,
        "asset_type": asset_type,
        "stored_path": stored_path,
        "manifest_patch": patch,
        "confirmation": state.get_confirmation_state(normalized_tenant_id),
    }


@app.get("/api/tenant/assets/{tenant_id}/{asset_type}")
def serve_asset(tenant_id: str, asset_type: str) -> FileResponse:
    """
    Serve a stored branding asset so it can be previewed in the prototype UI.
    """
    asset_type = asset_type.strip()
    if asset_type not in SUPPORTED_ASSET_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"asset_type must be one of: {sorted(SUPPORTED_ASSET_TYPES)}",
        )
    file_path = get_asset_file_path(BACKEND_DIR, tenant_id, asset_type)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Asset not found.")
    return FileResponse(str(file_path))


@app.get("/api/tenant/assets/{tenant_id}")
def list_assets(tenant_id: str) -> dict:
    """Return metadata for all uploaded assets for a tenant."""
    try:
        metadata = get_assets_metadata(BACKEND_DIR, tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"tenant_id": tenant_id, "assets": metadata}


@app.get("/api/tenant/repo-index/{tenant_id}")
def get_repo_index(tenant_id: str) -> dict:
    index_path = BACKEND_DIR / "tenants" / tenant_id / "repo-index.json"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Repo index not found. Run implementation first.")
    try:
        return json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Stored repo index is invalid JSON.") from exc


@app.get("/api/tenant/plan/{tenant_id}")
def get_plan_markdown(tenant_id: str) -> PlainTextResponse:
    plan_path = BACKEND_DIR / "tenants" / tenant_id / "plan.md"
    if not plan_path.exists():
        raise HTTPException(status_code=404, detail="Plan markdown not found. Run implementation first.")
    return PlainTextResponse(plan_path.read_text(encoding="utf-8"))


@app.post("/reset")
def reset_manifest(request: TenantRequest) -> dict:
    tenant_id = request.tenant_id.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required.")
    normalized_tenant_id = state.ensure_tenant(tenant_id)
    state.reset(normalized_tenant_id)
    return {
        "status": "reset",
        "tenant_id": normalized_tenant_id,
        "manifest": state.get_manifest(normalized_tenant_id),
        "confirmation": state.get_confirmation_state(normalized_tenant_id),
    }

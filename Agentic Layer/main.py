import asyncio
import base64
import hmac
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
import boto3
from typing import Any
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

from functools import partial
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from models import (
    ScanValidationRequest, ScanValidationResponse,
    WebSocketCommand, StreamStatus,
    RemediationRequest, RemediationResponse,
    ArchitectureGenRequest, ArchitectureGenResponse,
    CostEstimateRequest, CostEstimateResponse,
    Stage7ApprovalRequest, Stage7ApprovalResponse,
    TerraformGenRequest, TerraformGenResponse,
    TerraformApplyRequest, TerraformApplyResponse,
    TerraformApplyStopRequest, TerraformApplyStopResponse,
    TerraformApplyStatusRequest, TerraformApplyStatusResponse,
    AwsRuntimeDetailsRequest, AwsRuntimeDetailsResponse,
    AwsDestroyRequest, AwsDestroyResponse,
)
from environment import EnvironmentInitializer
from cleanup import cleanup_volumes, cleanup_project_reports
from result_parser import get_scan_results, get_scan_status, invalidate_cache
from remediation import RemediationRunner
from runner_base import RunnerBase
from architecture_gen import generate_architecture
from architecture_contract import ArchitectureContractError, parse_architecture_document
from architecture_decision import complete_architecture_review, start_architecture_review
from cost_estimation import estimate_cost
from deployment_planning_contract import (
    ArchitectureReviewCompleteRequest,
    ArchitectureReviewCompleteResponse,
    ArchitectureReviewStartRequest,
    ArchitectureReviewStartResponse,
    RepositoryAnalysisRequest,
    RepositoryAnalysisResponse,
)
from claude_deployment_pipeline import generate_terraform_bundle
from repository_analysis import run_repository_analysis
from stage7_bridge import run_stage7_approval_payload
from utils import get_docker_client

logger = logging.getLogger(__name__)

app = FastAPI(
    title="DEPLAI Agentic Layer",
    description="Backend API for scan validation",
    version="1.0.0"
)

API_KEY = os.environ.get("DEPLAI_SERVICE_KEY")
if not API_KEY:
    raise RuntimeError(
        "DEPLAI_SERVICE_KEY environment variable is not set. "
        "Set it to a strong random secret before starting the service."
    )

# WS_TOKEN_SECRET verifies short-lived HMAC tokens issued by the Connector.
# Falls back to API_KEY so single-secret deployments keep working.
WS_TOKEN_SECRET = (os.environ.get("WS_TOKEN_SECRET") or API_KEY).encode()


def _verify_ws_token(token: str, expected_project_id: str) -> bool:
    """Verify a HMAC-SHA256 WebSocket token issued by the Connector ws-token route.

    Checks signature, expiry, and that the token was issued for *expected_project_id*
    so that a token minted for project A cannot be replayed against project B.
    """
    try:
        payload_b64, sig = token.split(".", 1)
        expected = hmac.new(WS_TOKEN_SECRET, payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return False
        # Add padding before decoding (base64url may omit it)
        padding = 4 - len(payload_b64) % 4
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * padding).decode())
        if payload.get("exp", 0) <= time.time():
            return False
        # Validate that this token was issued for the connecting project.
        # Tokens lacking a project_id claim are rejected to prevent replaying
        # older tokens that pre-date the project binding requirement.
        if payload.get("project_id") != expected_project_id:
            return False
        return True
    except Exception:
        return False


def _extract_ws_token_sub(token: str) -> str | None:
    """Return the `sub` claim from an already-verified WS token, or None on error."""
    try:
        payload_b64 = token.split(".", 1)[0]
        padding = 4 - len(payload_b64) % 4
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * padding).decode())
        sub = payload.get("sub")
        return str(sub) if sub is not None else None
    except Exception:
        return None


async def verify_api_key(x_api_key: str = Header(None)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory stores
active_scans: dict[str, EnvironmentInitializer] = {}
scan_contexts: dict[str, ScanValidationRequest] = {}
active_remediations: dict[str, RemediationRunner] = {}
remediation_contexts: dict[str, RemediationRequest] = {}
# Pipeline monitor subscribers per project (shared websocket bus for dashboard events)
pipeline_subscribers: dict[str, set[WebSocket]] = {}
pipeline_indices: dict[str, int] = {}
pipeline_lock = asyncio.Lock()
active_terraform_applies: dict[str, dict] = {}
terraform_apply_results: dict[str, dict] = {}


async def _broadcast_pipeline_event(project_id: str, msg_type: str, content: str) -> None:
    text = str(content or "").strip()
    if not text:
        return

    async with pipeline_lock:
        subscribers = list(pipeline_subscribers.get(project_id, set()))
        if not subscribers:
            return
        next_index = pipeline_indices.get(project_id, 0) + 1
        pipeline_indices[project_id] = next_index

    payload = {
        "type": "message",
        "data": {
            "index": next_index,
            "total": 0,
            "type": msg_type or "info",
            "content": text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }

    dead: list[WebSocket] = []
    for ws in subscribers:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)

    if dead:
        async with pipeline_lock:
            live = pipeline_subscribers.get(project_id)
            if not live:
                return
            for ws in dead:
                live.discard(ws)
            if not live:
                pipeline_subscribers.pop(project_id, None)
                pipeline_indices.pop(project_id, None)


async def _handle_websocket(
    websocket: WebSocket,
    project_id: str,
    create_runner,
    contexts: dict,
    active: dict,
    missing_context_msg: str,
    on_complete=None,  # Optional sync callable invoked after pipeline succeeds (before 'completed' is sent)
):
    """Shared WebSocket handler for scan and remediation endpoints."""
    token_sub: str | None = None
    if API_KEY is not None:
        token = websocket.query_params.get("token")
        if not token or not _verify_ws_token(token, project_id):
            await websocket.close(code=1008, reason="Invalid or missing token")
            return
        # Extract the user identity claim so we can validate it against the
        # stored context later — prevents a valid token for user A being used
        # to drive a pipeline that belongs to user B.
        token_sub = _extract_ws_token_sub(token)

    await websocket.accept()

    async def run_workflow(runner: RunnerBase):
        try:
            success = await runner.run()
            if success:
                # Invoke completion hook before notifying the client, so that
                # any cache invalidation happens before the frontend re-fetches.
                if on_complete:
                    on_complete()
                await websocket.send_json({
                    "type": "status",
                    "status": StreamStatus.completed.value,
                })
            else:
                # Pipeline returned False — error status was already sent by _terminate(),
                # but send it again as a safety net in case the pipeline exited a different way.
                try:
                    await websocket.send_json({
                        "type": "status",
                        "status": StreamStatus.error.value,
                    })
                except Exception:
                    pass
        except WebSocketDisconnect:
            pass
        except Exception as e:
            try:
                await websocket.send_json({
                    "type": "status",
                    "status": StreamStatus.error.value,
                    "error": str(e),
                })
            except Exception:
                pass
        finally:
            contexts.pop(project_id, None)
            active.pop(project_id, None)

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            command = WebSocketCommand(**data)

            if command.action == "start":
                # Cancel existing runner and WAIT for its task to finish before
                # starting a new one — prevents two pipelines racing on shared volumes.
                if project_id in active:
                    old_runner = active[project_id]
                    old_runner.cancel()
                    if old_runner._task is not None and not old_runner._task.done():
                        try:
                            await asyncio.wait_for(asyncio.shield(old_runner._task), timeout=10)
                        except (asyncio.CancelledError, asyncio.TimeoutError):
                            pass
                    active.pop(project_id, None)

                context = contexts.get(project_id)
                if context is None:
                    await websocket.send_json({
                        "type": "status",
                        "status": StreamStatus.error.value,
                        "error": missing_context_msg,
                    })
                    continue

                # Reject the command if the token's sub claim doesn't match the
                # user_id stored when the context was validated.  This prevents a
                # legitimate token being replayed against another user's project.
                # Both sides are normalised to str because the JWT sub claim may be
                # decoded as an int (from JSON) while Pydantic coerces user_id to str.
                if token_sub is not None and str(getattr(context, "user_id", "")) != str(token_sub):
                    await websocket.send_json({
                        "type": "status",
                        "status": StreamStatus.error.value,
                        "error": "Unauthorized",
                    })
                    await websocket.close(code=1008, reason="Unauthorized")
                    return

                runner = create_runner(websocket, project_id, context)
                active[project_id] = runner

                await websocket.send_json({
                    "type": "status",
                    "status": StreamStatus.running.value,
                })

                task = asyncio.create_task(run_workflow(runner))
                runner._task = task  # attach so cancel() can interrupt it
            elif command.action == "approve_rescan":
                runner = active.get(project_id)
                if runner is None:
                    await websocket.send_json({
                        "type": "status",
                        "status": StreamStatus.error.value,
                        "error": "No active workflow found for this project.",
                    })
                    continue
                await runner.handle_command(command)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        runner = active.get(project_id)
        # Do NOT cancel active workflows on websocket disconnect.
        # Users may navigate away/reload and return later; the backend run should continue.
        if runner is None:
            # Workflow never started; safe to cleanup context.
            contexts.pop(project_id, None)
        elif runner._task is not None and runner._task.done():
            # Defensive cleanup if a completed runner is still present.
            active.pop(project_id, None)
            contexts.pop(project_id, None)


@app.post("/api/scan/validate", response_model=ScanValidationResponse, dependencies=[Depends(verify_api_key)])
async def validate_scan(request: ScanValidationRequest):
    """Validate a scan request from the frontend."""
    logger.info(
        "Scan validation request: project=%s type=%s user=%s",
        request.project_id, request.project_type, request.user_id,
    )

    scan_contexts[request.project_id] = request
    invalidate_cache(request.project_id)

    return ScanValidationResponse(
        success=True,
        message="Scan validation request received successfully",
        data=request
    )


@app.websocket("/ws/scan/{project_id}")
async def websocket_scan(websocket: WebSocket, project_id: str):
    await _handle_websocket(
        websocket, project_id,
        create_runner=lambda ws, pid, ctx: EnvironmentInitializer(ws, ctx),
        contexts=scan_contexts,
        active=active_scans,
        missing_context_msg="No scan context found. Please validate the scan first.",
        # Invalidate the Python cache after the scanner writes new volume files so
        # the very first frontend fetch after 'completed' always reads fresh data.
        on_complete=lambda: invalidate_cache(project_id),
    )


@app.get("/api/scan/results/{project_id}", dependencies=[Depends(verify_api_key)])
async def scan_results(project_id: str):
    """Return parsed scan results from Docker volumes."""
    loop = asyncio.get_running_loop()
    success, data = await loop.run_in_executor(
        None, partial(get_scan_results, project_id)
    )
    if not success:
        raise HTTPException(status_code=404, detail=data)
    return {"success": True, "data": data}


@app.get("/api/scan/status/{project_id}", dependencies=[Depends(verify_api_key)])
async def scan_status(project_id: str):
    """Return lightweight vulnerability status: found, not_found, not_initiated, or running."""
    if project_id in active_scans:
        return {"status": "running"}
    loop = asyncio.get_running_loop()
    status = await loop.run_in_executor(
        None, partial(get_scan_status, project_id)
    )
    return {"status": status}


@app.delete("/api/scan/results/{project_id}", dependencies=[Depends(verify_api_key)])
async def delete_scan_results(project_id: str):
    """Delete scan report files for a specific project from the Docker volume."""
    loop = asyncio.get_running_loop()
    success, error_msg = await loop.run_in_executor(
        None, partial(cleanup_project_reports, project_id)
    )
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to delete scan reports: {error_msg}")
    return {"success": True, "message": "Scan reports deleted successfully"}


@app.post("/api/cleanup", dependencies=[Depends(verify_api_key)])
async def cleanup():
    """Remove ALL Docker volumes.

    This is a destructive, global operation that wipes data for every project.
    It is disabled by default and must be explicitly opted in via the
    ALLOW_GLOBAL_CLEANUP=true environment variable to prevent accidental
    data loss in multi-user deployments.
    """
    if os.environ.get("ALLOW_GLOBAL_CLEANUP", "").lower() != "true":
        raise HTTPException(
            status_code=403,
            detail=(
                "Global volume cleanup is disabled. "
                "Set ALLOW_GLOBAL_CLEANUP=true on the agentic-layer service to enable it."
            ),
        )
    loop = asyncio.get_running_loop()
    success, error_msg = await loop.run_in_executor(None, cleanup_volumes)
    if not success:
        raise HTTPException(status_code=500, detail=f"Cleanup failed: {error_msg}")
    scan_contexts.clear()
    return {"success": True, "message": "Docker volumes removed successfully"}


@app.post("/api/remediate/validate", response_model=RemediationResponse, dependencies=[Depends(verify_api_key)])
async def validate_remediation(request: RemediationRequest):
    """Validate a remediation request and store context."""
    logger.info(
        "Remediation request: project=%s type=%s user=%s",
        request.project_id, request.project_type, request.user_id,
    )
    remediation_contexts[request.project_id] = request
    return RemediationResponse(
        success=True,
        message="Remediation request accepted",
    )


@app.websocket("/ws/remediate/{project_id}")
async def websocket_remediate(websocket: WebSocket, project_id: str):
    """WebSocket endpoint for streaming remediation progress."""
    await _handle_websocket(
        websocket, project_id,
        create_runner=lambda ws, pid, ctx: RemediationRunner(ws, ctx),
        contexts=remediation_contexts,
        active=active_remediations,
        missing_context_msg="No remediation context found. Please validate first.",
        # Invalidate cache after the remediation re-scan writes new volume files,
        # so the first frontend fetch after 'completed' always reads fresh data.
        on_complete=lambda: invalidate_cache(project_id),
    )


@app.websocket("/ws/pipeline/{project_id}")
async def websocket_pipeline(websocket: WebSocket, project_id: str):
    """Project-scoped websocket bus for dashboard pipeline monitor events."""
    if API_KEY is not None:
        token = websocket.query_params.get("token")
        if not token or not _verify_ws_token(token, project_id):
            await websocket.close(code=1008, reason="Invalid or missing token")
            return

    await websocket.accept()

    async with pipeline_lock:
        bucket = pipeline_subscribers.setdefault(project_id, set())
        bucket.add(websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue

            action = str(data.get("action") or "").strip().lower()
            if action == "start":
                await websocket.send_json({
                    "type": "status",
                    "status": StreamStatus.running.value,
                })
                await _broadcast_pipeline_event(
                    project_id,
                    "phase",
                    "[SYSTEM] Pipeline monitor websocket connected.",
                )
                continue

            if action == "emit":
                event = data.get("data") if isinstance(data.get("data"), dict) else {}
                msg_type = str(event.get("type") or "info")
                content = str(event.get("content") or "")
                await _broadcast_pipeline_event(project_id, msg_type, content)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with pipeline_lock:
            bucket = pipeline_subscribers.get(project_id)
            if bucket is not None:
                bucket.discard(websocket)
                if not bucket:
                    pipeline_subscribers.pop(project_id, None)
                    pipeline_indices.pop(project_id, None)


@app.post("/api/repository-analysis/run", response_model=RepositoryAnalysisResponse, dependencies=[Depends(verify_api_key)])
async def repository_analysis_run(request: RepositoryAnalysisRequest):
    loop = asyncio.get_running_loop()
    workspace = str(request.workspace or request.project_name or request.project_id).strip()
    try:
        context_json, context_md, runtime_paths = await loop.run_in_executor(
            None,
            lambda: run_repository_analysis(
                project_id=request.project_id,
                project_name=request.project_name,
                project_type=request.project_type,
                workspace=workspace,
                user_id=request.user_id,
                repo_full_name=request.repo_full_name,
            ),
        )
    except Exception as exc:
        logger.exception("Repository analysis failed")
        return RepositoryAnalysisResponse(success=False, error=str(exc), workspace=workspace)

    return RepositoryAnalysisResponse(
        success=True,
        workspace=workspace,
        context_json=context_json,
        context_md=context_md,
        runtime_paths=runtime_paths,
    )


@app.post("/api/architecture/review/start", response_model=ArchitectureReviewStartResponse, dependencies=[Depends(verify_api_key)])
async def architecture_review_start(request: ArchitectureReviewStartRequest):
    loop = asyncio.get_running_loop()
    try:
        review = await loop.run_in_executor(
            None,
            lambda: start_architecture_review(
                project_id=request.project_id,
                project_name=request.project_name,
                project_type=request.project_type,
                workspace=request.workspace,
                user_id=request.user_id,
                repo_full_name=request.repo_full_name,
                environment=request.environment,
            ),
        )
    except Exception as exc:
        logger.exception("Architecture review start failed")
        return ArchitectureReviewStartResponse(success=False, workspace=request.workspace, error=str(exc))
    return ArchitectureReviewStartResponse(success=True, workspace=request.workspace, review=review)


@app.post("/api/architecture/review/complete", response_model=ArchitectureReviewCompleteResponse, dependencies=[Depends(verify_api_key)])
async def architecture_review_complete(request: ArchitectureReviewCompleteRequest):
    loop = asyncio.get_running_loop()
    try:
        answers_json, deployment_profile, architecture_view, approval_payload, runtime_paths = await loop.run_in_executor(
            None,
            lambda: complete_architecture_review(
                project_id=request.project_id,
                project_name=request.project_name,
                project_type=request.project_type,
                workspace=request.workspace,
                answers=request.answers,
                user_id=request.user_id,
                repo_full_name=request.repo_full_name,
            ),
        )
    except Exception as exc:
        logger.exception("Architecture review completion failed")
        return ArchitectureReviewCompleteResponse(success=False, workspace=request.workspace, error=str(exc))
    return ArchitectureReviewCompleteResponse(
        success=True,
        workspace=request.workspace,
        answers_json=answers_json,
        deployment_profile=deployment_profile,
        architecture_view=architecture_view,
        approval_payload=approval_payload,
        runtime_paths=runtime_paths,
    )


@app.post("/api/architecture/generate", response_model=ArchitectureGenResponse, dependencies=[Depends(verify_api_key)])
async def architecture_generate(request: ArchitectureGenRequest):
    """Generate architecture JSON from a natural language prompt."""
    result = await generate_architecture(
        prompt=request.prompt,
        provider=request.provider,
        llm_provider=request.llm_provider or "",
        llm_api_key=request.llm_api_key or "",
        llm_model=request.llm_model or "",
    )
    if not result.get("success"):
        return ArchitectureGenResponse(success=False, error=result.get("error", "Unknown error"))
    try:
        architecture_doc = parse_architecture_document(result.get("architecture_json"))
    except ArchitectureContractError as exc:
        return ArchitectureGenResponse(
            success=False,
            error=f"Generated architecture_json failed contract validation: {exc}",
        )
    provider = str(request.provider or "").strip().lower()
    if provider in {"aws", "azure", "gcp"} and architecture_doc.provider is None:
        architecture_doc = architecture_doc.model_copy(update={"provider": provider})
    return ArchitectureGenResponse(success=True, architecture_json=architecture_doc)


@app.post("/api/cost/estimate", response_model=CostEstimateResponse, dependencies=[Depends(verify_api_key)])
async def cost_estimate(request: CostEstimateRequest):
    """Estimate monthly cloud infrastructure costs from an architecture JSON."""
    architecture_json = request.architecture_json.to_wire_dict()
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: estimate_cost(
            architecture_json,
            provider=request.provider,
            access_key=request.aws_access_key_id or "",
            secret_key=request.aws_secret_access_key or "",
        ),
    )
    if not result.get("success"):
        return CostEstimateResponse(success=False, provider=request.provider, error=result.get("error"))
    return CostEstimateResponse(
        success=True,
        provider=result.get("provider", request.provider),
        total_monthly_usd=result.get("total_monthly_usd"),
        currency=result.get("currency", "USD"),
        breakdown=result.get("breakdown"),
        note=result.get("note"),
        errors=result.get("errors"),
    )


@app.post("/api/stage7/approval", response_model=Stage7ApprovalResponse, dependencies=[Depends(verify_api_key)])
async def stage7_approval(request: Stage7ApprovalRequest):
    """Run Stage 7 diagram+cost+budget agent and return approval payload."""
    loop = asyncio.get_running_loop()

    try:
        approval_payload = await loop.run_in_executor(
            None,
            lambda: run_stage7_approval_payload(
                infra_plan=request.infra_plan,
                budget_cap_usd=request.budget_cap_usd,
                pipeline_run_id=request.pipeline_run_id,
                environment=request.environment,
            ),
        )
    except Exception as exc:
        logger.exception("Stage7 approval generation failed")
        return Stage7ApprovalResponse(success=False, error=str(exc))

    return Stage7ApprovalResponse(success=True, approval_payload=approval_payload)


@app.post("/api/terraform/generate", response_model=TerraformGenResponse, dependencies=[Depends(verify_api_key)])
async def terraform_generate(request: TerraformGenRequest):
    """Generate Terraform IaC files from a Claude-derived deployment profile."""
    loop = asyncio.get_running_loop()
    architecture_json = dict(request.architecture_json or {})
    agent_result = await loop.run_in_executor(
        None,
        lambda: generate_terraform_bundle(
            architecture_json=architecture_json,
            project_name=request.project_name,
            workspace=request.workspace,
            aws_region=request.aws_region,
            qa_summary=request.qa_summary or "",
            website_index_html=request.website_index_html or "",
        ),
    )

    if agent_result and agent_result.get("success"):
        return TerraformGenResponse(
            success=True,
            provider=request.provider,
            project_name=request.project_name,
            run_id=agent_result.get("run_id"),
            workspace=agent_result.get("workspace"),
            provider_version=agent_result.get("provider_version"),
            state_bucket=agent_result.get("state_bucket"),
            lock_table=agent_result.get("lock_table"),
            manifest=agent_result.get("manifest"),
            dag_order=agent_result.get("dag_order"),
            warnings=agent_result.get("warnings"),
            files=agent_result.get("files"),
            readme=agent_result.get("readme"),
            source=str(agent_result.get("source") or "terraform_agent"),
        )

    error_message = "Terraform agent unavailable."
    if isinstance(agent_result, dict):
        error_message = str(agent_result.get("error") or error_message)
    return TerraformGenResponse(
        success=False,
        provider=request.provider,
        project_name=request.project_name,
        run_id=agent_result.get("run_id") if isinstance(agent_result, dict) else None,
        workspace=agent_result.get("workspace") if isinstance(agent_result, dict) else None,
        provider_version=agent_result.get("provider_version") if isinstance(agent_result, dict) else None,
        state_bucket=agent_result.get("state_bucket") if isinstance(agent_result, dict) else None,
        lock_table=agent_result.get("lock_table") if isinstance(agent_result, dict) else None,
        manifest=agent_result.get("manifest") if isinstance(agent_result, dict) else None,
        dag_order=agent_result.get("dag_order") if isinstance(agent_result, dict) else None,
        warnings=agent_result.get("warnings") if isinstance(agent_result, dict) else None,
        error=error_message,
        source=str(agent_result.get("source") or "unavailable") if isinstance(agent_result, dict) else "unavailable",
        details=agent_result.get("details") if isinstance(agent_result, dict) else None,
    )


@app.post("/api/terraform/apply", response_model=TerraformApplyResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply(request: TerraformApplyRequest):
    """Apply generated Terraform files to AWS using an ephemeral Docker volume."""
    from terraform_apply import apply_saved_terraform_run, apply_terraform_bundle

    apply_key = (request.project_id or request.project_name or "").strip()
    if not apply_key:
        apply_key = request.project_name
    loop = asyncio.get_running_loop()

    def emit_apply_event(msg_type: str, content: str) -> None:
        project_id = str(request.project_id or "").strip()
        if not project_id:
            return
        try:
            asyncio.run_coroutine_threadsafe(
                _broadcast_pipeline_event(project_id, msg_type, content),
                loop,
            )
        except Exception:
            pass

    apply_ctx = {"cancel_requested": False, "container_id": None, "emit": emit_apply_event}
    active_terraform_applies[apply_key] = apply_ctx
    terraform_apply_results[apply_key] = {"status": "running", "result": None}

    result = None
    try:
        emit_apply_event("info", "Terraform runtime apply started.")
        if request.run_id and request.workspace:
            emit_apply_event("info", f"Reusing saved Terraform workspace '{request.workspace}'.")
            result = await loop.run_in_executor(
                None,
                lambda: apply_saved_terraform_run(
                    run_id=request.run_id or "",
                    workspace=request.workspace or "",
                    project_name=request.project_name,
                    provider=request.provider,
                    state_bucket=request.state_bucket or "",
                    aws_access_key_id=request.aws_access_key_id or "",
                    aws_secret_access_key=request.aws_secret_access_key or "",
                    aws_region=request.aws_region or "eu-north-1",
                    apply_context=apply_ctx,
                ),
            )
        else:
            emit_apply_event("info", "Applying generated Terraform bundle.")
            result = await loop.run_in_executor(
                None,
                lambda: apply_terraform_bundle(
                    files=[{"path": f.path, "content": f.content, "encoding": f.encoding} for f in request.files],
                    project_name=request.project_name,
                    provider=request.provider,
                    aws_access_key_id=request.aws_access_key_id or "",
                    aws_secret_access_key=request.aws_secret_access_key or "",
                    aws_region=request.aws_region or "eu-north-1",
                    enforce_free_tier_ec2=request.enforce_free_tier_ec2 is not False,
                    apply_context=apply_ctx,
                ),
            )
    except Exception as exc:
        result = {"success": False, "error": f"Terraform apply runtime error: {exc}"}
    finally:
        active_terraform_applies.pop(apply_key, None)
        if result is not None:
            terraform_apply_results[apply_key] = {
                "status": "completed" if bool(result.get("success")) else "error",
                "result": result,
            }
        if result and result.get("success"):
            emit_apply_event("success", "Terraform runtime apply completed successfully.")
        elif result:
            emit_apply_event("error", str(result.get("error") or "Terraform runtime apply failed."))

    if not result.get("success"):
        return TerraformApplyResponse(
            success=False,
            provider=request.provider,
            project_name=request.project_name,
            error=result.get("error", "Terraform apply failed"),
            details=result.get("details"),
        )

    return TerraformApplyResponse(
        success=True,
        provider=request.provider,
        project_name=request.project_name,
        outputs=result.get("outputs"),
        cloudfront_url=result.get("cloudfront_url"),
        details=result.get("details"),
    )


@app.post("/api/terraform/apply/status", response_model=TerraformApplyStatusResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply_status(request: TerraformApplyStatusRequest):
    apply_key = (request.project_id or request.project_name or "").strip()
    if not apply_key:
        return TerraformApplyStatusResponse(success=False, error="project_id or project_name is required")

    if apply_key in active_terraform_applies:
        ctx = active_terraform_applies.get(apply_key) or {}
        return TerraformApplyStatusResponse(
            success=True,
            status="running",
            result={"container_id": ctx.get("container_id")},
        )

    cached = terraform_apply_results.get(apply_key)
    if cached:
        return TerraformApplyStatusResponse(
            success=True,
            status=str(cached.get("status") or "idle"),
            result=cached.get("result"),
        )

    return TerraformApplyStatusResponse(success=True, status="idle", result=None)


@app.post("/api/terraform/apply/stop", response_model=TerraformApplyStopResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply_stop(request: TerraformApplyStopRequest):
    """Stop an active runtime Terraform apply and terminate its active container."""
    apply_key = (request.project_id or request.project_name or "").strip()
    if not apply_key:
        return TerraformApplyStopResponse(success=False, error="project_id or project_name is required")

    ctx = active_terraform_applies.get(apply_key)
    if not ctx:
        return TerraformApplyStopResponse(success=False, message="No active deployment process found for this project.")

    ctx["cancel_requested"] = True
    container_id = str(ctx.get("container_id") or "").strip()
    if not container_id:
        return TerraformApplyStopResponse(success=True, message="Stop requested. Waiting for active Terraform command to start.")

    def _kill_container() -> tuple[bool, str]:
        try:
            docker = get_docker_client()
            container = docker.containers.get(container_id)
            try:
                container.kill()
            except Exception:
                pass
            try:
                container.remove(force=True)
            except Exception:
                pass
            return (True, f"Stopped deployment container {container_id[:12]}.")
        except Exception as exc:
            return (False, f"Failed to stop deployment container: {exc}")

    loop = asyncio.get_running_loop()
    ok, msg = await loop.run_in_executor(None, _kill_container)
    if not ok:
        return TerraformApplyStopResponse(success=False, error=msg)
    return TerraformApplyStopResponse(success=True, message=msg)


@app.post("/api/aws/runtime-details", response_model=AwsRuntimeDetailsResponse, dependencies=[Depends(verify_api_key)])
async def aws_runtime_details(request: AwsRuntimeDetailsRequest):
    try:
        session = boto3.session.Session(
            aws_access_key_id=request.aws_access_key_id,
            aws_secret_access_key=request.aws_secret_access_key,
            region_name=request.aws_region,
        )
        ec2 = session.client("ec2", region_name=request.aws_region)
        s3 = session.client("s3", region_name=request.aws_region)
        cloudfront = session.client("cloudfront")
        sts = session.client("sts", region_name=request.aws_region)

        account_id = str(sts.get_caller_identity().get("Account", ""))

        running_res = ec2.describe_instances(
            Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
        )
        running_instances = [
            i
            for r in running_res.get("Reservations", [])
            for i in r.get("Instances", [])
        ]

        tagged_instances = []
        if request.project_name:
            try:
                tagged_res = ec2.describe_instances(
                    Filters=[
                        {"Name": "tag:Project", "Values": [request.project_name]},
                        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
                    ]
                )
                tagged_instances = [
                    i
                    for r in tagged_res.get("Reservations", [])
                    for i in r.get("Instances", [])
                ]
            except Exception:
                tagged_instances = []

        target_instance = None
        if request.instance_id:
            try:
                by_id = ec2.describe_instances(InstanceIds=[request.instance_id])
                by_id_instances = [
                    i
                    for r in by_id.get("Reservations", [])
                    for i in r.get("Instances", [])
                ]
                if by_id_instances:
                    target_instance = by_id_instances[0]
            except Exception:
                target_instance = None
        if target_instance is None and tagged_instances:
            target_instance = tagged_instances[0]
        if target_instance is None and running_instances:
            target_instance = running_instances[0]

        vpcs = ec2.describe_vpcs().get("Vpcs", []) or []
        subnets = ec2.describe_subnets().get("Subnets", []) or []
        igws = ec2.describe_internet_gateways().get("InternetGateways", []) or []
        route_tables = ec2.describe_route_tables().get("RouteTables", []) or []
        security_groups = ec2.describe_security_groups().get("SecurityGroups", []) or []
        key_pairs = ec2.describe_key_pairs().get("KeyPairs", []) or []
        nat_gateways_raw = ec2.describe_nat_gateways().get("NatGateways", []) or []
        nat_gateways = [n for n in nat_gateways_raw if str(n.get("State", "")).lower() not in {"deleted", "deleting"}]
        all_instances_res = ec2.describe_instances()
        all_instances = [
            i
            for r in all_instances_res.get("Reservations", [])
            for i in r.get("Instances", [])
        ]

        s3_bucket_count = len((s3.list_buckets().get("Buckets", []) or []))
        cf_quantity = int(((cloudfront.list_distributions().get("DistributionList") or {}).get("Quantity")) or 0)

        instance = {
            "instance_id": "n/a",
            "public_ipv4_address": "n/a",
            "private_ipv4_address": "n/a",
            "instance_state": "n/a",
            "instance_type": "n/a",
            "public_dns": "n/a",
            "private_dns": "n/a",
            "vpc_id": "n/a",
            "subnet_id": "n/a",
            "instance_arn": "n/a",
        }
        if target_instance:
            iid = str(target_instance.get("InstanceId") or "")
            instance = {
                "instance_id": iid or "n/a",
                "public_ipv4_address": str(target_instance.get("PublicIpAddress") or "n/a"),
                "private_ipv4_address": str(target_instance.get("PrivateIpAddress") or "n/a"),
                "instance_state": str((target_instance.get("State") or {}).get("Name") or "n/a"),
                "instance_type": str(target_instance.get("InstanceType") or "n/a"),
                "public_dns": str(target_instance.get("PublicDnsName") or "n/a"),
                "private_dns": str(target_instance.get("PrivateDnsName") or "n/a"),
                "vpc_id": str(target_instance.get("VpcId") or "n/a"),
                "subnet_id": str(target_instance.get("SubnetId") or "n/a"),
                "instance_arn": (
                    f"arn:aws:ec2:{request.aws_region}:{account_id}:instance/{iid}"
                    if iid and account_id
                    else "n/a"
                ),
            }

        return AwsRuntimeDetailsResponse(
            success=True,
            details={
                "region": request.aws_region,
                "account_id": account_id or None,
                "instance": instance,
                "resource_counts": {
                    "ec2_instances_total": len(all_instances),
                    "ec2_instances_running": len(running_instances),
                    "vpcs": len(vpcs),
                    "subnets": len(subnets),
                    "nat_gateways": len(nat_gateways),
                    "internet_gateways": len(igws),
                    "route_tables": len(route_tables),
                    "security_groups": len(security_groups),
                    "key_pairs": len(key_pairs),
                    "s3_buckets": s3_bucket_count,
                    "cloudfront_distributions": cf_quantity,
                },
            },
        )
    except Exception as exc:
        return AwsRuntimeDetailsResponse(success=False, error=str(exc))


@app.post("/api/aws/destroy-runtime", response_model=AwsDestroyResponse, dependencies=[Depends(verify_api_key)])
async def aws_destroy_runtime(request: AwsDestroyRequest):
    """Best-effort runtime cleanup for DeplAI-managed AWS resources for a project."""
    try:
        session = boto3.session.Session(
            aws_access_key_id=request.aws_access_key_id,
            aws_secret_access_key=request.aws_secret_access_key,
            region_name=request.aws_region,
        )
        ec2 = session.client("ec2", region_name=request.aws_region)
        s3 = session.client("s3", region_name=request.aws_region)
        cloudfront = session.client("cloudfront")

        project_tag = str(request.project_name or "").strip()
        if not project_tag:
            return AwsDestroyResponse(success=False, error="project_name is required")

        details: dict[str, Any] = {
            "project_name": project_tag,
            "region": request.aws_region,
            "instances_terminated": [],
            "security_groups_deleted": [],
            "volumes_deleted": [],
            "s3_buckets_deleted": [],
            "cloudfront_deleted": [],
            "cloudfront_pending_disable": [],
            "errors": [],
        }

        # 1) Terminate tagged EC2 instances.
        try:
            reservations = ec2.describe_instances(
                Filters=[
                    {"Name": "tag:Project", "Values": [project_tag]},
                    {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
                ]
            ).get("Reservations", [])
            instance_ids = [
                str(inst.get("InstanceId"))
                for res in reservations
                for inst in (res.get("Instances") or [])
                if inst.get("InstanceId")
            ]
            if instance_ids:
                ec2.terminate_instances(InstanceIds=instance_ids)
                details["instances_terminated"] = instance_ids
        except Exception as exc:
            details["errors"].append(f"EC2 termination: {exc}")

        # 2) Delete tagged/related key pair.
        try:
            key_name = f"{project_tag}-key"
            try:
                ec2.delete_key_pair(KeyName=key_name)
            except Exception:
                pass
        except Exception as exc:
            details["errors"].append(f"Key pair delete: {exc}")

        # 3) Delete tagged EBS volumes (available only).
        try:
            volumes = ec2.describe_volumes(
                Filters=[
                    {"Name": "tag:Project", "Values": [project_tag]},
                    {"Name": "status", "Values": ["available"]},
                ]
            ).get("Volumes", [])
            for vol in volumes:
                vid = str(vol.get("VolumeId") or "")
                if not vid:
                    continue
                try:
                    ec2.delete_volume(VolumeId=vid)
                    details["volumes_deleted"].append(vid)
                except Exception as exc:
                    details["errors"].append(f"EBS {vid}: {exc}")
        except Exception as exc:
            details["errors"].append(f"EBS listing: {exc}")

        # 4) Delete project S3 buckets (force delete objects first).
        try:
            buckets = s3.list_buckets().get("Buckets", []) or []
            for bucket in buckets:
                bname = str(bucket.get("Name") or "")
                if not bname:
                    continue
                try:
                    tagging = s3.get_bucket_tagging(Bucket=bname)
                    tags = {str(t.get("Key")): str(t.get("Value")) for t in (tagging.get("TagSet") or []) if t.get("Key")}
                    if tags.get("Project") != project_tag:
                        continue
                    paginator = s3.get_paginator("list_object_versions")
                    for page in paginator.paginate(Bucket=bname):
                        to_delete = []
                        for item in (page.get("Versions") or []):
                            to_delete.append({"Key": item["Key"], "VersionId": item["VersionId"]})
                        for item in (page.get("DeleteMarkers") or []):
                            to_delete.append({"Key": item["Key"], "VersionId": item["VersionId"]})
                        if to_delete:
                            s3.delete_objects(Bucket=bname, Delete={"Objects": to_delete, "Quiet": True})
                    # For non-versioned leftovers:
                    listed = s3.list_objects_v2(Bucket=bname)
                    keys = [{"Key": o["Key"]} for o in (listed.get("Contents") or [])]
                    if keys:
                        s3.delete_objects(Bucket=bname, Delete={"Objects": keys, "Quiet": True})
                    s3.delete_bucket(Bucket=bname)
                    details["s3_buckets_deleted"].append(bname)
                except Exception:
                    continue
        except Exception as exc:
            details["errors"].append(f"S3 cleanup: {exc}")

        # 5) Delete project CloudFront distributions by tags.
        try:
            marker = None
            while True:
                kwargs = {"Marker": marker} if marker else {}
                resp = cloudfront.list_distributions(**kwargs)
                dist_list = (resp.get("DistributionList") or {})
                items = dist_list.get("Items") or []
                for dist in items:
                    dist_id = str(dist.get("Id") or "")
                    arn = str(dist.get("ARN") or "")
                    if not dist_id or not arn:
                        continue
                    try:
                        tag_resp = cloudfront.list_tags_for_resource(Resource=arn)
                        tags = {
                            str(t.get("Key")): str(t.get("Value"))
                            for t in (((tag_resp.get("Tags") or {}).get("Items")) or [])
                            if t.get("Key")
                        }
                        if tags.get("Project") != project_tag:
                            continue
                        cfg_resp = cloudfront.get_distribution_config(Id=dist_id)
                        etag = cfg_resp.get("ETag")
                        cfg = cfg_resp.get("DistributionConfig") or {}
                        enabled = bool(cfg.get("Enabled"))
                        status = str((cloudfront.get_distribution(Id=dist_id).get("Distribution") or {}).get("Status") or "")
                        if enabled:
                            cfg["Enabled"] = False
                            cloudfront.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=cfg)
                            details["cloudfront_pending_disable"].append(dist_id)
                            continue
                        if status.lower() != "deployed":
                            details["cloudfront_pending_disable"].append(dist_id)
                            continue
                        del_etag = cloudfront.get_distribution_config(Id=dist_id).get("ETag")
                        cloudfront.delete_distribution(Id=dist_id, IfMatch=del_etag)
                        details["cloudfront_deleted"].append(dist_id)
                    except Exception as exc:
                        details["errors"].append(f"CloudFront {dist_id}: {exc}")

                if not bool(dist_list.get("IsTruncated")):
                    break
                marker = dist_list.get("NextMarker")
        except Exception as exc:
            details["errors"].append(f"CloudFront cleanup: {exc}")

        # 6) Delete tagged security groups (after EC2 termination attempts).
        try:
            sgs = ec2.describe_security_groups(
                Filters=[{"Name": "tag:Project", "Values": [project_tag]}]
            ).get("SecurityGroups", [])
            for sg in sgs:
                sgid = str(sg.get("GroupId") or "")
                if not sgid:
                    continue
                try:
                    ec2.delete_security_group(GroupId=sgid)
                    details["security_groups_deleted"].append(sgid)
                except Exception as exc:
                    details["errors"].append(f"SG {sgid}: {exc}")
        except Exception as exc:
            details["errors"].append(f"SG listing: {exc}")

        return AwsDestroyResponse(success=True, details=details)
    except Exception as exc:
        return AwsDestroyResponse(success=False, error=str(exc))


@app.get("/health")
async def health_check():
    checks: list[dict] = []

    # Docker engine availability (required for scan/remediation/runtime-apply paths)
    try:
        import docker  # type: ignore

        docker_client = docker.from_env()
        docker_client.ping()
        checks.append({
            "name": "docker_engine",
            "state": "healthy",
            "detail": "Docker daemon reachable",
        })
    except Exception as exc:
        checks.append({
            "name": "docker_engine",
            "state": "down",
            "detail": str(exc),
        })

    # Neo4j availability (optional for remediation flow; KG can be skipped)
    neo4j_uri = os.environ.get("NEO4J_URI", "").strip()
    neo4j_user = os.environ.get("NEO4J_USER", "").strip()
    neo4j_password = os.environ.get("NEO4J_PASSWORD", "").strip()
    if not neo4j_uri:
        checks.append({
            "name": "neo4j",
            "state": "down",
            "detail": "NEO4J_URI is not configured",
        })
    else:
        try:
            from neo4j import GraphDatabase  # type: ignore

            driver = GraphDatabase.driver(
                neo4j_uri,
                auth=(neo4j_user, neo4j_password),
                connection_timeout=3,
            )
            try:
                driver.verify_connectivity()
            finally:
                driver.close()
            checks.append({
                "name": "neo4j",
                "state": "healthy",
                "detail": f"Connected to {neo4j_uri}",
            })
        except Exception as exc:
            checks.append({
                "name": "neo4j",
                "state": "down",
                "detail": str(exc),
            })

    has_down = any(c.get("state") == "down" for c in checks)
    has_degraded = any(c.get("state") == "degraded" for c in checks)
    status = "down" if has_down else ("degraded" if has_degraded else "healthy")
    return {"status": status, "checks": checks}

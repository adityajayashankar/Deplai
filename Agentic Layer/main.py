import asyncio
import base64
import hmac
import hashlib
import json
import logging
import os
import time
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
    TerraformGenRequest, TerraformGenResponse,
    TerraformApplyRequest, TerraformApplyResponse,
)
from environment import EnvironmentInitializer
from cleanup import cleanup_volumes, cleanup_project_reports
from result_parser import get_scan_results, get_scan_status, invalidate_cache
from remediation import RemediationRunner
from runner_base import RunnerBase
from architecture_gen import generate_architecture
from architecture_contract import ArchitectureContractError, parse_architecture_document
from cost_estimation import estimate_cost

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
        if project_id in active:
            active[project_id].cancel()
        active.pop(project_id, None)
        # Clean up context if workflow never started (e.g. client disconnected
        # before sending "start").  If run_workflow() ran, it already popped
        # the context in its own finally block — this is a no-op in that case.
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


@app.post("/api/terraform/generate", response_model=TerraformGenResponse, dependencies=[Depends(verify_api_key)])
async def terraform_generate(request: TerraformGenRequest):
    """
    Generate Terraform + Ansible IaC files from an architecture JSON.
    Attempts the RAG-agent pipeline first; falls back to security-aware templates.
    """
    from terraform_runner import generate_terraform

    loop = asyncio.get_running_loop()
    architecture_json = request.architecture_json.to_wire_dict()
    rag_result = await loop.run_in_executor(
        None,
        lambda: generate_terraform(
            architecture_json=architecture_json,
            provider=request.provider,
            project_name=request.project_name,
            openai_api_key=request.openai_api_key or "",
        ),
    )

    if rag_result and rag_result.get("success"):
        return TerraformGenResponse(
            success=True,
            provider=request.provider,
            project_name=request.project_name,
            files=rag_result.get("files"),
            readme=rag_result.get("readme"),
            source="rag_agent",
        )

    # RAG agent unavailable or failed — return indicator so Connector falls back
    return TerraformGenResponse(
        success=False,
        provider=request.provider,
        project_name=request.project_name,
        error="RAG agent unavailable — use template fallback",
        source="unavailable",
    )


@app.post("/api/terraform/apply", response_model=TerraformApplyResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply(request: TerraformApplyRequest):
    """Apply generated Terraform files to AWS using an ephemeral Docker volume."""
    from terraform_apply import apply_terraform_bundle

    loop = asyncio.get_running_loop()
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
        ),
    )

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


@app.get("/health")
async def health_check():
    return {"status": "healthy"}

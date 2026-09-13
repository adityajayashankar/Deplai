import asyncio
import base64
import hmac
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import time
import boto3
from typing import Any
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

# Allow importing root-level packages (e.g. remediation_pipeline) when this
# service is launched from the Agentic Layer directory.
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from functools import partial
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException, Depends
from service_auth import api_key_matches
from scan_jobs import ScanJobs
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from models import (
    ScanValidationRequest, ScanValidationResponse, public_scan_validation,
    WebSocketCommand, StreamStatus,
    RemediationRequest, RemediationResponse,
    ArchitectureGenRequest, ArchitectureGenResponse,
    CostEstimateRequest, CostEstimateResponse,
    Stage7ApprovalRequest, Stage7ApprovalResponse,
    TerraformGenRequest, TerraformGenResponse,
    TerraformConsultRequest, TerraformConsultResponse,
    InfraAdviseRequest, InfraAdviseResponse,
    TerraformApplyRequest, TerraformApplyResponse,
    TerraformApplyStopRequest, TerraformApplyStopResponse,
    TerraformApplyStatusRequest, TerraformApplyStatusResponse,
    TerraformPreflightRequest, TerraformPreflightResponse,
    BootstrapStatusRequest, BootstrapStatusResponse,
    AwsRuntimeDetailsRequest, AwsRuntimeDetailsResponse,
    AwsDestroyRequest, AwsDestroyResponse,
    AwsInstanceActionRequest, AwsInstanceActionResponse,
    AwsAppSecretsListRequest, AwsAppSecretsUpsertRequest, AwsAppSecretsDeleteRequest, AwsAppSecretsResponse,
)
try:
    from dast_agent.api import router as dast_router
except Exception as exc:
    dast_router = None
    logging.getLogger(__name__).warning("DAST routes disabled during startup: %s", exc)

from deploy_exec.api import router as deploy_exec_router
from environment import EnvironmentInitializer
from cleanup import cleanup_volumes, cleanup_project_reports
from result_parser import get_scan_results, get_scan_status, invalidate_cache
from remediation_pipeline.models import (
    RemediationNavigateRequest,
    RemediationPRRequest,
    RemediationRefreshRequest,
    RemediationRunRequest as PipelineRemediationRunRequest,
)
from remediation_pipeline.orchestrator import RemediationOrchestrator
from remediation_pipeline.remediation_store import remediation_runs
from remediation_pipeline.track_runner import RemediationTrackRunner
from runner_base import RunnerBase
from architecture_gen import generate_architecture
from architecture_contract import ArchitectureContractError, parse_architecture_document
from architecture_decision import complete_architecture_review, start_architecture_review
from aws_discovery import discover_aws_environment
from cost_estimation import estimate_cost
from deployment_planning_contract import (
    ArchitectureReviewCompleteRequest,
    ArchitectureReviewCompleteResponse,
    ArchitectureReviewStartRequest,
    ArchitectureReviewStartResponse,
    RepositoryAnalysisRequest,
    RepositoryAnalysisResponse,
    AwsDiscoveryRequest,
    AwsDiscoveryResponse,
)
from claude_deployment_pipeline import generate_terraform_bundle
from repository_analysis import run_repository_analysis
from stage7_bridge import run_stage7_approval_payload
from terraform_consult import run_terraform_consult
from infra_advisor import run_infra_advise
try:
    from utils import get_docker_client
except ImportError as exc:
    get_docker_client = None  # type: ignore[assignment]
    logging.getLogger(__name__).warning("Docker utilities disabled: %s", exc)

logger = logging.getLogger(__name__)

try:
    from routers.iac_apply import router as iac_router
except Exception as exc:
    iac_router = None
    logger.warning("IaC router disabled during startup: %s", exc)


def _project_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug


def _instance_name_tag(instance: dict[str, Any]) -> str:
    for tag in instance.get("Tags") or []:
        if not isinstance(tag, dict):
            continue
        if str(tag.get("Key") or "").strip() == "Name":
            return str(tag.get("Value") or "").strip()
    return ""


def _instance_matches_project(instance: dict[str, Any], project_name: str) -> bool:
    requested_slug = _project_slug(project_name)
    if not requested_slug:
        return False
    name_slug = _project_slug(_instance_name_tag(instance))
    if not name_slug:
        return False
    return name_slug == requested_slug or name_slug.startswith(f"{requested_slug}-")

_app_env = (os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
_enable_docs = _app_env in {"development", "dev", "local"}

app = FastAPI(
    title="DEPLAI Agentic Layer",
    description="Backend API for scan validation",
    version="1.0.0",
    docs_url="/docs" if _enable_docs else None,
    redoc_url="/redoc" if _enable_docs else None,
    openapi_url="/openapi.json" if _enable_docs else None,
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
    if not api_key_matches(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if iac_router is not None:
    app.include_router(iac_router, dependencies=[Depends(verify_api_key)])

if dast_router is not None:
    app.include_router(dast_router, dependencies=[Depends(verify_api_key)])
try:
    from deploy_agent_ec2_build import run_ec2_build_commands
except Exception:
    run_ec2_build_commands = None  # type: ignore

@app.post("/api/deploy/ec2/run-build")
def deploy_ec2_run_build(payload: dict, x_api_key: str = Header(default="")):
    if not verify_api_key(x_api_key):
        raise HTTPException(status_code=401, detail="invalid api key")
    if not run_ec2_build_commands:
        raise HTTPException(status_code=503, detail="SSM build agent not available")
    instance_id = str(payload.get("instance_id") or "").strip()
    region = str(payload.get("region") or "us-east-1").strip()
    credentials = payload.get("credentials") or {}
    build_command = str(payload.get("build_command") or "").strip()
    start_command = str(payload.get("start_command") or "").strip()
    project_slug = str(payload.get("project_slug") or "deplai-app").strip()
    if not instance_id:
        raise HTTPException(status_code=400, detail="instance_id required")
    if not (credentials.get("aws_access_key_id") and credentials.get("aws_secret_access_key")):
        raise HTTPException(status_code=400, detail="aws credentials required")
    try:
        return run_ec2_build_commands(instance_id, region, credentials, build_command, start_command, project_slug)
    except DeployError as exc:
        return {"ok": False, "error": exc.code, "details": exc.details}

app.include_router(deploy_exec_router, dependencies=[Depends(verify_api_key)])


_security_dispatch_task = None

@app.on_event("startup")
async def start_security_dispatcher():
    global _security_dispatch_task
    if os.getenv("SECURITY_SDLC_AUTOMATIC", "false").lower() != "true":
        return
    async def dispatch_loop():
        import httpx
        origin = os.getenv("CONNECTOR_URL", "http://connector:3000").rstrip("/")
        async with httpx.AsyncClient(timeout=55) as client:
            while True:
                try:
                    response = await client.post(origin + "/api/security/events/dispatch",
                        headers={"x-deplai-service-key": API_KEY})
                    response.raise_for_status()
                except Exception as exc:
                    logger.warning("Security event dispatcher failed: %s", type(exc).__name__)
                await asyncio.sleep(30)
    _security_dispatch_task = asyncio.create_task(dispatch_loop())

@app.on_event("shutdown")
async def stop_security_dispatcher():
    if _security_dispatch_task:
        _security_dispatch_task.cancel()
        await asyncio.gather(_security_dispatch_task, return_exceptions=True)

# Startup event handler
@app.on_event("startup")
async def on_startup():
    """Initialize services and clean up stale resources on startup."""
    try:
        from terraform_agent.agent.executor import cleanup_old_workspaces
    except Exception as exc:
        logger.warning("Skipping IaC workspace cleanup during startup: %s", exc)
        return

    # Clean up stale IaC workspaces from previous runs
    deleted = await cleanup_old_workspaces()
    if deleted:
        print(f"[startup] Cleaned up {deleted} stale IaC workspace(s)")


# In-memory stores
active_scans: dict[str, EnvironmentInitializer] = {}
scan_contexts: dict[str, ScanValidationRequest] = {}
scan_jobs = ScanJobs()
active_remediations: dict[str, RemediationTrackRunner] = {}
remediation_start_locks: dict[str, asyncio.Lock] = {}
remediation_contexts: dict[str, RemediationRequest] = {}
# Pipeline monitor subscribers per project (shared websocket bus for dashboard events)
pipeline_subscribers: dict[str, set[WebSocket]] = {}
pipeline_indices: dict[str, int] = {}
pipeline_lock = asyncio.Lock()
active_terraform_applies: dict[str, dict] = {}
terraform_apply_results: dict[str, dict] = {}
_terraform_apply_tasks: set[asyncio.Task[Any]] = set()
remediation_orchestrator = RemediationOrchestrator()


def _normalize_remediation_request(request: RemediationRequest) -> RemediationRequest:
    """Lock remediation to the authenticated platform OpenRouter route.

    The worker deliberately drops BYOK keys and model preferences so no legacy
    Groq/Claude/Ollama fallback can be reached from this boundary.
    """
    return request.model_copy(
        update={
            "llm_provider": "openrouter",
            "llm_api_key": None,
            "llm_model": request.llm_model if request.llm_model == "z-ai/glm-5.3-flash" else "openrouter/free",
            "llm_access_mode": "platform",
            "llm_credential_id": None,
            "remediation_scope": "major",
        }
    )


async def _broadcast_pipeline_event(project_id: str, msg_type: str, content: str, meta: dict[str, Any] | None = None) -> None:
    text = str(content or "").strip()
    if not text:
        return

    async with pipeline_lock:
        subscribers = list(pipeline_subscribers.get(project_id, set()))
        if not subscribers:
            return
        next_index = pipeline_indices.get(project_id, 0) + 1
        pipeline_indices[project_id] = next_index

    data = {
        "index": next_index,
        "total": 0,
        "type": msg_type or "info",
        "content": text,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if isinstance(meta, dict):
        for key, value in meta.items():
            if value is not None:
                data[key] = value

    payload = {
        "type": "message",
        "data": data,
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


def _bind_ai_gateway_context(request: Any) -> None:
    """Bind user/org for org-wallet metering on agent LLM calls."""
    try:
        from ai_gateway import bind_ai_context
        bind_ai_context(
            user_id=getattr(request, "user_id", None),
            organization_id=getattr(request, "organization_id", None),
        )
    except Exception:
        pass


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
    await websocket.accept()
    if API_KEY is not None:
        token = websocket.query_params.get("token")
        if not token or not _verify_ws_token(token, project_id):
            await websocket.send_json({
                "type": "status",
                "status": StreamStatus.error.value,
                "error": "Invalid or missing websocket token. Reopen the project and retry the scan.",
            })
            await websocket.close(code=1008, reason="Invalid or missing token")
            return
        # Extract the user identity claim so we can validate it against the
        # stored context later — prevents a valid token for user A being used
        # to drive a pipeline that belongs to user B.
        token_sub = _extract_ws_token_sub(token)

    logger.info("WebSocket connected path=%s project=%s", websocket.url.path, project_id)

    def _context_matches_token(context) -> bool:
        if token_sub is None:
            return True
        return str(getattr(context, "user_id", "")) == str(token_sub)

    async def _send_unauthorized() -> None:
        await websocket.send_json({
            "type": "status",
            "status": StreamStatus.error.value,
            "error": "Unauthorized",
        })
        await websocket.close(code=1008, reason="Unauthorized")

    async def run_workflow(runner: RunnerBase):
        remediation_run_id = str(getattr(runner, "remediation_run_id", "") or "")
        usage_settled = False

        async def settle_remediation_usage(outcome: str) -> None:
            nonlocal usage_settled
            if getattr(getattr(runner, "context", None), "resume_publication", False):
                return  # Publication recovery does not charge remediation again.
            if usage_settled or not remediation_run_id:
                return
            from product_usage import settle_product_usage

            context = getattr(runner, "context", None)
            try:
                result = await asyncio.to_thread(
                    settle_product_usage,
                    kind="remediation",
                    outcome=outcome,
                    organization_id=getattr(context, "organization_id", None),
                    user_id=getattr(context, "user_id", None),
                    project_id=getattr(runner, "original_project_id", None) or getattr(context, "project_id", None),
                    run_id=remediation_run_id,
                    usage=remediation_runs.usage_for_run(remediation_run_id),
                )
            except Exception as exc:
                result = {"ok": False, "error": f"Billing settlement unavailable: {type(exc).__name__}."}
            usage_settled = True
            if result.get("ok"):
                credits = float(result.get("credits") or 0)
                remediation_runs.append_event(
                    remediation_run_id,
                    project_id=str(getattr(runner, "original_project_id", "") or ""),
                    message_type="usage",
                    content=f"Usage settled: {credits:.2f} credit(s).",
                    stage="remediation",
                )
                return
            remediation_runs.append_event(
                remediation_run_id,
                project_id=str(getattr(runner, "original_project_id", "") or ""),
                message_type="warning",
                content=(
                    "Remediation completed" if outcome == "succeeded" else "Remediation failed"
                ) + ", but credit settlement is pending: " + str(result.get("error") or "billing unavailable."),
                stage="remediation",
            )

        try:
            success = await runner.run()
            if success:
                # Invoke completion hook before notifying the client, so that
                # any cache invalidation happens before the frontend re-fetches.
                if on_complete:
                    on_complete()
                remediation_runs.mark_status(remediation_run_id, "completed")
                await settle_remediation_usage("succeeded")
                # The runner may have been rebound to a reconnecting browser.
                # A notification failure must not overwrite completed work.
                await runner._send_status(StreamStatus.completed)
            else:
                remediation_runs.mark_status(remediation_run_id, "failed")
                await settle_remediation_usage("failed")
                # Pipeline returned False — error status was already sent by _terminate(),
                # but send it again as a safety net in case the pipeline exited a different way.
                await runner._send_status(StreamStatus.error)
        except asyncio.CancelledError:
            remediation_runs.mark_status(remediation_run_id, "cancelled")
            raise
        except WebSocketDisconnect:
            # The browser may leave after the server-side workflow succeeded.
            # Runner messaging is deliberately best-effort; keep its last state.
            pass
        except Exception as e:
            remediation_runs.mark_status(remediation_run_id, "failed")
            await settle_remediation_usage("failed")
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
                # Rebind reconnecting clients to active workflows instead of
                # restarting long runs and racing on shared volumes.
                if project_id in active:
                    old_runner = active[project_id]
                    if old_runner._task is not None and not old_runner._task.done():
                        active_context = (
                            contexts.get(project_id)
                            or getattr(old_runner, "context", None)
                            or getattr(old_runner, "scan_context", None)
                        )
                        if not _context_matches_token(active_context):
                            await _send_unauthorized()
                            return
                        old_runner.websocket = websocket
                        if getattr(old_runner, "_approval_requested", False):
                            current_status = StreamStatus.waiting_approval
                        elif getattr(old_runner, "_decision_requested", False):
                            current_status = StreamStatus.waiting_decision
                        else:
                            current_status = StreamStatus.running
                        await websocket.send_json({
                            "type": "status",
                            "status": current_status.value,
                        })
                        await old_runner._send_message(
                            "info",
                            "Reconnected to the active workflow without restarting it.",
                        )
                        continue
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
                    await _send_unauthorized()
                    return

                _bind_ai_gateway_context(context)

                runner = create_runner(websocket, project_id, context)
                active[project_id] = runner

                await websocket.send_json({
                    "type": "status",
                    "status": StreamStatus.running.value,
                })

                task = asyncio.create_task(run_workflow(runner))
                runner._task = task  # attach so cancel() can interrupt it
            else:
                runner = active.get(project_id)
                if runner is None:
                    await websocket.send_json({
                        "type": "status",
                        "status": StreamStatus.error.value,
                        "error": "No active workflow found for this project.",
                    })
                    continue
                if command.action == "cancel":
                    if not _context_matches_token(getattr(runner, "context", None)):
                        await _send_unauthorized()
                        return
                    runner.cancel()
                else:
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
        data=public_scan_validation(request),
    )


@app.post("/api/scan/start", response_model=ScanValidationResponse, dependencies=[Depends(verify_api_key)])
async def start_scan(request: ScanValidationRequest):
    _bind_ai_gateway_context(request)

    async def settle_scan_usage(success: bool, runner: Any, job: Any) -> None:
        from dast_scan import is_dast_only_run
        from product_usage import settle_product_usage

        try:
            result = await asyncio.to_thread(
                settle_product_usage,
                kind="security_scan",
                outcome="succeeded" if success else "failed",
                organization_id=request.organization_id,
                user_id=request.user_id,
                project_id=request.project_id,
                run_id=job.run_id,
                dast_only=is_dast_only_run(request.enabled_modules, request.dast_target_url),
            )
        except Exception as exc:
            result = {"ok": False, "error": f"Billing settlement unavailable: {type(exc).__name__}."}
        if result.get("ok"):
            credits = float(result.get("credits") or 0)
            if credits > 0:
                await job.send_json({
                    "type": "message",
                    "data": {
                        "type": "usage",
                        "content": f"Usage settled: {credits:.2f} credit(s) for this successful scan.",
                    },
                })
            return
        if not success:
            # Failed scans carry no product charge, so a billing outage is not
            # relevant to the scan outcome and must not be presented as one.
            return
        await job.send_json({
            "type": "message",
            "data": {
                "type": "warning",
                "content": "Scan completed, but its credit settlement is pending: " + str(result.get("error") or "billing unavailable."),
            },
        })

    try:
        job = scan_jobs.start(
            request.project_id, request.user_id,
            lambda progress: EnvironmentInitializer(progress, request),
            lambda: invalidate_cache(request.project_id),
            settle_scan_usage,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="Unauthorized")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    scan_contexts.pop(request.project_id, None)
    invalidate_cache(request.project_id)
    return ScanValidationResponse(success=True, message="Scan started", data={**public_scan_validation(request), "run_id": job.run_id})


@app.websocket("/ws/scan/{project_id}")
async def websocket_scan(websocket: WebSocket, project_id: str):
    await websocket.accept()
    token = websocket.query_params.get("token")
    if API_KEY is not None and (not token or not _verify_ws_token(token, project_id)):
        await websocket.close(code=1008, reason="Invalid or missing token")
        return
    subject = _extract_ws_token_sub(token) if API_KEY is not None else None
    job = None
    try:
        while True:
            command = WebSocketCommand(**json.loads(await websocket.receive_text()))
            if command.action != "start":
                continue
            job = scan_jobs.jobs.get(project_id)
            if job is None:
                snapshot = await scan_jobs.snapshot(project_id)
                if snapshot:
                    if subject is not None and str(snapshot["user_id"]) != str(subject):
                        await websocket.close(code=1008, reason="Unauthorized")
                        return
                    for event in snapshot["events"]:
                        await websocket.send_json(event)
                    await websocket.send_json({"type": "status", "status": snapshot["status"], "run_id": snapshot["run_id"]})
                    continue
            context = scan_contexts.get(project_id)
            owner = job.user_id if job else getattr(context, "user_id", None)
            if subject is not None and str(owner) != str(subject):
                await websocket.close(code=1008, reason="Unauthorized")
                return
            # Compatibility for older clients that still validate then send start.
            if context is not None and (job is None or job.status != "running"):
                await start_scan(context)
                job = scan_jobs.jobs.get(project_id)
            if job is None:
                await websocket.send_json({"type": "status", "status": "error",
                                           "error": "No scan found. Start a scan from the project."})
                continue
            await job.attach(websocket)
    except WebSocketDisconnect:
        pass
    finally:
        if job is not None:
            job.subscribers.discard(websocket)


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
    job = scan_jobs.jobs.get(project_id)
    snapshot = await scan_jobs.snapshot(project_id)
    if snapshot:
        state = snapshot["status"]
        if state in ("running", "error", "interrupted"):
            return {**snapshot, "status": "error" if state == "interrupted" else state,
                    "execution_status": state}
    if job and job.status == "error":
        return {"status": "error"}
    if (job and job.status == "running") or project_id in active_scans:
        return {"status": "running"}
    loop = asyncio.get_running_loop()
    status = await loop.run_in_executor(
        None, partial(get_scan_status, project_id)
    )
    return {"status": status, "run_id": snapshot["run_id"] if snapshot else None, "events": snapshot["events"] if snapshot else []}


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
    lock = remediation_start_locks.setdefault(request.project_id, asyncio.Lock())
    async with lock:
        return await _prepare_remediation_start(request)


async def _prepare_remediation_start(request: RemediationRequest):
    request = _normalize_remediation_request(request)
    saved_run_id = None
    if request.resume_publication:
        snapshot = remediation_runs.latest_for_project(request.project_id)
        run = (snapshot or {}).get("run", {})
        if (not run or str(run.get("user_id")) != str(request.user_id)
                or str(run.get("organization_id")) != str(request.organization_id)):
            raise HTTPException(status_code=404, detail="No saved remediation is available for this scope")
        if run.get("status") == "completed":
            raise HTTPException(status_code=409, detail="This run is already completed; view its saved result")
        saved_run_id = run["run_id"]
    # A new HTTP start is distinct from a WebSocket reconnect. Retire the old
    # worker before replacing its project context, or reconnect would attach
    # the new run's browser to the old run's pending review.
    previous = active_remediations.get(request.project_id)
    if previous is not None:
        previous_context = previous.context
        if (str(previous_context.user_id) != str(request.user_id)
                or str(previous_context.organization_id) != str(request.organization_id)):
            raise HTTPException(status_code=403, detail="Active remediation belongs to a different scope")
        previous.cancel()
        if previous._task is not None:
            try:
                await previous._task
            except asyncio.CancelledError:
                pass
        remediation_runs.mark_status(previous.remediation_run_id, "cancelled")
        if active_remediations.get(request.project_id) is previous:
            active_remediations.pop(request.project_id, None)
    _bind_ai_gateway_context(request)
    run_id = saved_run_id or remediation_runs.begin_run(
        project_id=request.project_id,
        user_id=request.user_id,
        organization_id=request.organization_id,
        scope=request.remediation_scope,
    )
    request = request.model_copy(update={"remediation_run_id": run_id})
    logger.info(
        "Remediation request: project=%s type=%s user=%s",
        request.project_id, request.project_type, request.user_id,
    )
    remediation_contexts[request.project_id] = request
    return RemediationResponse(
        success=True,
        message="Remediation request accepted",
        run_id=run_id,
    )


@app.get("/api/remediate/runs/{project_id}", dependencies=[Depends(verify_api_key)])
async def remediation_run_status(project_id: str):
    """Return redacted status/events so clients can recover after a WS disconnect."""
    status = remediation_runs.latest_for_project(project_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No remediation run was found for this project.")
    return status


@app.get("/api/remediate/archive/{run_id}", dependencies=[Depends(verify_api_key)])
def remediation_archive(run_id: str, project_id: str, user_id: str, organization_id: str):
    archive = remediation_runs.archive_for_run(run_id, project_id=project_id, user_id=user_id, organization_id=organization_id)
    if archive is None:
        raise HTTPException(status_code=404, detail="Remediation archive not found")
    return archive


@app.websocket("/ws/remediate/{project_id}")
async def websocket_remediate(websocket: WebSocket, project_id: str):
    """WebSocket endpoint for streaming remediation progress."""
    await _handle_websocket(
        websocket, project_id,
        create_runner=lambda ws, pid, ctx: RemediationTrackRunner(ws, ctx, remediation_orchestrator),
        contexts=remediation_contexts,
        active=active_remediations,
        missing_context_msg="No remediation context found. Please validate first.",
        # Invalidate cache after the remediation re-scan writes new volume files,
        # so the first frontend fetch after 'completed' always reads fresh data.
        on_complete=lambda: invalidate_cache(project_id),
    )


@app.post("/remediation/run", dependencies=[Depends(verify_api_key)])
async def remediation_run(request: PipelineRemediationRunRequest):
    """Run the remediation pipeline and stream each Fix as SSE."""

    async def event_stream():
        queue: asyncio.Queue[dict] = asyncio.Queue()
        done = asyncio.Event()

        def on_fix(fix):
            queue.put_nowait(fix.model_dump())

        async def worker():
            try:
                fixes = await remediation_orchestrator.run(request.project_id, on_fix=on_fix)
                queue.put_nowait({"type": "summary", "fixes": len(fixes)})
            except Exception as exc:
                queue.put_nowait({"type": "error", "error": str(exc)})
            finally:
                done.set()

        task = asyncio.create_task(worker())
        try:
            while not done.is_set() or not queue.empty():
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                yield f"data: {json.dumps(payload)}\n\n"
        finally:
            await task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/remediation/status", dependencies=[Depends(verify_api_key)])
async def remediation_status():
    """Return current quota/counter status for remediation providers."""
    return remediation_orchestrator.status().model_dump()


@app.post("/remediation/pr", dependencies=[Depends(verify_api_key)])
async def remediation_pr(request: RemediationPRRequest):
    """Create a GitHub PR from accepted remediation diffs."""
    result = remediation_orchestrator.create_pr(request)
    return result.model_dump()


@app.post("/remediation/refresh", dependencies=[Depends(verify_api_key)])
async def remediation_refresh(request: RemediationRefreshRequest):
    """Re-read scanner artifacts and return normalized vulnerability totals."""
    return remediation_orchestrator.refresh(request.project_id)


@app.post("/remediation/navigate", dependencies=[Depends(verify_api_key)])
async def remediation_navigate(request: RemediationNavigateRequest):
    """Expose track navigation intent for orchestration clients."""
    return {"success": True, "track": request.track}


@app.websocket("/ws/pipeline/{project_id}")
async def websocket_pipeline(websocket: WebSocket, project_id: str):
    """Project-scoped websocket bus for dashboard pipeline monitor events."""
    await websocket.accept()
    if API_KEY is not None:
        token = websocket.query_params.get("token")
        if not token or not _verify_ws_token(token, project_id):
            await websocket.send_json({
                "type": "status",
                "status": StreamStatus.error.value,
                "error": "Invalid or missing websocket token.",
            })
            await websocket.close(code=1008, reason="Invalid or missing token")
            return

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
    _bind_ai_gateway_context(request)
    loop = asyncio.get_running_loop()
    try:
        review = await asyncio.to_thread(
            lambda: start_architecture_review(
                project_id=request.project_id,
                project_name=request.project_name,
                project_type=request.project_type,
                workspace=request.workspace,
                user_id=request.user_id,
                repo_full_name=request.repo_full_name,
                environment=request.environment,
                use_glm=True,
                answers=request.answers,
                conversation=request.conversation,
            ),
        )
    except Exception as exc:
        logger.exception("Architecture review start failed")
        return ArchitectureReviewStartResponse(success=False, workspace=request.workspace, error=str(exc))
    return ArchitectureReviewStartResponse(success=True, workspace=request.workspace, review=review)


@app.post("/api/architecture/review/complete", response_model=ArchitectureReviewCompleteResponse, dependencies=[Depends(verify_api_key)])
async def architecture_review_complete(request: ArchitectureReviewCompleteRequest):
    _bind_ai_gateway_context(request)
    loop = asyncio.get_running_loop()
    try:
        answers_json, deployment_profile, architecture_view, approval_payload, runtime_paths = await asyncio.to_thread(
            lambda: complete_architecture_review(
                project_id=request.project_id,
                project_name=request.project_name,
                project_type=request.project_type,
                workspace=request.workspace,
                answers=request.answers,
                user_id=request.user_id,
                repo_full_name=request.repo_full_name,
                aws_context=request.aws_context,
                use_glm=True,
                conversation=request.conversation,
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


@app.post("/api/architecture/aws-discovery", response_model=AwsDiscoveryResponse, dependencies=[Depends(verify_api_key)])
async def architecture_aws_discovery(request: AwsDiscoveryRequest):
    """Inspect AWS metadata with one-time credentials; never persist or echo credentials."""
    loop = asyncio.get_running_loop()
    try:
        context = await loop.run_in_executor(
            None,
            lambda: discover_aws_environment(
                aws_access_key_id=request.aws_access_key_id,
                aws_secret_access_key=request.aws_secret_access_key,
                aws_session_token=request.aws_session_token,
                region=request.aws_region,
            ),
        )
    except Exception as exc:
        logger.warning("AWS architecture discovery failed: %s", type(exc).__name__)
        return AwsDiscoveryResponse(success=False, error="AWS discovery failed. Verify the credentials, region, and read-only permissions.")
    return AwsDiscoveryResponse(success=True, context=context)


@app.post("/api/architecture/generate", response_model=ArchitectureGenResponse, dependencies=[Depends(verify_api_key)])
async def architecture_generate(request: ArchitectureGenRequest):
    """Generate architecture JSON from a natural language prompt."""
    _bind_ai_gateway_context(request)
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
    _bind_ai_gateway_context(request)
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


@app.post("/api/terraform/consult", response_model=TerraformConsultResponse, dependencies=[Depends(verify_api_key)])
async def terraform_consult(request: TerraformConsultRequest):
    """Intake-aware infrastructure consultant for the deploy chat vertical slice."""
    _bind_ai_gateway_context(request)
    try:
        result = await asyncio.to_thread(
            run_terraform_consult,
            architecture_json=dict(request.architecture_json or {}),
            repository_context=dict(request.repository_context or {}) if request.repository_context else None,
            deployment_profile=dict(request.deployment_profile or {}) if request.deployment_profile else None,
            detected=dict(request.detected or {}) if request.detected else None,
            aws_region=request.aws_region or "eu-north-1",
            conversation_history=list(request.conversation_history or []),
            turn_count=int(request.turn_count or 0),
            force_decision=bool(request.force_decision),
            workspace=request.workspace,
            project_id=request.project_id,
            project_name=request.project_name,
            user_answers=dict(request.user_answers or {}) if request.user_answers else None,
            prior_decision=dict(request.prior_decision or {}) if request.prior_decision else None,
            llm_provider=request.llm_provider,
            llm_api_key=request.llm_api_key,
            llm_model=request.llm_model,
            llm_api_base_url=request.llm_api_base_url,
        )
        return TerraformConsultResponse(**result)
    except Exception as exc:
        logger.exception("terraform consult failed")
        return TerraformConsultResponse(
            success=False,
            error=str(exc),
            ready=False,
            turn_count=int(request.turn_count or 0),
        )


@app.post("/api/infra/advise", response_model=InfraAdviseResponse, dependencies=[Depends(verify_api_key)])
async def infra_advise(request: InfraAdviseRequest):
    """LangGraph beginner infra advisor: project + budget aware interactive planning."""
    _bind_ai_gateway_context(request)
    try:
        result = await asyncio.to_thread(
            run_infra_advise,
            architecture_json=dict(request.architecture_json or {}),
            repository_context=dict(request.repository_context or {}) if request.repository_context else None,
            deployment_profile=dict(request.deployment_profile or {}) if request.deployment_profile else None,
            detected=dict(request.detected or {}) if request.detected else None,
            aws_region=request.aws_region or "eu-north-1",
            conversation_history=list(request.conversation_history or []),
            turn_count=int(request.turn_count or 0),
            force_decision=bool(request.force_decision),
            workspace=request.workspace,
            project_id=request.project_id,
            project_name=request.project_name,
            user_answers=dict(request.user_answers or {}) if request.user_answers else None,
            prior_decision=dict(request.prior_decision or {}) if request.prior_decision else None,
            budget_cap_usd=request.budget_cap_usd,
            selected_tier=request.selected_tier,
            requirements=dict(request.requirements or {}) if request.requirements else None,
            llm_provider=request.llm_provider,
            llm_api_key=request.llm_api_key,
            llm_model=request.llm_model,
            llm_api_base_url=request.llm_api_base_url,
        )
        return InfraAdviseResponse(**result)
    except Exception as exc:
        logger.exception("infra advise failed")
        return InfraAdviseResponse(success=False, error=str(exc), ready=False, turn_count=int(request.turn_count or 0))


@app.post("/api/terraform/generate", response_model=TerraformGenResponse, dependencies=[Depends(verify_api_key)])
async def terraform_generate(request: TerraformGenRequest):
    """Generate Terraform IaC files from a Claude-derived deployment profile."""
    _bind_ai_gateway_context(request)
    loop = asyncio.get_running_loop()
    architecture_json = dict(request.architecture_json or {})
    repository_context_json = dict(request.repository_context or {})
    project_id = str(request.project_id or "").strip()

    def progress_callback(event: dict[str, Any]) -> None:
        if not project_id:
            return
        logger.info("terraform generate progress [%s]: %s", project_id, event)

    # Terraform generation logs stay on the server; the dashboard shows status via HTTP only.
    try:
        agent_result = await loop.run_in_executor(
            None,
            lambda: generate_terraform_bundle(
                architecture_json=architecture_json,
                project_name=request.project_name,
                workspace=request.workspace,
                aws_region=request.aws_region,
                state_bucket=request.state_bucket,
                lock_table=request.lock_table,
                iac_mode=request.iac_mode,
                qa_summary=request.qa_summary or "",
                website_index_html=request.website_index_html or "",
                repository_context_json=repository_context_json,
                deployment_profile_json=dict(request.deployment_profile or {}),
                approval_payload_json=dict(request.approval_payload or {}),
                security_context_json=dict(request.security_context or {}),
                website_asset_stats_json=dict(request.website_asset_stats or {}),
                frontend_entrypoint_detection_json=dict(request.frontend_entrypoint_detection or {}),
                detected_json=dict(request.detected or {}),
                user_answers_json=dict(request.user_answers or {}),
                consultant_decision_json=dict(request.consultant_decision or {}),
                source_root=request.source_root or "",
                source_root_candidates=list(request.source_root_candidates or []),
                repository_url=request.repository_url or "",
                source_metadata_json=dict(request.source_metadata or {}),
                llm_provider=request.llm_provider,
                llm_api_key=request.llm_api_key,
                llm_model=request.llm_model,
                llm_api_base_url=request.llm_api_base_url,
                terraform_renderer=request.terraform_renderer,
                user_id=request.user_id,
                progress_callback=progress_callback,
            ),
        )
    except Exception as exc:
        logger.exception("terraform generate failed for project %s", project_id)
        return TerraformGenResponse(
            success=False,
            provider=request.provider,
            project_name=request.project_name,
            error=str(exc),
            source="unavailable",
        )

    if agent_result and agent_result.get("success"):
        if project_id:
            logger.info("terraform generate completed for project %s", project_id)
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
            requested_renderer=agent_result.get("requested_renderer"),
            actual_renderer=agent_result.get("actual_renderer"),
            unsupported_reason=agent_result.get("unsupported_reason"),
            renderer=agent_result.get("renderer"),
            component_catalog_version=agent_result.get("component_catalog_version"),
            execution_kind=agent_result.get("execution_kind"),
            llm_iac_calls=agent_result.get("llm_iac_calls"),
            llm_iac_disabled=agent_result.get("llm_iac_disabled"),
            decision_applied=agent_result.get("decision_applied"),
            decision_drift=agent_result.get("decision_drift"),
            deployment_package_id=agent_result.get("deployment_package_id"),
            details=agent_result.get("details"),
        )

    error_message = "Terraform agent unavailable."
    if isinstance(agent_result, dict):
        error_message = str(agent_result.get("error") or error_message)
    if project_id:
        logger.error("terraform generate failed for project %s: %s", project_id, error_message)
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
        requested_renderer=agent_result.get("requested_renderer") if isinstance(agent_result, dict) else None,
        actual_renderer=agent_result.get("actual_renderer") if isinstance(agent_result, dict) else None,
        unsupported_reason=agent_result.get("unsupported_reason") if isinstance(agent_result, dict) else None,
        renderer=agent_result.get("renderer") if isinstance(agent_result, dict) else None,
        component_catalog_version=agent_result.get("component_catalog_version") if isinstance(agent_result, dict) else None,
        execution_kind=agent_result.get("execution_kind") if isinstance(agent_result, dict) else None,
        llm_iac_calls=agent_result.get("llm_iac_calls") if isinstance(agent_result, dict) else None,
        llm_iac_disabled=agent_result.get("llm_iac_disabled") if isinstance(agent_result, dict) else None,
        decision_applied=agent_result.get("decision_applied") if isinstance(agent_result, dict) else None,
        decision_drift=agent_result.get("decision_drift") if isinstance(agent_result, dict) else None,
        deployment_package_id=agent_result.get("deployment_package_id") if isinstance(agent_result, dict) else None,
        details=agent_result.get("details") if isinstance(agent_result, dict) else None,
    )


def _terraform_apply_key(project_id: str | None, project_name: str | None) -> str:
    return (str(project_id or "").strip() or str(project_name or "").strip())


def _record_terraform_apply_result(
    apply_key: str,
    request: TerraformApplyRequest,
    result: dict[str, Any] | None,
    apply_ctx: dict[str, Any] | None = None,
) -> None:
    if result is None:
        return
    details = result.get("details")
    if not isinstance(details, dict):
        details = {}
    apply_logs = apply_ctx.get("apply_logs") if isinstance(apply_ctx, dict) else None
    if isinstance(apply_logs, list):
        # Keep the authoritative bounded scanner/Terraform output available
        # after the active worker record has been removed.
        details["apply_logs"] = [str(line) for line in apply_logs[-400:] if str(line).strip()]
    if request.deployment_metadata:
        details["deployment_metadata"] = dict(request.deployment_metadata)
    if details:
        result["details"] = details
    result_status = str(result.get("status") or "").strip()
    terraform_apply_results[apply_key] = {
        "status": result_status if result_status == "awaiting_plan_confirmation" else ("completed" if bool(result.get("success")) else "error"),
        "result": result,
    }


def _run_runtime_terraform_apply_sync(request: TerraformApplyRequest, apply_ctx: dict[str, Any]) -> dict[str, Any]:
    from terraform_apply import apply_saved_terraform_run, apply_terraform_bundle

    request_files = [f for f in request.files if f is not None] if request.files else []
    if request.run_id and request.workspace and not request_files:
        return apply_saved_terraform_run(
            run_id=request.run_id or "",
            workspace=request.workspace or "",
            project_name=request.project_name,
            provider=request.provider,
            state_bucket=request.state_bucket or "",
            lock_table=request.lock_table or "",
            aws_access_key_id=request.aws_access_key_id or "",
            aws_secret_access_key=request.aws_secret_access_key or "",
            aws_session_token=request.aws_session_token or "",
            aws_region=request.aws_region or "eu-north-1",
            enforce_free_tier_ec2=request.enforce_free_tier_ec2 is not False,
            confirm_apply=request.confirm_plan_summary is True,
            apply_context=apply_ctx,
            database_required=request.database_required,
            customer_database_url=request.customer_database_url,
            customer_host=request.customer_host,
            customer_port=request.customer_port,
            customer_database_name=request.customer_database_name,
            customer_username=request.customer_username,
            customer_password=request.customer_password,
        )
    return apply_terraform_bundle(
        files=[{"path": f.path, "content": f.content, "encoding": f.encoding} for f in request_files],
        project_name=request.project_name,
        provider=request.provider,
        aws_access_key_id=request.aws_access_key_id or "",
        aws_secret_access_key=request.aws_secret_access_key or "",
        aws_session_token=request.aws_session_token or "",
        aws_region=request.aws_region or "eu-north-1",
        state_bucket=request.state_bucket or "",
        lock_table=request.lock_table or "",
        enforce_free_tier_ec2=request.enforce_free_tier_ec2 is not False,
        confirm_apply=request.confirm_plan_summary is True,
        apply_context=apply_ctx,
        database_required=request.database_required,
        customer_database_url=request.customer_database_url,
        customer_host=request.customer_host,
        customer_port=request.customer_port,
        customer_database_name=request.customer_database_name,
        customer_username=request.customer_username,
        customer_password=request.customer_password,
    )


async def _execute_runtime_terraform_apply(request: TerraformApplyRequest, apply_key: str, apply_ctx: dict[str, Any]) -> None:
    """Run Terraform apply off the HTTP request so RDS Multi-AZ (15–45 min) can finish after a client disconnect."""
    loop = asyncio.get_running_loop()

    def emit_apply_event(msg_type: str, content: str) -> None:
        """High-level deploy milestones for server logs only."""
        text = str(content or "").strip()
        if not text:
            return
        level = logging.ERROR if str(msg_type or "").strip().lower() == "error" else logging.INFO
        logger.log(level, "[terraform-apply][%s] %s", request.project_id, text)
        lowered = text.lower()
        if "started" in lowered:
            apply_ctx["phase"] = "starting"
            apply_ctx["phase_message"] = text
        elif "awaiting confirmation" in lowered:
            apply_ctx["phase"] = "awaiting_plan_confirmation"
            apply_ctx["phase_message"] = text
        elif "completed successfully" in lowered:
            apply_ctx["phase"] = "completed"
            apply_ctx["phase_message"] = text
        elif str(msg_type or "").strip().lower() == "error":
            apply_ctx["phase"] = "failed"
            apply_ctx["phase_message"] = text

    apply_ctx["emit"] = emit_apply_event
    result: dict[str, Any] | None = None
    try:
        emit_apply_event("info", "Terraform runtime apply started.")
        request_files = [f for f in request.files if f is not None] if request.files else []
        if request.run_id and request.workspace and not request_files:
            emit_apply_event("info", f"Reusing saved Terraform workspace '{request.workspace}'.")
        else:
            emit_apply_event("info", "Applying generated Terraform bundle.")
        result = await loop.run_in_executor(None, lambda: _run_runtime_terraform_apply_sync(request, apply_ctx))
    except Exception as exc:
        result = {"success": False, "error": f"Terraform apply runtime error: {exc}"}
    finally:
        active_terraform_applies.pop(apply_key, None)
        _record_terraform_apply_result(apply_key, request, result, apply_ctx)
        if result and result.get("status") == "awaiting_plan_confirmation":
            emit_apply_event("info", "Terraform plan is awaiting confirmation before apply.")
        elif result and result.get("success"):
            emit_apply_event("success", "Terraform runtime apply completed successfully.")
        elif result:
            emit_apply_event("error", str(result.get("error") or "Terraform runtime apply failed."))


@app.post("/api/terraform/apply", response_model=TerraformApplyResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply(request: TerraformApplyRequest):
    """Accept a runtime apply and run it in the background.

    Multi-AZ RDS often takes 15–25 minutes. Holding the HTTP request open until
    Terraform finishes causes Connector to see a dropped connection and treat a
    healthy apply as a failure. Status is polled via /api/terraform/apply/status.
    """
    apply_key = _terraform_apply_key(request.project_id, request.project_name)
    if not apply_key:
        apply_key = request.project_name

    if apply_key in active_terraform_applies:
        return TerraformApplyResponse(
            success=True,
            provider=request.provider,
            project_name=request.project_name,
            status="running",
            details={"apply_already_in_progress": True},
        )

    apply_ctx = {
        "cancel_requested": False,
        "container_id": None,
        "emit": None,
        "apply_logs": [],
        "deployment_metadata": dict(request.deployment_metadata or {}),
    }
    active_terraform_applies[apply_key] = apply_ctx
    terraform_apply_results[apply_key] = {"status": "running", "result": None}

    snapshot = request.model_copy(deep=True)
    task = asyncio.create_task(_execute_runtime_terraform_apply(snapshot, apply_key, apply_ctx))
    _terraform_apply_tasks.add(task)
    task.add_done_callback(_terraform_apply_tasks.discard)

    return TerraformApplyResponse(
        success=True,
        provider=request.provider,
        project_name=request.project_name,
        status="running",
        details={"accepted": True},
    )


@app.post("/api/terraform/apply/status", response_model=TerraformApplyStatusResponse, dependencies=[Depends(verify_api_key)])
async def terraform_apply_status(request: TerraformApplyStatusRequest):
    apply_key = _terraform_apply_key(request.project_id, request.project_name)
    if not apply_key:
        return TerraformApplyStatusResponse(success=False, error="project_id or project_name is required")

    if apply_key in active_terraform_applies:
        ctx = active_terraform_applies.get(apply_key) or {}
        apply_logs = ctx.get("apply_logs")
        return TerraformApplyStatusResponse(
            success=True,
            status="running",
            result={
                "container_id": ctx.get("container_id"),
                "phase": ctx.get("phase") or "starting",
                "phase_message": ctx.get("phase_message"),
                "logs": apply_logs[-150:] if isinstance(apply_logs, list) else [],
            },
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
    apply_key = _terraform_apply_key(request.project_id, request.project_name)
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
        if get_docker_client is None:
            return (False, "Docker SDK is not available in this runtime.")
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


@app.post("/api/terraform/preflight", response_model=TerraformPreflightResponse, dependencies=[Depends(verify_api_key)])
async def terraform_preflight(request: TerraformPreflightRequest):
    from database_preflight import run_database_preflight
    from terraform_apply import _collect_terraform_text

    terraform_text = str(request.terraform_text or "").strip()
    if not terraform_text and request.files:
        terraform_text = _collect_terraform_text(
            [{"path": item.path, "content": item.content, "encoding": item.encoding} for item in request.files]
        )
    result = run_database_preflight(
        terraform_text=terraform_text,
        database_required=bool(request.database_required),
        customer_database_url=request.customer_database_url,
        customer_host=request.customer_host,
        customer_port=request.customer_port,
        customer_database_name=request.customer_database_name,
        customer_username=request.customer_username,
        customer_password=request.customer_password,
    )
    ok = bool(result.get("ok"))
    return TerraformPreflightResponse(
        success=ok,
        stage=str(result.get("stage") or "static_preflight"),
        code=None if ok else str(result.get("code") or "INVALID_DATABASE_CONFIGURATION"),
        message=str(result.get("message") or ("Preflight passed." if ok else "Preflight failed.")),
        details=result,
    )


@app.post("/api/deploy/bootstrap-status", response_model=BootstrapStatusResponse, dependencies=[Depends(verify_api_key)])
async def deploy_bootstrap_status(request: BootstrapStatusRequest):
    from bootstrap_status import read_bootstrap_status_once, wait_for_bootstrap_status

    credentials = {
        "aws_access_key_id": request.aws_access_key_id,
        "aws_secret_access_key": request.aws_secret_access_key,
        "aws_session_token": request.aws_session_token or "",
        "aws_region": request.aws_region,
    }
    instance_id = str(request.instance_id or "").strip()
    if not instance_id:
        return BootstrapStatusResponse(
            success=False,
            error="instance_id is required",
            terraform_status="unknown",
            application_status="failed",
            verification_status="failed",
        )

    loop = asyncio.get_running_loop()
    if request.wait:
        payload = await loop.run_in_executor(
            None,
            lambda: wait_for_bootstrap_status(
                instance_id=instance_id,
                credentials=credentials,
                timeout_seconds=int(request.timeout_seconds),
                interval_seconds=int(request.interval_seconds),
            ),
        )
    else:
        payload = await loop.run_in_executor(
            None,
            lambda: read_bootstrap_status_once(instance_id=instance_id, credentials=credentials),
        )

    app_status = str(payload.get("status") or "unknown")
    bootstrap = payload.get("bootstrap_status") if isinstance(payload.get("bootstrap_status"), dict) else None
    ok = bool(payload.get("ok"))
    return BootstrapStatusResponse(
        success=ok,
        terraform_status="succeeded",
        application_status="succeeded" if ok else ("failed" if app_status == "failed" else "running"),
        bootstrap_status=bootstrap,
        verification_status="pending" if app_status == "running" else ("passed" if ok else "failed"),
        details={
            "reachable": payload.get("reachable"),
            "message": payload.get("message"),
        },
    )


@app.post("/api/aws/runtime-details", response_model=AwsRuntimeDetailsResponse, dependencies=[Depends(verify_api_key)])
async def aws_runtime_details(request: AwsRuntimeDetailsRequest):
    try:
        requested_project_name = str(request.project_name or "").strip()
        requested_instance_id = str(request.instance_id or "").strip()
        has_specific_target = bool(
            requested_instance_id
            or (requested_project_name and requested_project_name != "deplai-project")
        )

        session_kwargs = {
            "aws_access_key_id": request.aws_access_key_id,
            "aws_secret_access_key": request.aws_secret_access_key,
            "region_name": request.aws_region,
        }
        if request.aws_session_token:
            session_kwargs["aws_session_token"] = request.aws_session_token
        session = boto3.session.Session(**session_kwargs)
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
        if requested_project_name:
            try:
                tagged_res = ec2.describe_instances(
                    Filters=[
                        {"Name": "tag:Project", "Values": [requested_project_name]},
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

        name_matched_instances = []
        if requested_project_name:
            try:
                name_match_res = ec2.describe_instances(
                    Filters=[
                        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
                    ]
                )
                name_matched_instances = [
                    i
                    for r in name_match_res.get("Reservations", [])
                    for i in r.get("Instances", [])
                    if _instance_matches_project(i, requested_project_name)
                ]
                name_matched_instances.sort(
                    key=lambda item: str(item.get("LaunchTime") or ""),
                    reverse=True,
                )
            except Exception:
                name_matched_instances = []

        target_instance = None
        if requested_instance_id:
            try:
                by_id = ec2.describe_instances(InstanceIds=[requested_instance_id])
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
        if target_instance is None and name_matched_instances:
            target_instance = name_matched_instances[0]
        if target_instance is None and not has_specific_target and running_instances:
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
            "launch_time": None,
        }
        if target_instance:
            iid = str(target_instance.get("InstanceId") or "")
            launch_time_raw = target_instance.get("LaunchTime")
            launch_time_iso = None
            if launch_time_raw:
                try:
                    launch_time_iso = launch_time_raw.astimezone(timezone.utc).isoformat()
                except Exception:
                    launch_time_iso = str(launch_time_raw)
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
                "launch_time": launch_time_iso,
            }

        lookup_status = "ok" if target_instance else "not_found"
        if target_instance and requested_instance_id:
            lookup_status = "instance_id"
        elif target_instance and tagged_instances:
            lookup_status = "project_tag"
        elif target_instance and name_matched_instances:
            lookup_status = "name_tag"

        return AwsRuntimeDetailsResponse(
            success=True,
            details={
                "region": request.aws_region,
                "account_id": account_id or None,
                "lookup_status": lookup_status,
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


@app.post("/api/aws/app-secrets/list", response_model=AwsAppSecretsResponse, dependencies=[Depends(verify_api_key)])
async def aws_app_secrets_list(request: AwsAppSecretsListRequest):
    try:
        from app_secrets import list_app_secrets, normalize_secrets_prefix

        prefix = normalize_secrets_prefix(
            request.secrets_manager_prefix,
            project_name=request.project_name,
            environment=request.environment,
        )
        secrets = list_app_secrets(
            aws_access_key_id=request.aws_access_key_id,
            aws_secret_access_key=request.aws_secret_access_key,
            aws_session_token=request.aws_session_token,
            aws_region=request.aws_region,
            prefix=prefix,
        )
        return AwsAppSecretsResponse(success=True, prefix=prefix, secrets=secrets)
    except Exception as exc:
        return AwsAppSecretsResponse(success=False, error=str(exc))


@app.post("/api/aws/app-secrets/upsert", response_model=AwsAppSecretsResponse, dependencies=[Depends(verify_api_key)])
async def aws_app_secrets_upsert(request: AwsAppSecretsUpsertRequest):
    try:
        from app_secrets import normalize_secrets_prefix, upsert_app_secrets

        prefix = normalize_secrets_prefix(
            request.secrets_manager_prefix,
            project_name=request.project_name,
            environment=request.environment,
        )
        results = upsert_app_secrets(
            aws_access_key_id=request.aws_access_key_id,
            aws_secret_access_key=request.aws_secret_access_key,
            aws_session_token=request.aws_session_token,
            aws_region=request.aws_region,
            prefix=prefix,
            secrets=[{"key": item.key, "value": item.value} for item in request.secrets],
        )
        return AwsAppSecretsResponse(success=True, prefix=prefix, secrets=results)
    except Exception as exc:
        return AwsAppSecretsResponse(success=False, error=str(exc))


@app.post("/api/aws/app-secrets/delete", response_model=AwsAppSecretsResponse, dependencies=[Depends(verify_api_key)])
async def aws_app_secrets_delete(request: AwsAppSecretsDeleteRequest):
    try:
        from app_secrets import delete_app_secret, normalize_secrets_prefix

        prefix = normalize_secrets_prefix(
            request.secrets_manager_prefix,
            project_name=request.project_name,
            environment=request.environment,
        )
        result = delete_app_secret(
            aws_access_key_id=request.aws_access_key_id,
            aws_secret_access_key=request.aws_secret_access_key,
            aws_session_token=request.aws_session_token,
            aws_region=request.aws_region,
            prefix=prefix,
            key=request.key,
        )
        return AwsAppSecretsResponse(success=True, prefix=prefix, secrets=[result])
    except Exception as exc:
        return AwsAppSecretsResponse(success=False, error=str(exc))


@app.post("/api/aws/instance-action", response_model=AwsInstanceActionResponse, dependencies=[Depends(verify_api_key)])
async def aws_instance_action(request: AwsInstanceActionRequest):
    """Perform start/stop/reboot on a specific EC2 instance and return refreshed live details."""
    try:
        action = str(request.action or "").strip().lower()
        if action not in {"start", "stop", "reboot"}:
            return AwsInstanceActionResponse(success=False, error="action must be one of: start, stop, reboot")

        session_kwargs = {
            "aws_access_key_id": request.aws_access_key_id,
            "aws_secret_access_key": request.aws_secret_access_key,
            "region_name": request.aws_region,
        }
        if request.aws_session_token:
            session_kwargs["aws_session_token"] = request.aws_session_token
        session = boto3.session.Session(**session_kwargs)
        ec2 = session.client("ec2", region_name=request.aws_region)
        sts = session.client("sts", region_name=request.aws_region)
        account_id = str(sts.get_caller_identity().get("Account", ""))

        try:
            if action == "start":
                ec2.start_instances(InstanceIds=[request.instance_id])
            elif action == "stop":
                ec2.stop_instances(InstanceIds=[request.instance_id])
            else:
                ec2.reboot_instances(InstanceIds=[request.instance_id])
        except Exception as exc:
            message = str(exc or "")
            tolerated = (
                "IncorrectInstanceState" in message
                or "is not in a state from which it can be started" in message
                or "is not in a state from which it can be stopped" in message
            )
            if not tolerated:
                return AwsInstanceActionResponse(success=False, error=message or "Failed to execute instance action")

        response = ec2.describe_instances(InstanceIds=[request.instance_id])
        instances = [
            i
            for reservation in response.get("Reservations", [])
            for i in reservation.get("Instances", [])
        ]
        target = instances[0] if instances else None
        if not target:
            return AwsInstanceActionResponse(success=False, error="Instance not found after action execution")

        launch_time_raw = target.get("LaunchTime")
        launch_time_iso = None
        if launch_time_raw:
            try:
                launch_time_iso = launch_time_raw.astimezone(timezone.utc).isoformat()
            except Exception:
                launch_time_iso = str(launch_time_raw)

        iid = str(target.get("InstanceId") or request.instance_id)
        details = {
            "action": action,
            "region": request.aws_region,
            "account_id": account_id or None,
            "instance": {
                "instance_id": iid,
                "public_ipv4_address": str(target.get("PublicIpAddress") or "n/a"),
                "private_ipv4_address": str(target.get("PrivateIpAddress") or "n/a"),
                "instance_state": str((target.get("State") or {}).get("Name") or "n/a"),
                "instance_type": str(target.get("InstanceType") or "n/a"),
                "public_dns": str(target.get("PublicDnsName") or "n/a"),
                "private_dns": str(target.get("PrivateDnsName") or "n/a"),
                "vpc_id": str(target.get("VpcId") or "n/a"),
                "subnet_id": str(target.get("SubnetId") or "n/a"),
                "instance_arn": (
                    f"arn:aws:ec2:{request.aws_region}:{account_id}:instance/{iid}"
                    if iid and account_id
                    else "n/a"
                ),
                "launch_time": launch_time_iso,
            },
        }

        return AwsInstanceActionResponse(success=True, details=details)
    except Exception as exc:
        return AwsInstanceActionResponse(success=False, error=str(exc))


@app.post("/api/aws/destroy-runtime", response_model=AwsDestroyResponse, dependencies=[Depends(verify_api_key)])
async def aws_destroy_runtime(request: AwsDestroyRequest):
    """Best-effort runtime cleanup for DeplAI-managed AWS resources for a project."""
    try:
        session_kwargs = {
            "aws_access_key_id": request.aws_access_key_id,
            "aws_secret_access_key": request.aws_secret_access_key,
            "region_name": request.aws_region,
        }
        if request.aws_session_token:
            session_kwargs["aws_session_token"] = request.aws_session_token
        session = boto3.session.Session(**session_kwargs)
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


@app.get("/ready")
async def readiness_check():
    return {
        "status": "ready",
        "service": "agentic-layer",
    }


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

    has_down = any(c.get("state") == "down" for c in checks)
    has_degraded = any(c.get("state") == "degraded" for c in checks)
    status = "down" if has_down else ("degraded" if has_degraded else "healthy")
    return {"status": status, "checks": checks}

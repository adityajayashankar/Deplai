import asyncio

from fastapi import APIRouter, BackgroundTasks, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from terraform_agent.agent.iac_pipeline import (
    RunStatus,
    create_run,
    destroy_run,
    get_run,
    run_pipeline,
)

router = APIRouter(prefix="/api/iac", tags=["iac"])

# Maps run_id -> list of active WebSocket connections
# When a log line is emitted, it is sent to all connected clients for that run.
_ws_clients: dict[str, list[WebSocket]] = {}


class AWSCredentials(BaseModel):
    access_key_id: str
    secret_access_key: str
    region: str = "us-east-1"


class IaCGenerateRequest(BaseModel):
    project_id: str
    service_type: str
    repo_context: dict = {}
    user_customizations: dict = {}
    aws_credentials: AWSCredentials


class IaCGenerateResponse(BaseModel):
    run_id: str
    status: str


async def _broadcast(run_id: str, message: str) -> None:
    clients = _ws_clients.get(run_id, [])
    dead = []
    for ws in clients:
        try:
            await ws.send_json({"type": "log", "data": message})
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.remove(ws)


def _make_log_callback(run_id: str):
    def callback(rid: str, msg: str):
        asyncio.create_task(_broadcast(rid, msg))
    return callback


@router.post("/generate-and-apply", response_model=IaCGenerateResponse)
async def generate_and_apply(body: IaCGenerateRequest, background_tasks: BackgroundTasks):
    """
    Starts the IaC pipeline as a background task.
    Returns run_id immediately so the client can poll /status or open a WebSocket.
    """
    # Pre-create the run so the run_id is available before the background task starts
    run = create_run(body.project_id, body.service_type)

    creds = body.aws_credentials.model_dump()

    background_tasks.add_task(
        run_pipeline,
        project_id=body.project_id,
        service_type=body.service_type,
        repo_context=body.repo_context,
        user_customizations=body.user_customizations,
        aws_credentials=creds,
        aws_region=creds["region"],
        log_callback=_make_log_callback(run.run_id),
    )

    return IaCGenerateResponse(run_id=run.run_id, status=run.status)


@router.get("/status/{run_id}")
async def get_status(run_id: str):
    """
    Returns current run status, plan summary, outputs (if completed), and error (if failed).
    The Connector polls this at 3-second intervals while apply is in progress.
    """
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    response = {
        "run_id": run.run_id,
        "status": run.status,
        "plan_summary": run.plan_summary,
        "logs": run.apply_logs[-50:],
    }

    if run.status == RunStatus.COMPLETED:
        response["outputs"] = run.outputs
        if run.keypair:
            response["keypair"] = run.keypair

    if run.status == RunStatus.FAILED:
        response["error"] = run.error

    return response


@router.websocket("/ws/{run_id}")
async def apply_logs_ws(websocket: WebSocket, run_id: str):
    """
    Real-time log stream for a running apply.
    Sends JSON frames: { "type": "log"|"status"|"done", "data": "..." }
    Client connects immediately after receiving run_id from generate-and-apply.
    """
    await websocket.accept()

    if run_id not in _ws_clients:
        _ws_clients[run_id] = []
    _ws_clients[run_id].append(websocket)

    # Replay any logs already emitted before this client connected
    run = get_run(run_id)
    if run:
        for log_line in run.apply_logs:
            await websocket.send_json({"type": "log", "data": log_line})

    try:
        while True:
            # Check if the run has finished
            run = get_run(run_id)
            if run and run.status in (RunStatus.COMPLETED, RunStatus.FAILED):
                await websocket.send_json(
                    {
                        "type": "done",
                        "data": run.status,
                        "outputs": run.outputs if run.status == RunStatus.COMPLETED else None,
                        "keypair": run.keypair if run.status == RunStatus.COMPLETED else None,
                        "error": run.error,
                    }
                )
                break

            # Keep the connection alive while the run is in progress
            await asyncio.sleep(1)

    except WebSocketDisconnect:
        pass
    finally:
        if run_id in _ws_clients:
            _ws_clients[run_id] = [
                ws for ws in _ws_clients[run_id] if ws is not websocket
            ]


@router.delete("/run/{run_id}")
async def cleanup_run(run_id: str, aws_credentials: AWSCredentials):
    """
    Destroys the AWS resources provisioned by this run.
    Called when the user clicks 'Destroy resources' in the UI.
    """
    try:
        await destroy_run(run_id, aws_credentials.model_dump())
        return {"status": "destroyed", "run_id": run_id}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Destroy failed: {e}")

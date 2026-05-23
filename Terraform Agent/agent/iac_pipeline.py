import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Callable

if __package__:
    from .executor import destroy, get_outputs, plan, stream_apply
    from .output_parser import extract_keypair_details, format_apply_log_line, parse_outputs
    from .param_selector import select_params
    from .validator import IaCValidationError, validate_with_retry
else:
    from executor import destroy, get_outputs, plan, stream_apply
    from output_parser import extract_keypair_details, format_apply_log_line, parse_outputs
    from param_selector import select_params
    from validator import IaCValidationError, validate_with_retry


class RunStatus(str, Enum):
    PENDING = "pending"
    SELECTING_PARAMS = "selecting_params"
    VALIDATING = "validating"
    PLANNING = "planning"
    APPLYING = "applying"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class IaCRun:
    run_id: str
    project_id: str
    service_type: str
    status: RunStatus = RunStatus.PENDING
    params: dict = field(default_factory=dict)
    plan_summary: str = ""
    apply_logs: list[str] = field(default_factory=list)
    outputs: dict = field(default_factory=dict)
    keypair: dict | None = None
    error: str | None = None
    workspace_path: str | None = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    completed_at: str | None = None


# In-memory run store keyed by run_id.
# Replace with Redis-backed store for multi-worker / production deployments.
_RUNS: dict[str, IaCRun] = {}


def get_run(run_id: str) -> IaCRun | None:
    return _RUNS.get(run_id)


def create_run(project_id: str, service_type: str) -> IaCRun:
    run = IaCRun(
        run_id=str(uuid.uuid4()),
        project_id=project_id,
        service_type=service_type,
    )
    _RUNS[run.run_id] = run
    return run


def _find_pending_run(project_id: str, service_type: str) -> IaCRun | None:
    for run in _RUNS.values():
        if (
            run.project_id == project_id
            and run.service_type == service_type
            and run.status == RunStatus.PENDING
            and run.completed_at is None
        ):
            return run
    return None


async def run_pipeline(
    project_id: str,
    service_type: str,
    repo_context: dict,
    user_customizations: dict,
    aws_credentials: dict,
    aws_region: str,
    log_callback: Callable[[str, str], None] | None = None,
) -> IaCRun:
    """
    Full IaC pipeline. Chains all phases in order.

    log_callback(run_id, message) is called for each log line so the
    FastAPI WebSocket endpoint can forward lines to the browser in real time.

    Returns the completed IaCRun (or a FAILED one on error).
    """
    run = _find_pending_run(project_id, service_type) or create_run(project_id, service_type)

    def emit(msg: str) -> None:
        run.apply_logs.append(msg)
        if log_callback:
            log_callback(run.run_id, msg)

    try:
        # Phase 2: Select params
        run.status = RunStatus.SELECTING_PARAMS
        emit(f"[{service_type}] Selecting deployment parameters...")

        run.params = await select_params(
            service_type=service_type,
            repo_context=repo_context,
            user_customizations=user_customizations,
            aws_region=aws_region,
            project_id=project_id,
        )
        emit(f"[{service_type}] Parameters selected.")

        # Phase 3: Validate with retry
        run.status = RunStatus.VALIDATING
        emit(f"[{service_type}] Validating Terraform configuration...")

        workspace, final_params = await validate_with_retry(
            service_type=service_type,
            params=run.params,
            project_id=project_id,
            aws_credentials=aws_credentials,
        )
        run.params = final_params
        run.workspace_path = str(workspace)
        emit(f"[{service_type}] Validation passed.")

        # Phase 4a: Plan
        run.status = RunStatus.PLANNING
        emit(f"[{service_type}] Running terraform plan...")

        run.plan_summary = await plan(workspace, aws_credentials)
        emit(f"[{service_type}] {run.plan_summary}")

        # Phase 4b: Apply (streaming)
        run.status = RunStatus.APPLYING
        emit(f"[{service_type}] Starting terraform apply...")

        async for raw_line in stream_apply(workspace, aws_credentials, run.run_id):
            formatted = format_apply_log_line(raw_line)
            if formatted:
                emit(formatted)

        emit(f"[{service_type}] Apply complete.")

        # Phase 4c: Capture outputs
        raw_outputs = await get_outputs(workspace, aws_credentials)

        # Phase 5: Parse outputs
        run.outputs = parse_outputs(raw_outputs, service_type)

        # EC2 only: read and scrub the keypair PEM from disk
        if service_type == "ec2":
            run.keypair = extract_keypair_details(workspace)

        run.status = RunStatus.COMPLETED
        run.completed_at = datetime.now(timezone.utc).isoformat()
        emit(f"[{service_type}] Deployment complete.")

    except IaCValidationError as e:
        run.status = RunStatus.FAILED
        run.error = f"Validation failed after {e.attempts} retries: {'; '.join(e.last_errors)}"
        emit(f"ERROR: {run.error}")

    except Exception as e:
        run.status = RunStatus.FAILED
        run.error = str(e)
        emit(f"ERROR: {run.error}")

    return run


async def destroy_run(run_id: str, aws_credentials: dict) -> None:
    """
    Tears down the AWS resources for a completed run.
    Called by the DELETE /api/iac/run/{run_id} endpoint.
    """
    run = get_run(run_id)
    if not run:
        raise ValueError(f"Run {run_id} not found")
    if not run.workspace_path:
        raise ValueError(f"Run {run_id} has no workspace — cannot destroy")

    workspace = Path(run.workspace_path)
    await destroy(workspace, aws_credentials)
    run.status = RunStatus.FAILED
    run.error = "Destroyed by user request"

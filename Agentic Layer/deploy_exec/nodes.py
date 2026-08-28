"""Deterministic LangGraph nodes for EC2/Docker/ECR/SSM deployment."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError

from deploy_exec import artifacts, events, host, lock, rollback, secrets, snapshot, store
from deploy_exec.adapters.base import ExecutionAdapter
from deploy_exec.blueprint import DeploymentBlueprint, contract_to_blueprint, validate_blueprint
from deploy_exec.codes import result_class
from deploy_exec.contract import ArtifactRef, DeploymentContract
from deploy_exec.errors import DeployError
from deploy_exec.operations import get_operation, render_operation
from deploy_exec.resolve import validate_identity, validate_instance
from deploy_exec.retry import should_retry, sleep_backoff
from deploy_exec.state import DeployExecState
from deploy_exec.verification import check_http, poll

_RUNTIME: dict[str, dict[str, Any]] = {}
TERMINAL = {"FAILED", "CANCELLED", "COMPLETED", "ROLLED_BACK"}
_CHECKPOINT_KEYS = (
    "deployment_id",
    "project_id",
    "environment_id",
    "requested_by",
    "contract",
    "blueprint",
    "status",
    "stage",
    "dry_run",
    "application_started",
    "locked",
    "cancelled",
    "retry_count",
    "host_capabilities",
    "plan_preview",
    "error",
    "errors",
    "result_class",
    "public_endpoint",
    "observed_account_id",
    "observed_region",
    "completed_steps",
    "snapshot_hash",
    "previous_digest",
    "dast_triggered",
    "dast_context",
)


def bind_runtime(deployment_id: str, **kwargs: Any) -> None:
    _RUNTIME[str(deployment_id)] = dict(kwargs)


def unbind_runtime(deployment_id: str) -> None:
    _RUNTIME.pop(str(deployment_id), None)


def _rt(state: DeployExecState) -> dict[str, Any]:
    return _RUNTIME.get(str(state.get("deployment_id") or ""), {})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _adapter(state: DeployExecState) -> ExecutionAdapter:
    adapter = _rt(state).get("adapter")
    if adapter is None:
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="execution adapter is not bound")
    return adapter


def _sleep(state: DeployExecState, seconds: float) -> None:
    sleeper = _rt(state).get("sleeper")
    if sleeper is None:
        import time

        time.sleep(seconds)
        return
    sleeper(seconds)


def _snapshot_hash(state: DeployExecState) -> str:
    if state.get("snapshot_hash"):
        return str(state.get("snapshot_hash"))
    frozen = store.read_snapshot(str(state.get("deployment_id") or "")) or {}
    return str(frozen.get("blueprint_hash") or "")


def _emit(state: DeployExecState, name: str, extra: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    event = {
        "event": name,
        "status": state.get("status"),
        "stage": state.get("stage"),
        "snapshot_hash": _snapshot_hash(state),
        **(extra or {}),
    }
    store.append_event(str(state.get("deployment_id") or ""), event)
    rows = list(state.get("events") or [])
    rows.append(event)
    return rows


def _checkpoint(state: DeployExecState, name: str, extra: dict[str, Any] | None = None) -> None:
    payload = {key: state.get(key) for key in _CHECKPOINT_KEYS}
    payload["stage"] = name
    payload["result_class"] = result_class(
        str(state.get("status") or ""),
        str((state.get("error") or {}).get("code") or ""),
    )
    if extra:
        payload.update(extra)
    store.write_checkpoint(str(state.get("deployment_id") or ""), name, payload)
    crash_after = str(_rt(state).get("crash_after") or "")
    if crash_after and crash_after == name:
        raise KeyboardInterrupt(f"simulated crash after {name}")


def _halted(state: DeployExecState) -> bool:
    return str(state.get("status") or "") in TERMINAL or str(state.get("status") or "") == "ROLLING_BACK"


def _passthrough(state: DeployExecState) -> dict[str, Any]:
    return {"status": str(state.get("status") or ""), "dry_run": bool(state.get("dry_run"))}


def _already(state: DeployExecState, stage: str) -> bool:
    return stage in list(state.get("completed_steps") or [])


def _mark(state: DeployExecState, stage: str, update: dict[str, Any]) -> dict[str, Any]:
    steps = list(state.get("completed_steps") or [])
    if stage not in steps:
        steps.append(stage)
    update["completed_steps"] = steps
    return update


def _env_key(state: DeployExecState) -> str:
    blueprint = state.get("blueprint") or {}
    return f"{blueprint.get('project_id')}:{blueprint.get('environment_id')}"


def _heartbeat(state: DeployExecState) -> None:
    if state.get("dry_run") or not state.get("locked"):
        return
    lock.heartbeat(_env_key(state), str(state.get("deployment_id") or ""))


def _maybe_cancel(state: DeployExecState) -> dict[str, Any] | None:
    deployment_id = str(state.get("deployment_id") or "")
    if not store.is_cancelled(deployment_id) and not state.get("cancelled"):
        return None
    if str(state.get("status") or "") in {"ROLLING_BACK", "ROLLED_BACK", "COMPLETED"}:
        return None
    error = DeployError(code="CANCELLED")
    if state.get("application_started"):
        try:
            blueprint = _blueprint(state)
        except Exception:
            blueprint = None
        if blueprint is not None and rollback.should_rollback(blueprint, error, True):
            return _fail(state, error, rolling_back=True)
    update = {
        "status": "CANCELLED",
        "cancelled": True,
        "error": error.as_dict(),
        "result_class": "CANCELLED",
        "events": _emit({**state, "status": "CANCELLED"}, events.DEPLOYMENT_CANCELLED),
    }
    _checkpoint({**state, **update}, "cancelled")
    return update


def _fail(state: DeployExecState, error: DeployError, *, rolling_back: bool = False) -> dict[str, Any]:
    payload = error.as_dict()
    status = "ROLLING_BACK" if rolling_back else "FAILED"
    update: dict[str, Any] = {
        "status": status,
        "error": payload,
        "errors": list(state.get("errors") or []) + [error.user_message],
        "result_class": result_class(status if not rolling_back else "FAILED", error.code),
        "events": _emit({**state, "status": status}, events.DEPLOYMENT_FAILED, {"code": error.code}),
    }
    _checkpoint({**state, **update}, str(state.get("stage") or "failed"))
    return update


def _contract(state: DeployExecState) -> DeploymentContract:
    return DeploymentContract.model_validate(state.get("contract") or {})


def _blueprint(state: DeployExecState) -> DeploymentBlueprint:
    return DeploymentBlueprint.model_validate(state.get("blueprint") or {})


def _run_op(state: DeployExecState, name: str, inputs: dict[str, Any]) -> Any:
    _heartbeat(state)
    op = get_operation(name)
    commands = render_operation(name, inputs)
    adapter = _adapter(state)
    blueprint = _blueprint(state)
    deployment_id = str(state.get("deployment_id") or "")
    pending = store.read_pending_command(deployment_id)
    if pending and str(pending.get("operation") or "") == name:
        recon = getattr(adapter, "reconcile", None)
        if callable(recon):
            result = recon(pending)
            store.clear_pending_command(deployment_id)
            store.append_log(deployment_id, f"{name}: reconciled {str(result.stdout)[:500]}")
            if result.ok:
                return result
            raise DeployError(code="SSM_COMMAND_FAILED", technical_message=str(result.stderr or "reconcile failed")[:300])
    attempt = 0
    max_attempts = 3 if op.retryable else 1
    while True:
        attempt += 1
        if store.is_cancelled(deployment_id) or state.get("cancelled"):
            if str(state.get("status") or "") != "ROLLING_BACK":
                raise DeployError(code="CANCELLED")
        try:
            result = adapter.execute(
                blueprint.instance_id,
                commands,
                timeout_seconds=op.timeout_seconds,
                metadata={
                    "deployment_id": deployment_id,
                    "operation": name,
                    "attempt": attempt,
                    "snapshot_hash": _snapshot_hash(state),
                },
            )
            store.append_log(
                deployment_id,
                f"{name}: exit={result.exit_code} id={result.execution_id or (result.metadata or {}).get('command_id', '')} {result.stdout[:500]}",
            )
            return result
        except DeployError as exc:
            if should_retry(exc, attempt, max_attempts):
                _emit(state, "RETRY_STARTED", {"operation": name, "attempt": attempt, "code": exc.code})
                sleep_backoff(attempt, sleeper=lambda seconds: _sleep(state, seconds))
                continue
            raise


def _capture_previous(blueprint: DeploymentBlueprint, caps: dict[str, Any]) -> DeploymentBlueprint:
    if blueprint.previous_artifact is not None:
        return blueprint
    raw = str(caps.get("current_digest") or "")
    match = re.search(r"sha256:[a-f0-9]{64}", raw, re.I)
    running = str(caps.get("current_running") or "").strip().lower() in {"true", "1", "yes"}
    if not match or not running:
        return blueprint
    digest = match.group(0).lower()
    if digest == blueprint.artifact.digest.lower():
        return blueprint
    payload = blueprint.model_dump()
    payload["previous_artifact"] = ArtifactRef(
        artifact_id="host-previous",
        repository=blueprint.artifact.repository,
        image=blueprint.artifact.image,
        digest=digest,
        status="PROMOTED",
    ).model_dump()
    return DeploymentBlueprint.model_validate(payload)


def validate_contract(state: DeployExecState) -> dict[str, Any]:
    if _already(state, "validate_contract"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        contract = _contract(state)
        if not contract.metadata.deployment_id:
            dumped = contract.model_dump()
            dumped["metadata"]["deployment_id"] = str(state.get("deployment_id") or "")
            contract = DeploymentContract.model_validate(dumped)
        blueprint = contract_to_blueprint(contract)
        validate_blueprint(blueprint)
        frozen = snapshot.freeze(str(state.get("deployment_id") or ""), contract, blueprint)
        preview = blueprint.plan_preview()
        update = _mark(state, "validate_contract", {
            "status": "CONTRACT_VALIDATED",
            "stage": "validate_contract",
            "contract": contract.model_dump(),
            "blueprint": blueprint.model_dump(),
            "plan_preview": preview,
            "project_id": contract.metadata.project_id,
            "environment_id": contract.metadata.environment_id,
            "public_endpoint": blueprint.public_endpoint,
            "snapshot_hash": frozen.get("blueprint_hash"),
            "snapshot": frozen,
            "previous_digest": blueprint.previous_artifact.digest if blueprint.previous_artifact else "",
        })
        merged = {**state, **update}
        update["events"] = _emit(merged, events.BLUEPRINT_VALIDATED)
        _checkpoint(merged, "validate_contract", {"plan_preview": preview})
        return update
    except ValidationError as exc:
        return _fail(state, DeployError(code="CONTRACT_INVALID", technical_message=str(exc)[:400]))
    except DeployError as exc:
        return _fail(state, exc)


def validate_target(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or _already(state, "validate_target"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        contract = _contract(state)
        runtime = _rt(state)
        account = str(runtime.get("account_id") or state.get("observed_account_id") or contract.target.account_id)
        region = str(runtime.get("region") or state.get("observed_region") or contract.target.region)
        validate_identity(contract, account, region)
        instance = runtime.get("instance")
        if instance is None and runtime.get("describe_instance"):
            instance = runtime["describe_instance"](contract.target.instance_id)
        skip = bool(runtime.get("skip_tag_check"))
        if instance is not None or not skip:
            validate_instance(contract, instance, skip_tag_check=skip)
        update = _mark(state, "validate_target", {
            "status": "TARGET_VALIDATED",
            "stage": "validate_target",
            "observed_account_id": account,
            "observed_region": region,
        })
        merged = {**state, **update}
        update["events"] = _emit(merged, events.TARGET_VALIDATED)
        _checkpoint(merged, "validate_target")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def validate_artifact(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or _already(state, "validate_artifact"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        artifacts.validate_artifact(_blueprint(state).artifact)
        update = _mark(state, "validate_artifact", {"status": "ARTIFACT_VALIDATED", "stage": "validate_artifact"})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.ARTIFACT_VALIDATED)
        _checkpoint(merged, "validate_artifact")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def lock_env(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "lock_env"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        env_key = f"{blueprint.project_id}:{blueprint.environment_id}"
        lock.acquire(env_key, str(state.get("deployment_id") or ""))
        update = _mark(state, "lock_env", {"status": "LOCK_ACQUIRED", "stage": "lock_env", "locked": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.LOCK_ACQUIRED)
        _checkpoint(merged, "lock_env")
        return update
    except DeployError as extra:
        return _fail(state, extra)


def check_ssm(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or _already(state, "check_ssm"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        if not _adapter(state).ping(blueprint.instance_id):
            raise DeployError(code="SSM_OFFLINE", recommended_action="Confirm the instance profile includes AmazonSSMManagedInstanceCore and the agent is running.")
        update = _mark(state, "check_ssm", {"status": "HOST_CONNECTIVITY_CHECK", "stage": "check_ssm"})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.SSM_CONNECTIVITY_OK)
        _checkpoint(merged, "check_ssm")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def discover_host(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or _already(state, "discover_host"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        result = _run_op(state, "discover_host", {"container_name": blueprint.container_name})
        caps = host.parse_capabilities(result.stdout)
        captured = _capture_previous(blueprint, caps)
        previous = captured.previous_artifact.digest if captured.previous_artifact else ""
        update = _mark(state, "discover_host", {
            "status": "HOST_CONNECTIVITY_CHECK",
            "stage": "discover_host",
            "host_capabilities": caps,
            "blueprint": captured.model_dump(),
            "previous_digest": previous,
        })
        merged = {**state, **update}
        update["events"] = _emit(merged, events.HOST_DISCOVERY_COMPLETE, {"current_digest": caps.get("current_digest")})
        _checkpoint(merged, "discover_host", {"host_capabilities": caps})
        return update
    except DeployError as exc:
        return _fail(state, exc)


def host_ready(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or _already(state, "host_ready"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        report = host.evaluate_ready(state.get("host_capabilities") or {}, blueprint.network)
        prepared = False
        if not report.get("ready") and report.get("can_prepare") and not state.get("dry_run"):
            _emit({**state, "status": "HOST_PREPARATION", "stage": "host_ready"}, events.HOST_PREPARATION)
            _run_op(state, "prepare_runtime", {})
            rediscovered = _run_op(state, "discover_host", {"container_name": blueprint.container_name})
            caps = host.parse_capabilities(rediscovered.stdout)
            report = host.evaluate_ready(caps, blueprint.network)
            state = {**state, "host_capabilities": caps}  # type: ignore[assignment]
            prepared = True
        host.require_ready(report)
        if not report.get("ready"):
            raise DeployError(code="DOCKER_NOT_AVAILABLE", technical_message="; ".join(report.get("reasons") or []))
        status = "PREFLIGHT_PASSED" if state.get("dry_run") else "HOST_READY"
        update = _mark(state, "host_ready", {
            "status": status,
            "stage": "host_ready",
            "host_capabilities": state.get("host_capabilities") or {},
        })
        merged = {**state, **update}
        event_name = events.PREFLIGHT_PASSED if state.get("dry_run") else events.HOST_READY
        update["events"] = _emit(merged, event_name, {"prepared": prepared})
        _checkpoint(merged, "host_ready")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def resolve_configuration(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "resolve_configuration"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        contract = _contract(state)
        config = secrets.non_secret_config(contract)
        if config:
            _run_op(state, "render_runtime_configuration", {"env": config, "env_file": "/opt/deplai/app.env"})
        mapping = secrets.references_from_contract(contract)
        if mapping:
            try:
                _run_op(state, "resolve_secrets", {"secrets": mapping, "env_file": "/opt/deplai/app.env"})
            except DeployError as exc:
                if exc.code != "SECRET_RESOLUTION_FAILED":
                    raise DeployError(code="SECRET_RESOLUTION_FAILED", technical_message=exc.technical_message) from exc
                raise
        update = _mark(state, "resolve_configuration", {"status": "ARTIFACT_READY", "stage": "resolve_configuration"})
        _checkpoint({**state, **update}, "resolve_configuration")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def authenticate_registry(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "authenticate_registry"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        try:
            _run_op(state, "authenticate_registry", {"region": blueprint.region, "account_id": blueprint.account_id})
        except DeployError as exc:
            if exc.code in {"AWS_API_FAILURE", "IAM_PERMISSION_DENIED", "SSM_PERMISSION_DENIED", "SSM_COMMAND_FAILED"}:
                raise DeployError(code="ECR_AUTH_FAILED", technical_message=exc.technical_message) from exc
            raise
        update = _mark(state, "authenticate_registry", {"status": "ARTIFACT_READY", "stage": "authenticate_registry"})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.ECR_AUTHENTICATED)
        _checkpoint(merged, "authenticate_registry")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def pull_artifact(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "pull_artifact"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        _emit({**state, "stage": "pull_artifact"}, events.ARTIFACT_PULL_STARTED)
        try:
            _run_op(state, "pull_artifact", {"image": blueprint.artifact.image, "digest": blueprint.artifact.digest})
        except DeployError as exc:
            if exc.code in {"AWS_API_FAILURE", "TIMEOUT", "SSM_COMMAND_FAILED"}:
                raise DeployError(code="IMAGE_PULL_FAILED", technical_message=exc.technical_message) from exc
            raise
        inspected = _run_op(
            state,
            "inspect_digest",
            {"image": blueprint.artifact.image, "digest": blueprint.artifact.digest},
        )
        artifacts.assert_local_digest(blueprint.artifact.digest, inspected.stdout)
        update = _mark(state, "pull_artifact", {"status": "ARTIFACT_READY", "stage": "pull_artifact"})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.IMAGE_PULL_COMPLETE)
        _checkpoint(merged, "pull_artifact")
        return update
    except DeployError as exc:
        return _fail(state, exc)


def _started_fail(state: DeployExecState, error: DeployError) -> dict[str, Any]:
    blueprint = _blueprint(state)
    if rollback.should_rollback(blueprint, error, True):
        error.rollback_recommended = True
        return _fail(state, error, rolling_back=True)
    return _fail(state, error)


def stop_previous(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "stop_previous"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        _run_op(
            state,
            "stop_previous_version",
            {"container_name": blueprint.container_name, "host_port": blueprint.network.host_port},
        )
        update = _mark(state, "stop_previous", {"status": "APPLICATION_DEPLOYING", "stage": "stop_previous", "application_started": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.APPLICATION_STOPPED)
        _checkpoint(merged, "stop_previous")
        return update
    except DeployError as exc:
        return _started_fail({**state, "application_started": True}, exc)


def start_application(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "start_application"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        _emit({**state, "stage": "start_application"}, events.APPLICATION_STARTING)
        try:
            _run_op(
                state,
                "start_application",
                {
                    "container_name": blueprint.container_name,
                    "image": blueprint.artifact.image,
                    "digest": blueprint.artifact.digest,
                    "host_port": blueprint.network.host_port,
                    "container_port": blueprint.network.container_port,
                    "env_file": "/opt/deplai/app.env",
                },
            )
        except DeployError as exc:
            raise DeployError(code="APPLICATION_START_FAILED", technical_message=exc.technical_message, rollback_recommended=True) from exc
        update = _mark(state, "start_application", {"status": "APPLICATION_STARTED", "stage": "start_application", "application_started": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.APPLICATION_STARTED)
        _checkpoint(merged, "start_application")
        return update
    except DeployError as exc:
        return _started_fail({**state, "application_started": True}, exc)


def verify_runtime(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "verify_runtime"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        _run_op(state, "verify_container", {"container_name": blueprint.container_name})
        try:
            _run_op(state, "verify_port", {"host_port": blueprint.network.host_port})
        except DeployError:
            pass
        update = _mark(state, "verify_runtime", {"status": "RUNTIME_VERIFIED", "stage": "verify_runtime", "application_started": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.RUNTIME_VERIFIED)
        _checkpoint(merged, "verify_runtime")
        return update
    except DeployError as exc:
        return _started_fail(
            {**state, "application_started": True},
            DeployError(code="APPLICATION_START_FAILED", technical_message=exc.technical_message, rollback_recommended=True),
        )


def health_check(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "health_check"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        contract = _contract(state)
        _emit({**state, "stage": "health_check"}, events.HEALTH_CHECK_STARTED)

        def _once():
            result = _run_op(
                state,
                "health_check",
                {
                    "host_port": blueprint.network.host_port,
                    "health_endpoint": blueprint.health_endpoint,
                    "expected_status": contract.verification.expected_status,
                },
            )
            if not result.ok:
                raise DeployError(code="HEALTH_CHECK_FAILED", rollback_recommended=True)
            return result

        try:
            poll(
                _once,
                retries=contract.verification.retries,
                interval_seconds=contract.verification.interval_seconds if not _rt(state).get("fast") else 0,
                sleeper=lambda seconds: _sleep(state, seconds),
            )
        except DeployError as exc:
            raise DeployError(code="HEALTH_CHECK_FAILED", rollback_recommended=True, technical_message=exc.technical_message) from exc
        update = _mark(state, "health_check", {"status": "HEALTH_CHECK_PASSED", "stage": "health_check", "application_started": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.HEALTH_CHECK_PASSED)
        _checkpoint(merged, "health_check")
        return update
    except DeployError as extra:
        return _started_fail({**state, "application_started": True}, extra)


def external_endpoint(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "external_endpoint"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        url = str(blueprint.public_endpoint or "").strip()
        skipped = False
        if not url:
            skipped = True
        elif _rt(state).get("fail_external"):
            raise DeployError(code="EXTERNAL_ENDPOINT_FAILED", rollback_recommended=True)
        elif _rt(state).get("fast") or _rt(state).get("skip_external"):
            skipped = False
        else:
            contract = _contract(state)
            check_http(url, expected_status=int(contract.verification.expected_status or 200), timeout_seconds=5)
        update = _mark(state, "external_endpoint", {
            "status": "EXTERNAL_ENDPOINT_VERIFIED",
            "stage": "external_endpoint",
            "application_started": True,
        })
        merged = {**state, **update}
        update["events"] = _emit(merged, events.EXTERNAL_ENDPOINT_VERIFIED, {"skipped": skipped, "url": url})
        _checkpoint(merged, "external_endpoint")
        return update
    except DeployError as extra:
        return _started_fail({**state, "application_started": True}, extra)


def smoke_test(state: DeployExecState) -> dict[str, Any]:
    if _halted(state) or state.get("dry_run") or _already(state, "smoke_test"):
        return _passthrough(state)
    cancelled = _maybe_cancel(state)
    if cancelled:
        return cancelled
    try:
        blueprint = _blueprint(state)
        contract = _contract(state)
        _emit({**state, "stage": "smoke_test"}, events.SMOKE_TEST_STARTED)
        for path in blueprint.smoke_paths:
            _run_op(
                state,
                "smoke_test",
                {
                    "host_port": blueprint.network.host_port,
                    "path": path,
                    "expected_status": contract.verification.expected_status,
                },
            )
        update = _mark(state, "smoke_test", {"status": "SMOKE_TEST_PASSED", "stage": "smoke_test", "application_started": True})
        merged = {**state, **update}
        update["events"] = _emit(merged, events.SMOKE_TEST_PASSED)
        _checkpoint(merged, "smoke_test")
        return update
    except DeployError as extra:
        return _started_fail(
            {**state, "application_started": True},
            DeployError(code="SMOKE_TEST_FAILED", rollback_recommended=True, technical_message=extra.technical_message),
        )


def complete(state: DeployExecState) -> dict[str, Any]:
    if str(state.get("status") or "") in {"FAILED", "CANCELLED", "ROLLED_BACK", "ROLLING_BACK"}:
        return _passthrough(state)
    blueprint = _blueprint(state)
    if state.get("locked"):
        lock.release(f"{blueprint.project_id}:{blueprint.environment_id}", str(state.get("deployment_id") or ""))
    dast_context = None
    dast_started = False
    try:
        from deploy_exec import dast_hook

        contract = _contract(state)
        if dast_hook.should_trigger(blueprint.environment_id, contract.policy) and blueprint.public_endpoint:
            dast_context = dast_hook.context_payload(
                project_id=blueprint.project_id,
                deployment_id=str(state.get("deployment_id") or ""),
                environment_id=blueprint.environment_id,
                deployed_url=blueprint.public_endpoint,
                authorization=(contract.policy or {}).get("dast_authorization") if isinstance((contract.policy or {}).get("dast_authorization"), dict) else None,
            )
            if not state.get("dry_run") and not _rt(state).get("fast"):
                _emit({**state, "status": "DAST_STARTED"}, events.DAST_STARTED)
                dast_hook.maybe_start(dast_context)
                dast_started = True
    except Exception:
        dast_context = None
    update = {
        "status": "COMPLETED",
        "stage": "complete",
        "result_class": "SUCCESS",
        "locked": False,
        "dast_triggered": bool(dast_context),
        "dast_context": dast_context,
    }
    merged = {**state, **update}
    rows = _emit(merged, events.DEPLOYMENT_VERIFIED)
    rows = _emit({**merged, "events": rows}, events.DEPLOYMENT_COMPLETED, {"dast_started": dast_started})
    update["events"] = rows
    _checkpoint(merged, "complete", {"dast_context": dast_context})
    return update


def rollback_application(state: DeployExecState) -> dict[str, Any]:
    if str(state.get("status") or "") not in {"ROLLING_BACK", "FAILED"}:
        return _passthrough(state)
    try:
        blueprint = rollback.rollback_blueprint(_blueprint(state))
        _emit({**state, "status": "ROLLING_BACK"}, events.ROLLBACK_STARTED)
        _run_op(state, "pull_artifact", {"image": blueprint.artifact.image, "digest": blueprint.artifact.digest})
        inspected = _run_op(state, "inspect_digest", {"image": blueprint.artifact.image, "digest": blueprint.artifact.digest})
        artifacts.assert_local_digest(blueprint.artifact.digest, inspected.stdout)
        _run_op(
            state,
            "stop_previous_version",
            {"container_name": blueprint.container_name, "host_port": blueprint.network.host_port},
        )
        _run_op(
            state,
            "start_application",
            {
                "container_name": blueprint.container_name,
                "image": blueprint.artifact.image,
                "digest": blueprint.artifact.digest,
                "host_port": blueprint.network.host_port,
                "container_port": blueprint.network.container_port,
                "env_file": "/opt/deplai/app.env",
            },
        )
        health = _run_op(
            state,
            "health_check",
            {
                "host_port": blueprint.network.host_port,
                "health_endpoint": blueprint.health_endpoint,
                "expected_status": 200,
            },
        )
        if not health.ok:
            raise DeployError(code="ROLLBACK_FAILED", technical_message="rollback health check failed")
        if state.get("locked"):
            lock.release(f"{blueprint.project_id}:{blueprint.environment_id}", str(state.get("deployment_id") or ""))
        update = {
            "status": "ROLLED_BACK",
            "stage": "rollback",
            "result_class": "ROLLED_BACK",
            "blueprint": blueprint.model_dump(),
            "locked": False,
        }
        merged = {**state, **update}
        update["events"] = _emit(merged, events.ROLLBACK_COMPLETED)
        _checkpoint(merged, "rollback")
        return update
    except DeployError as extra:
        if state.get("locked"):
            blueprint = _blueprint(state)
            lock.release(f"{blueprint.project_id}:{blueprint.environment_id}", str(state.get("deployment_id") or ""))
        failed = DeployError(code="ROLLBACK_FAILED", technical_message=extra.technical_message)
        payload = _fail(state, failed)
        payload["events"] = _emit({**state, **payload, "status": "FAILED"}, events.ROLLBACK_FAILED, {"code": extra.code})
        payload["result_class"] = "ROLLBACK_FAILED"
        return payload


def fail_finalize(state: DeployExecState) -> dict[str, Any]:
    if state.get("locked"):
        blueprint = _blueprint(state) if state.get("blueprint") else None
        if blueprint:
            lock.release(f"{blueprint.project_id}:{blueprint.environment_id}", str(state.get("deployment_id") or ""))
    error = state.get("error") or {}
    status = str(state.get("status") or "FAILED")
    if status == "CANCELLED":
        klass = "CANCELLED"
    else:
        klass = result_class(status, str(error.get("code") or ""))
    update = {
        "status": status,
        "result_class": klass,
        "locked": False,
        "stage": "failed",
    }
    _checkpoint({**state, **update}, "failed")
    return update


def route_after(state: DeployExecState) -> str:
    status = str(state.get("status") or "")
    if status == "ROLLING_BACK":
        return "rollback"
    if status in {"FAILED", "CANCELLED"}:
        return "fail"
    if status in {"COMPLETED", "ROLLED_BACK"}:
        return "end"
    return "next"

"""Public deployment execution entrypoint."""

from __future__ import annotations

import os
import threading
import uuid
from typing import Any

from pydantic import ValidationError

from deploy_exec import nodes, store
from deploy_exec.adapters import build_adapter
from deploy_exec.blueprint import contract_to_blueprint, validate_blueprint
from deploy_exec.codes import result_class
from deploy_exec.contract import DeploymentContract
from deploy_exec.errors import DeployError
from deploy_exec.graph import get_deploy_graph
from deploy_exec.redact import redact
from deploy_exec.snapshot import freeze
from deploy_exec.state import DeployExecState


def _describe_instance(credentials: dict[str, Any] | None, instance_id: str, region: str) -> dict[str, Any] | None:
    instance_id = str(instance_id or "").strip()
    if not instance_id:
        return None
    creds = credentials or {}
    try:
        import boto3

        kwargs: dict[str, Any] = {}
        if region:
            kwargs["region_name"] = region
        key = str(creds.get("aws_access_key_id") or "").strip()
        secret = str(creds.get("aws_secret_access_key") or "").strip()
        if key and secret:
            kwargs["aws_access_key_id"] = key
            kwargs["aws_secret_access_key"] = secret
            if creds.get("aws_session_token"):
                kwargs["aws_session_token"] = creds["aws_session_token"]
        response = boto3.client("ec2", **kwargs).describe_instances(InstanceIds=[instance_id])
    except Exception:
        return None
    for reservation in response.get("Reservations") or []:
        for instance in reservation.get("Instances") or []:
            if isinstance(instance, dict):
                return instance
    return None


def _identity_from_credentials(credentials: dict[str, Any] | None) -> dict[str, str]:
    creds = credentials or {}
    if creds.get("account_id") and creds.get("aws_region"):
        return {"account_id": str(creds["account_id"]), "region": str(creds.get("aws_region") or creds.get("region") or "")}
    if not creds.get("aws_access_key_id"):
        return {
            "account_id": str(creds.get("account_id") or ""),
            "region": str(creds.get("aws_region") or creds.get("region") or ""),
        }
    try:
        import boto3

        kwargs: dict[str, Any] = {}
        region = str(creds.get("aws_region") or creds.get("region") or "")
        if region:
            kwargs["region_name"] = region
        kwargs["aws_access_key_id"] = creds["aws_access_key_id"]
        kwargs["aws_secret_access_key"] = creds.get("aws_secret_access_key") or ""
        if creds.get("aws_session_token"):
            kwargs["aws_session_token"] = creds["aws_session_token"]
        sts = boto3.client("sts", **kwargs)
        identity = sts.get_caller_identity()
        return {"account_id": str(identity.get("Account") or ""), "region": region}
    except Exception:
        return {
            "account_id": str(creds.get("account_id") or ""),
            "region": str(creds.get("aws_region") or creds.get("region") or ""),
        }


def _hydrate_contract(payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
    data = dict(payload)
    target = dict(data.get("target") or {})
    if not target.get("account_id") and identity.get("account_id"):
        target["account_id"] = identity["account_id"]
    if not target.get("region") and identity.get("region"):
        target["region"] = identity["region"]
    if not target.get("environment"):
        metadata = data.get("metadata") or {}
        target["environment"] = metadata.get("environment_id") or "production"
    if not target.get("target_id"):
        target["target_id"] = target.get("instance_id") or target.get("environment") or "ec2"
    data["target"] = target
    return data


def parse_contract(payload: dict[str, Any], identity: dict[str, str] | None = None) -> DeploymentContract:
    hydrated = _hydrate_contract(payload, identity or {})
    try:
        return DeploymentContract.model_validate(hydrated)
    except ValidationError as exc:
        raise DeployError(code="CONTRACT_INVALID", technical_message=str(exc)[:400]) from exc


def public_record(deployment_id: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    latest = store.read_latest(deployment_id) or {}
    body = state or latest.get("state") or latest
    error = body.get("error") if isinstance(body.get("error"), dict) else {}
    status = str(body.get("status") or "CREATED")
    frozen = store.read_snapshot(deployment_id) or body.get("snapshot") or {}
    return redact({
        "deployment_id": deployment_id,
        "project_id": body.get("project_id"),
        "environment_id": body.get("environment_id"),
        "status": status,
        "stage": body.get("stage"),
        "result": result_class(status, str(error.get("code") or "")),
        "result_class": result_class(status, str(error.get("code") or "")),
        "plan_preview": body.get("plan_preview"),
        "snapshot": frozen,
        "snapshot_hash": frozen.get("blueprint_hash") or body.get("snapshot_hash"),
        "error": error or None,
        "public_endpoint": body.get("public_endpoint"),
        "dry_run": body.get("dry_run"),
        "events": store.read_events(deployment_id),
        "previous_digest": body.get("previous_digest") or frozen.get("previous_digest"),
    })


def _invoke(state: DeployExecState) -> dict[str, Any]:
    deployment_id = str(state.get("deployment_id") or "")
    try:
        graph = get_deploy_graph()
        final = graph.invoke(state, config={"configurable": {"thread_id": f"{deployment_id}:{uuid.uuid4()}"}})
        return final if isinstance(final, dict) else state
    except DeployError as exc:
        store.write_checkpoint(deployment_id, "failed", {**dict(state), "status": "FAILED", "error": exc.as_dict()})
        return {**state, "status": "FAILED", "error": exc.as_dict()}
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        error = DeployError(code="AWS_API_FAILURE", technical_message=str(exc)[:300]).as_dict()
        store.write_checkpoint(deployment_id, "failed", {**dict(state), "status": "FAILED", "error": error})
        return {**state, "status": "FAILED", "error": error}
    finally:
        nodes.unbind_runtime(deployment_id)


def _bind(
    *,
    deployment_id: str,
    contract: DeploymentContract,
    credentials: dict[str, Any] | None,
    adapter,
    skip_tag_check: bool | None,
    instance: dict[str, Any] | None,
    identity: dict[str, str],
    crash_after: str = "",
    fail_external: bool = False,
) -> Any:
    adapter_obj = build_adapter(contract.execution.adapter, credentials, injected=adapter)
    if skip_tag_check is None:
        skip_tag_check = adapter_obj.name == "fake" or str(os.getenv("DEPLOY_EXEC_SKIP_TAG_CHECK") or "") in {"1", "true"}
    bound_instance = instance
    if bound_instance is None and adapter_obj.name != "fake" and not skip_tag_check:
        bound_instance = _describe_instance(
            credentials,
            contract.target.instance_id,
            identity.get("region") or contract.target.region,
        )
    nodes.bind_runtime(
        deployment_id,
        adapter=adapter_obj,
        credentials=credentials or {},
        account_id=identity.get("account_id") or contract.target.account_id,
        region=identity.get("region") or contract.target.region,
        skip_tag_check=skip_tag_check,
        instance=bound_instance,
        fast=adapter_obj.name == "fake",
        sleeper=(lambda _seconds: None) if adapter_obj.name == "fake" else None,
        crash_after=crash_after,
        fail_external=fail_external,
    )
    return adapter_obj


def create_deployment(
    payload: dict[str, Any],
    *,
    credentials: dict[str, Any] | None = None,
    dry_run: bool = False,
    background: bool = True,
    adapter=None,
    skip_tag_check: bool | None = None,
    instance: dict[str, Any] | None = None,
    crash_after: str = "",
    fail_external: bool = False,
) -> dict[str, Any]:
    identity = _identity_from_credentials(credentials)
    contract = parse_contract(payload, identity)
    deployment_id = str(contract.metadata.deployment_id or payload.get("deployment_id") or uuid.uuid4())
    dumped = contract.model_dump()
    dumped["metadata"]["deployment_id"] = deployment_id
    contract = DeploymentContract.model_validate(dumped)
    blueprint = contract_to_blueprint(contract)
    validate_blueprint(blueprint)
    freeze(deployment_id, contract, blueprint)
    _bind(
        deployment_id=deployment_id,
        contract=contract,
        credentials=credentials,
        adapter=adapter,
        skip_tag_check=skip_tag_check,
        instance=instance,
        identity=identity,
        crash_after=crash_after,
        fail_external=fail_external,
    )
    state: DeployExecState = {
        "deployment_id": deployment_id,
        "project_id": contract.metadata.project_id,
        "environment_id": contract.metadata.environment_id,
        "requested_by": contract.metadata.requested_by,
        "contract": contract.model_dump(),
        "blueprint": blueprint.model_dump(),
        "status": "CREATED",
        "stage": "created",
        "dry_run": bool(dry_run),
        "application_started": False,
        "locked": False,
        "cancelled": False,
        "retry_count": 0,
        "errors": [],
        "events": [],
        "completed_steps": [],
        "plan_preview": blueprint.plan_preview(),
        "result_class": "PENDING",
        "public_endpoint": blueprint.public_endpoint,
        "observed_account_id": identity.get("account_id") or contract.target.account_id,
        "observed_region": identity.get("region") or contract.target.region,
        "previous_digest": blueprint.previous_artifact.digest if blueprint.previous_artifact else "",
    }
    store.write_checkpoint(deployment_id, "created", dict(state))
    store.append_event(deployment_id, {"event": "DEPLOYMENT_CREATED", "snapshot_hash": (store.read_snapshot(deployment_id) or {}).get("blueprint_hash")})
    if background:
        thread = threading.Thread(target=_invoke, args=(state,), daemon=True, name=f"deploy-exec-{deployment_id[:8]}")
        thread.start()
        return public_record(deployment_id, state)
    final = _invoke(state)
    return public_record(deployment_id, final)


def _state_from_latest(deployment_id: str) -> DeployExecState:
    latest = store.read_latest(deployment_id)
    if not latest:
        raise DeployError(code="TARGET_NOT_FOUND", technical_message="deployment not found")
    body = latest.get("state") or latest
    if not isinstance(body, dict) or not body.get("contract"):
        raise DeployError(code="CONTRACT_INVALID", technical_message="cannot resume without a stored contract")
    state: DeployExecState = dict(body)  # type: ignore[assignment]
    state["deployment_id"] = deployment_id
    return state


def resume_deployment(
    deployment_id: str,
    *,
    credentials: dict[str, Any] | None = None,
    adapter=None,
    background: bool = True,
    skip_tag_check: bool | None = None,
) -> dict[str, Any]:
    state = _state_from_latest(deployment_id)
    status = str(state.get("status") or "")
    if status in {"COMPLETED", "FAILED", "CANCELLED", "ROLLED_BACK"}:
        return public_record(deployment_id, state)
    identity = _identity_from_credentials(credentials)
    contract = parse_contract(dict(state.get("contract") or {}), identity)
    _bind(
        deployment_id=deployment_id,
        contract=contract,
        credentials=credentials,
        adapter=adapter,
        skip_tag_check=skip_tag_check,
        instance=None,
        identity=identity,
    )
    if background:
        thread = threading.Thread(target=_invoke, args=(state,), daemon=True, name=f"deploy-exec-resume-{deployment_id[:8]}")
        thread.start()
        return public_record(deployment_id, state)
    final = _invoke(state)
    return public_record(deployment_id, final)


def get_deployment(deployment_id: str) -> dict[str, Any] | None:
    latest = store.read_latest(deployment_id)
    if not latest:
        return None
    return public_record(deployment_id)


def cancel_deployment(deployment_id: str) -> dict[str, Any]:
    store.request_cancel(deployment_id)
    store.append_event(deployment_id, {"event": "CANCEL_REQUESTED"})
    return public_record(deployment_id)


def retry_deployment(
    deployment_id: str,
    *,
    credentials: dict[str, Any] | None = None,
    adapter=None,
) -> dict[str, Any]:
    latest = store.read_latest(deployment_id)
    if not latest:
        raise DeployError(code="TARGET_NOT_FOUND", technical_message="deployment not found")
    body = latest.get("state") or latest
    contract = dict(body.get("contract") or {})
    if not contract:
        raise DeployError(code="CONTRACT_INVALID", technical_message="cannot retry without a stored contract")
    metadata = dict(contract.get("metadata") or {})
    metadata["deployment_id"] = ""
    contract["metadata"] = metadata
    return create_deployment(
        contract,
        credentials=credentials,
        dry_run=bool(body.get("dry_run")),
        background=True,
        adapter=adapter,
    )


def rollback_deployment(
    deployment_id: str,
    *,
    credentials: dict[str, Any] | None = None,
    adapter=None,
) -> dict[str, Any]:
    latest = store.read_latest(deployment_id)
    if not latest:
        raise DeployError(code="TARGET_NOT_FOUND", technical_message="deployment not found")
    body = latest.get("state") or latest
    contract = dict(body.get("contract") or {})
    rollback_spec = dict((contract.get("rollback") or {}))
    previous = rollback_spec.get("previous_artifact")
    if not previous:
        raise DeployError(code="ROLLBACK_FAILED", technical_message="no previous artifact")
    contract["artifact"] = previous
    metadata = dict(contract.get("metadata") or {})
    metadata["deployment_id"] = ""
    contract["metadata"] = metadata
    return create_deployment(contract, credentials=credentials, background=True, adapter=adapter)


def preflight(
    payload: dict[str, Any],
    *,
    credentials: dict[str, Any] | None = None,
    adapter=None,
) -> dict[str, Any]:
    return create_deployment(payload, credentials=credentials, dry_run=True, background=False, adapter=adapter)


def artifact_defaults(
    image: str,
    *,
    credentials: dict[str, Any] | None = None,
    client=None,
) -> dict[str, Any]:
    from deploy_exec.artifacts import latest_ecr_digest, normalize_ecr_image

    cleaned = normalize_ecr_image(image)
    digest = ""
    note = ""
    try:
        if cleaned:
            digest = latest_ecr_digest(cleaned, credentials, client=client)
    except DeployError as extra:
        note = extra.user_message
    return {
        "image": cleaned,
        "digest": digest,
        "note": note,
    }

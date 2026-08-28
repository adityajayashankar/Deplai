"""Immutable execution snapshot. Frozen after a deployment starts."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from deploy_exec import store
from deploy_exec.blueprint import DeploymentBlueprint
from deploy_exec.contract import DeploymentContract
from deploy_exec.redact import redact

CONTRACT_VERSION = "1"
BLUEPRINT_VERSION = "1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def compute_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def freeze(deployment_id: str, contract: DeploymentContract, blueprint: DeploymentBlueprint) -> dict[str, Any]:
    existing = store.read_snapshot(deployment_id)
    if existing:
        return existing
    body = {
        "deployment_id": deployment_id,
        "contract_version": CONTRACT_VERSION,
        "blueprint_version": BLUEPRINT_VERSION,
        "source_commit": contract.metadata.source_commit,
        "artifact_id": contract.artifact.artifact_id,
        "image": contract.artifact.image,
        "digest": contract.artifact.digest,
        "target": {
            "target_id": contract.target.target_id,
            "instance_id": contract.target.instance_id,
            "account_id": contract.target.account_id,
            "region": contract.target.region,
        },
        "environment": contract.metadata.environment_id,
        "project_id": contract.metadata.project_id,
        "strategy": "replace",
        "adapter": blueprint.adapter,
        "container_name": blueprint.container_name,
        "previous_digest": blueprint.previous_artifact.digest if blueprint.previous_artifact else None,
        "timestamp": _now(),
        "requested_by": contract.metadata.requested_by,
    }
    hashed = {key: value for key, value in body.items()}
    body["blueprint_hash"] = compute_hash(hashed)
    store.write_snapshot(deployment_id, redact(body))
    return body


def require_frozen(deployment_id: str) -> dict[str, Any]:
    snapshot = store.read_snapshot(deployment_id)
    return snapshot or {}

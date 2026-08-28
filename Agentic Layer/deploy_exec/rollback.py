from __future__ import annotations

from deploy_exec.blueprint import DeploymentBlueprint
from deploy_exec.contract import ArtifactRef
from deploy_exec.errors import DeployError


def previous_artifact(blueprint: DeploymentBlueprint) -> ArtifactRef | None:
    return blueprint.previous_artifact


def should_rollback(blueprint: DeploymentBlueprint, error: DeployError, started: bool) -> bool:
    if not blueprint.rollback_enabled:
        return False
    if not started:
        return False
    if blueprint.previous_artifact is None:
        return False
    if error.code in {"ENVIRONMENT_LOCKED", "TARGET_UNAUTHORIZED", "UNVERIFIED_ARTIFACT"}:
        return False
    if error.code == "CANCELLED":
        return True
    return True


def rollback_blueprint(blueprint: DeploymentBlueprint) -> DeploymentBlueprint:
    previous = blueprint.previous_artifact
    if previous is None:
        raise DeployError(code="ROLLBACK_FAILED", technical_message="no previous artifact")
    payload = blueprint.model_dump()
    payload["artifact"] = previous.model_dump()
    payload["image_pull_ref"] = previous.pull_ref
    return DeploymentBlueprint.model_validate(payload)

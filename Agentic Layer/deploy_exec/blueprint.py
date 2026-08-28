from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from deploy_exec.contract import ArtifactRef, DeploymentContract, NetworkSpec
from deploy_exec.errors import DeployError


class DeploymentBlueprint(BaseModel):
    """Desired state. Never a list of arbitrary shell commands."""

    project_id: str
    environment_id: str
    deployment_id: str
    runtime: str = "docker"
    adapter: str = "ssm"
    strategy: str = "replace"
    artifact: ArtifactRef
    previous_artifact: ArtifactRef | None = None
    container_name: str
    image_pull_ref: str
    network: NetworkSpec
    public_endpoint: str = ""
    secret_arns: list[str] = Field(default_factory=list)
    config_keys: list[str] = Field(default_factory=list)
    account_id: str
    region: str
    instance_id: str
    health_endpoint: str = "/health"
    smoke_paths: list[str] = Field(default_factory=list)
    rollback_enabled: bool = True
    timeout_seconds: int = 900
    source_commit: str = ""
    build_id: str = ""

    def plan_preview(self) -> dict[str, Any]:
        return {
            "environment": self.environment_id,
            "target": "EC2",
            "runtime": "Docker",
            "artifact": self.image_pull_ref,
            "execution": "AWS SSM",
            "strategy": "Replace",
            "health_check": self.health_endpoint,
            "rollback": "Enabled" if self.rollback_enabled else "Disabled",
            "previous_version": self.previous_artifact.digest if self.previous_artifact else None,
            "account_id": self.account_id,
            "region": self.region,
            "instance_id": self.instance_id,
            "image": self.artifact.image,
            "digest": self.artifact.digest,
            "ports": f"{self.network.host_port}:{self.network.container_port}",
            "adapter": self.adapter,
        }


def contract_to_blueprint(contract: DeploymentContract) -> DeploymentBlueprint:
    if contract.artifact.status not in {"VERIFIED", "PROMOTED"}:
        raise DeployError(
            code="UNVERIFIED_ARTIFACT",
            recommended_action="Promote a verified image digest before deploying.",
        )
    smoke = []
    for item in contract.verification.smoke_tests:
        if isinstance(item, dict) and item.get("path"):
            smoke.append(str(item["path"]))
        elif isinstance(item, str):
            smoke.append(item)
    if not smoke:
        smoke = [contract.network.health_endpoint or "/health"]
    return DeploymentBlueprint(
        project_id=contract.metadata.project_id,
        environment_id=contract.metadata.environment_id,
        deployment_id=contract.metadata.deployment_id,
        runtime="docker",
        adapter=contract.execution.adapter,
        strategy="replace",
        artifact=contract.artifact,
        previous_artifact=contract.rollback.previous_artifact,
        container_name=contract.container_name,
        image_pull_ref=contract.artifact.pull_ref,
        network=contract.network,
        public_endpoint=contract.network.public_endpoint,
        secret_arns=[item.arn for item in contract.secret_references],
        config_keys=[str(key) for key in (contract.configuration or {}).keys()],
        account_id=contract.target.account_id,
        region=contract.target.region,
        instance_id=contract.target.instance_id,
        health_endpoint=contract.network.health_endpoint,
        smoke_paths=smoke,
        rollback_enabled=bool(contract.rollback.enabled),
        timeout_seconds=contract.execution.timeout_seconds,
        source_commit=contract.metadata.source_commit,
        build_id=contract.artifact.build_id,
    )


def validate_blueprint(blueprint: DeploymentBlueprint) -> None:
    if not blueprint.instance_id:
        raise DeployError(code="TARGET_NOT_FOUND", recommended_action="Provision EC2 for this environment first.")
    if not blueprint.artifact.digest.startswith("sha256:"):
        raise DeployError(code="BLUEPRINT_INVALID", technical_message="digest is not immutable")
    if blueprint.runtime != "docker":
        raise DeployError(code="BLUEPRINT_INVALID", technical_message="runtime must be docker")
    if blueprint.adapter not in {"ssm", "ssh"}:
        raise DeployError(code="BLUEPRINT_INVALID", technical_message="adapter must be ssm or ssh")

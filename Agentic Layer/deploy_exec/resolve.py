from __future__ import annotations

import re
from typing import Any

from deploy_exec.contract import DeploymentContract
from deploy_exec.errors import DeployError

_PROJECT_SLUG = re.compile(r"[^a-z0-9-]+")


def project_slug(value: str) -> str:
    slug = _PROJECT_SLUG.sub("-", str(value or "").strip().lower())
    return re.sub(r"-{2,}", "-", slug).strip("-")


def validate_identity(contract: DeploymentContract, account_id: str, region: str) -> None:
    observed_account = str(account_id or "").strip()
    observed_region = str(region or "").strip()
    if contract.target.account_id and observed_account and contract.target.account_id != observed_account:
        raise DeployError(
            code="WRONG_ACCOUNT",
            details={"expected": contract.target.account_id, "observed": observed_account},
        )
    if contract.target.region and observed_region and contract.target.region != observed_region:
        raise DeployError(
            code="WRONG_REGION",
            details={"expected": contract.target.region, "observed": observed_region},
        )


def instance_belongs_to_environment(
    instance: dict[str, Any],
    project_id: str,
    environment_id: str,
) -> bool:
    tags = {}
    for tag in instance.get("Tags") or []:
        if isinstance(tag, dict) and tag.get("Key"):
            tags[str(tag["Key"])] = str(tag.get("Value") or "")
    name = tags.get("Name", "")
    env_tag = tags.get("Environment") or tags.get("environment") or ""
    slug = project_slug(project_id)
    name_slug = project_slug(name)
    if slug and name_slug and (name_slug == slug or name_slug.startswith(f"{slug}-")):
        if env_tag and project_slug(env_tag) not in {project_slug(environment_id), ""}:
            return False
        return True
    if tags.get("deplai:project") == project_id:
        return True
    return False


def validate_instance(
    contract: DeploymentContract,
    instance: dict[str, Any] | None,
    *,
    skip_tag_check: bool = False,
) -> None:
    if not instance:
        raise DeployError(code="TARGET_NOT_FOUND")
    instance_id = str(instance.get("InstanceId") or instance.get("instance_id") or "")
    if contract.target.instance_id and instance_id and instance_id != contract.target.instance_id:
        raise DeployError(code="TARGET_UNAUTHORIZED", technical_message="instance id mismatch")
    if skip_tag_check:
        return
    if not instance_belongs_to_environment(instance, contract.metadata.project_id, contract.metadata.environment_id):
        raise DeployError(
            code="TARGET_UNAUTHORIZED",
            recommended_action="Deploy only to instances provisioned for this project environment.",
        )

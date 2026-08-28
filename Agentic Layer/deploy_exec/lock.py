from __future__ import annotations

from deploy_exec import store
from deploy_exec.errors import DeployError


def acquire(environment_key: str, deployment_id: str) -> None:
    if not store.acquire_env_lock(environment_key, deployment_id):
        owner = store.lock_owner(environment_key) or "another deployment"
        raise DeployError(
            code="ENVIRONMENT_LOCKED",
            recommended_action="Wait for the in-flight deployment to finish, then retry.",
            details={"environment_key": environment_key, "holder": owner},
        )


def heartbeat(environment_key: str, deployment_id: str) -> None:
    acquire(environment_key, deployment_id)


def release(environment_key: str, deployment_id: str) -> None:
    store.release_env_lock(environment_key, deployment_id)

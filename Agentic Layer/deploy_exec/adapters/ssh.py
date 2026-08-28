from __future__ import annotations

import os

from deploy_exec.adapters.base import ExecutionResult
from deploy_exec.errors import DeployError


class SSHExecutionAdapter:
    name = "ssh"

    def __init__(self, credentials: dict | None = None) -> None:
        del credentials
        self.enabled = str(os.getenv("DEPLOY_EXEC_ALLOW_SSH") or "").strip() in {"1", "true", "yes"}

    def ping(self, instance_id: str) -> bool:
        del instance_id
        if not self.enabled:
            raise DeployError(
                code="CONFIGURATION_ERROR",
                technical_message="SSH execution is disabled. Use SSM.",
                recommended_action="Keep DEPLOY_EXEC_ALLOW_SSH unset and use Systems Manager.",
            )
        return False

    def execute(self, instance_id: str, commands: list[str], *, timeout_seconds: int, metadata: dict | None = None) -> ExecutionResult:
        del instance_id, commands, timeout_seconds, metadata
        raise DeployError(
            code="CONFIGURATION_ERROR",
            technical_message="SSH execution is not enabled for this platform.",
        )

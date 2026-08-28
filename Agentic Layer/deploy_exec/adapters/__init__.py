from __future__ import annotations

import os
from typing import Any

from deploy_exec.adapters.fake import FakeAdapter
from deploy_exec.adapters.ssh import SSHExecutionAdapter
from deploy_exec.adapters.ssm import SSMExecutionAdapter


def build_adapter(name: str, credentials: dict[str, Any] | None = None, injected=None):
    if injected is not None:
        return injected
    requested = str(name or os.getenv("DEPLOY_EXEC_ADAPTER") or "ssm").strip().lower()
    if requested == "fake":
        return FakeAdapter()
    if requested == "ssh":
        return SSHExecutionAdapter(credentials)
    return SSMExecutionAdapter(credentials, region=str((credentials or {}).get("aws_region") or ""))

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

from deploy_exec import store
from deploy_exec.adapters.base import ExecutionResult
from deploy_exec.errors import DeployError
from deploy_exec.redact import redact_text


class FakeAdapter:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_on: dict[str, DeployError | str] = {}
        self.fail_counts: dict[str, int] = {}
        self.fail_after: dict[str, int] = {}
        self.ping_ok = True
        self.inspect_digest = ""
        self.reconciled: list[dict[str, Any]] = []
        self.write_pending_then_crash = ""
        self.cancel_on = ""
        self.capabilities: dict[str, Any] = {
            "os": "Linux",
            "architecture": "x86_64",
            "docker_installed": True,
            "docker_version": "24.0.0",
            "docker_running": True,
            "disk_kb": 8_000_000,
            "memory_kb": 2_000_000,
            "ssm_connected": True,
            "current_container": "",
            "current_digest": "",
            "current_running": "",
        }
        self.sleeper: Callable[[float], None] = lambda _seconds: None

    def ping(self, instance_id: str) -> bool:
        del instance_id
        return bool(self.ping_ok)

    def reconcile(self, pending: dict[str, Any]) -> ExecutionResult:
        self.reconciled.append(dict(pending))
        operation = str(pending.get("operation") or "")
        stdout = "ok"
        if operation == "discover_host":
            stdout = json.dumps(self.capabilities)
        elif operation == "inspect_digest":
            stdout = self.inspect_digest or "sha256:" + ("b" * 64)
        return ExecutionResult(
            ok=True,
            stdout=redact_text(stdout),
            exit_code=0,
            execution_id=str(pending.get("command_id") or "reconciled"),
            metadata={"operation": operation, "reconciled": True},
        )

    def execute(
        self,
        instance_id: str,
        commands: list[str],
        *,
        timeout_seconds: int,
        metadata: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        started = time.time()
        meta = metadata or {}
        operation = str(meta.get("operation") or "")
        self.calls.append({"instance_id": instance_id, "commands": commands, "operation": operation, "timeout": timeout_seconds})
        if self.cancel_on == operation:
            store.request_cancel(str(meta.get("deployment_id") or ""))
        if self.write_pending_then_crash == operation:
            deployment_id = str(meta.get("deployment_id") or "")
            if deployment_id:
                store.write_pending_command(
                    deployment_id,
                    {
                        "command_id": "fake-cmd-1",
                        "instance_id": instance_id,
                        "operation": operation,
                        "status": "in_flight",
                    },
                )
            raise KeyboardInterrupt(f"simulated crash after sending {operation}")
        if operation in self.fail_counts:
            remaining = int(self.fail_counts[operation])
            if remaining > 0:
                self.fail_counts[operation] = remaining - 1
                fail = self.fail_on.get(operation) or "HEALTH_CHECK_FAILED"
                if isinstance(fail, DeployError):
                    raise fail
                raise DeployError(code=str(fail))
        elif operation in self.fail_on:
            fail = self.fail_on[operation]
            if isinstance(fail, DeployError):
                raise fail
            raise DeployError(code=str(fail))
        stdout = "ok"
        joined = " ".join(commands)
        digest_match = re.search(r"sha256:[a-f0-9]{64}", joined, re.I)
        if operation == "discover_host":
            stdout = json.dumps(self.capabilities)
        elif operation == "verify_container":
            stdout = "true running sha256:ok"
        elif operation == "health_check":
            stdout = "200"
        elif operation == "smoke_test":
            stdout = "200"
        elif operation == "collect_logs":
            stdout = "listening on 3000"
        elif operation == "inspect_digest":
            stdout = self.inspect_digest or (digest_match.group(0) if digest_match else "missing-digest")
        return ExecutionResult(
            ok=True,
            stdout=redact_text(stdout),
            exit_code=0,
            duration_ms=int((time.time() - started) * 1000),
            execution_id="fake-cmd",
            metadata={"operation": operation, "command_id": "fake-cmd"},
        )

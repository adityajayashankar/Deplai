from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from deploy_exec import store
from deploy_exec.adapters.base import ExecutionResult
from deploy_exec.errors import DeployError
from deploy_exec.redact import redact_text


def _client_error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code") or "")
    return ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SSMExecutionAdapter:
    name = "ssm"

    def __init__(
        self,
        credentials: dict[str, Any] | None = None,
        *,
        client: Any = None,
        region: str = "",
    ) -> None:
        self.credentials = credentials or {}
        self.region = str(region or self.credentials.get("aws_region") or self.credentials.get("region") or "")
        self._client = client

    def _ssm(self):
        if self._client is not None:
            return self._client
        import boto3

        kwargs: dict[str, Any] = {}
        if self.region:
            kwargs["region_name"] = self.region
        key = str(self.credentials.get("aws_access_key_id") or "").strip()
        secret = str(self.credentials.get("aws_secret_access_key") or "").strip()
        token = str(self.credentials.get("aws_session_token") or "").strip()
        if key and secret:
            kwargs["aws_access_key_id"] = key
            kwargs["aws_secret_access_key"] = secret
            if token:
                kwargs["aws_session_token"] = token
        self._client = boto3.client("ssm", **kwargs)
        return self._client

    def ping(self, instance_id: str) -> bool:
        try:
            response = self._ssm().describe_instance_information(
                Filters=[{"Key": "InstanceIds", "Values": [instance_id]}],
            )
        except Exception as exc:
            self._raise_aws(exc, instance_id)
        items = response.get("InstanceInformationList") or []
        if not items:
            return False
        return str(items[0].get("PingStatus") or "").lower() == "online"

    def execute(
        self,
        instance_id: str,
        commands: list[str],
        *,
        timeout_seconds: int,
        metadata: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        started = time.time()
        started_at = _now()
        meta = metadata or {}
        comment = f"deplai:{meta.get('deployment_id', '')}:{meta.get('operation', '')}"[:100]
        try:
            sent = self._ssm().send_command(
                InstanceIds=[instance_id],
                DocumentName="AWS-RunShellScript",
                Parameters={"commands": list(commands)},
                TimeoutSeconds=max(30, int(timeout_seconds)),
                Comment=comment,
            )
        except Exception as exc:
            self._raise_aws(exc, instance_id)
        command_id = str((sent.get("Command") or {}).get("CommandId") or "")
        if not command_id:
            raise DeployError(code="AWS_API_FAILURE", technical_message="SSM did not return a command id")
        deployment_id = str(meta.get("deployment_id") or "")
        if deployment_id:
            store.write_pending_command(
                deployment_id,
                {
                    "command_id": command_id,
                    "instance_id": instance_id,
                    "operation": meta.get("operation"),
                    "status": "in_flight",
                    "started_at": started_at,
                },
            )
        try:
            return self._wait_invocation(
                command_id,
                instance_id,
                timeout_seconds=timeout_seconds,
                started=started,
                started_at=started_at,
                operation=str(meta.get("operation") or ""),
            )
        finally:
            if deployment_id:
                store.clear_pending_command(deployment_id)

    def reconcile(self, pending: dict[str, Any]) -> ExecutionResult:
        command_id = str(pending.get("command_id") or "")
        instance_id = str(pending.get("instance_id") or "")
        if not command_id or not instance_id:
            raise DeployError(code="SSM_COMMAND_FAILED", technical_message="in-flight SSM command is missing identifiers")
        timeout_seconds = int(pending.get("timeout_seconds") or 120)
        return self._wait_invocation(
            command_id,
            instance_id,
            timeout_seconds=timeout_seconds,
            started=time.time(),
            started_at=str(pending.get("started_at") or _now()),
            operation=str(pending.get("operation") or ""),
        )

    def _wait_invocation(
        self,
        command_id: str,
        instance_id: str,
        *,
        timeout_seconds: int,
        started: float,
        started_at: str,
        operation: str,
    ) -> ExecutionResult:
        deadline = time.time() + max(30, int(timeout_seconds))
        invocation: dict[str, Any] = {}
        while time.time() < deadline:
            try:
                invocation = self._ssm().get_command_invocation(
                    CommandId=command_id,
                    InstanceId=instance_id,
                )
            except Exception as exc:
                code = _client_error_code(exc)
                if code in {"InvocationDoesNotExist", "InvalidInstanceId"}:
                    time.sleep(1.5)
                    continue
                self._raise_aws(exc, instance_id)
            status = str(invocation.get("Status") or "")
            if status in {"Success", "Cancelled", "TimedOut", "Failed", "Undeliverable"}:
                break
            time.sleep(1.5)
        else:
            raise DeployError(code="SSM_TIMEOUT", details={"command_id": command_id, "execution_id": command_id})
        status = str(invocation.get("Status") or "")
        stdout = redact_text(str(invocation.get("StandardOutputContent") or ""))
        stderr = redact_text(str(invocation.get("StandardErrorContent") or ""))
        exit_code = int(invocation.get("ResponseCode") or (0 if status == "Success" else 1))
        duration_ms = int((time.time() - started) * 1000)
        if status != "Success":
            raise self._status_error(status, stdout, stderr, command_id)
        return ExecutionResult(
            ok=True,
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            execution_id=command_id,
            started_at=started_at,
            completed_at=_now(),
            metadata={"command_id": command_id, "execution_id": command_id, "operation": operation},
        )

    def _status_error(self, status: str, stdout: str, stderr: str, command_id: str) -> DeployError:
        combined = f"{stdout}\n{stderr}".lower()
        details = {"command_id": command_id, "execution_id": command_id, "ssm_status": status}
        if status == "TimedOut":
            return DeployError(code="SSM_TIMEOUT", details=details)
        if status == "Undeliverable":
            return DeployError(code="SSM_OFFLINE", details=details)
        if "denied" in combined or "accessdenied" in combined:
            return DeployError(code="SSM_PERMISSION_DENIED", details=details)
        if "no such image" in combined or "not found" in combined and "sha256:" in combined:
            return DeployError(code="ARTIFACT_NOT_FOUND", details=details)
        if "pull" in combined and ("denied" in combined or "no basic auth" in combined):
            return DeployError(code="ECR_AUTH_FAILED", details=details)
        if "port is already allocated" in combined or "bind" in combined and "address already in use" in combined:
            return DeployError(code="PORT_CONFLICT", details=details)
        return DeployError(
            code="SSM_COMMAND_FAILED" if status == "Failed" else "TIMEOUT",
            technical_message=redact_text((stderr or stdout)[:400]),
            details=details,
        )

    def _raise_aws(self, exc: Exception, instance_id: str) -> None:
        code = _client_error_code(exc)
        text = str(exc)
        if code in {"InvalidInstanceId", "InvalidInstanceInformationFilterValue"}:
            raise DeployError(code="TARGET_NOT_FOUND", details={"instance_id": instance_id}) from exc
        if code in {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}:
            raise DeployError(code="SSM_PERMISSION_DENIED") from exc
        if "timeout" in text.lower():
            raise DeployError(code="SSM_TIMEOUT") from exc
        raise DeployError(code="AWS_API_FAILURE", technical_message=redact_text(text[:300])) from exc

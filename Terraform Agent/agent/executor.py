import asyncio
import json
import os
from pathlib import Path
from typing import AsyncGenerator

PARALLELISM = int(os.getenv("IAC_TERRAFORM_PARALLELISM", "10"))


class IaCApplyError(Exception):
    """Raised when terraform apply exits with a non-zero return code."""

    def __init__(self, run_id: str, returncode: int, stderr: str):
        self.run_id = run_id
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(
            f"terraform apply failed (exit {returncode}) for run {run_id}: {stderr[:500]}"
        )


def _build_env(aws_credentials: dict) -> dict:
    """Build subprocess environment. Credentials injected as env vars — never in .tf files."""
    env = os.environ.copy()
    env["AWS_ACCESS_KEY_ID"] = aws_credentials.get("access_key_id", "")
    env["AWS_SECRET_ACCESS_KEY"] = aws_credentials.get("secret_access_key", "")
    env["AWS_DEFAULT_REGION"] = aws_credentials.get("region", "us-east-1")
    env["TF_IN_AUTOMATION"] = "1"
    env["TF_CLI_ARGS_apply"] = "-compact-warnings"
    return env


async def plan(workspace: Path, aws_credentials: dict) -> str:
    """
    Runs: terraform plan -no-color -out=tfplan
    Returns a human-readable summary string like:
      "Plan: 3 to add, 0 to change, 0 to destroy."
    This is shown to the user before apply is triggered.
    """
    env = _build_env(aws_credentials)

    proc = await asyncio.create_subprocess_exec(
        "terraform", "plan", "-no-color", f"-out={workspace / 'tfplan'}",
        cwd=workspace,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    stdout = stdout_bytes.decode()
    stderr = stderr_bytes.decode()

    if proc.returncode != 0:
        raise IaCApplyError("plan", proc.returncode, stderr)

    # Extract the summary line
    for line in stdout.splitlines():
        if line.strip().startswith("Plan:") or "No changes" in line:
            return line.strip()

    return stdout.strip()[-300:]


async def stream_apply(
    workspace: Path,
    aws_credentials: dict,
    run_id: str,
) -> AsyncGenerator[str, None]:
    """
    Runs: terraform apply -auto-approve -json -parallelism=N
    Yields each stdout line as it arrives (raw Terraform JSON event strings).

    Terraform JSON output format per line:
      {"@level":"info","@message":"...","@module":"terraform.ui","type":"..."}

    The caller (pipeline orchestrator) is responsible for forwarding these
    lines to the WebSocket log stream.

    Raises IaCApplyError on non-zero exit code.
    """
    env = _build_env(aws_credentials)

    proc = await asyncio.create_subprocess_exec(
        "terraform", "apply",
        "-auto-approve",
        "-json",
        f"-parallelism={PARALLELISM}",
        cwd=workspace,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Stream stdout line by line
    assert proc.stdout is not None
    async for raw_line in proc.stdout:
        line = raw_line.decode().rstrip()
        if line:
            yield line

    # Collect stderr for error reporting
    assert proc.stderr is not None
    stderr_bytes = await proc.stderr.read()
    stderr_text = stderr_bytes.decode()

    await proc.wait()

    if proc.returncode != 0:
        raise IaCApplyError(run_id, proc.returncode, stderr_text)


async def get_outputs(workspace: Path, aws_credentials: dict) -> dict:
    """
    Runs: terraform output -json
    Parses the output and returns a flat dict of output name -> value.

    Raw terraform output format:
      { "public_ip": { "value": "54.x.x.x", "type": "string" }, ... }

    Returns flat:
      { "public_ip": "54.x.x.x", "instance_id": "i-0abc...", ... }
    """
    env = _build_env(aws_credentials)

    proc = await asyncio.create_subprocess_exec(
        "terraform", "output", "-json",
        cwd=workspace,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, _ = await proc.communicate()
    raw = json.loads(stdout_bytes.decode())

    # Flatten: extract .value from each output block
    return {key: block["value"] for key, block in raw.items()}


async def destroy(workspace: Path, aws_credentials: dict) -> None:
    """
    Runs: terraform destroy -auto-approve
    Called when the user clicks "Destroy resources" in the UI.
    Blocks until complete. Raises IaCApplyError on failure.
    """
    env = _build_env(aws_credentials)

    proc = await asyncio.create_subprocess_exec(
        "terraform", "destroy", "-auto-approve", "-no-color",
        cwd=workspace,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr_bytes = await proc.communicate()

    if proc.returncode != 0:
        raise IaCApplyError("destroy", proc.returncode, stderr_bytes.decode())


import shutil
from datetime import datetime, timezone, timedelta


async def cleanup_old_workspaces() -> int:
    """
    Deletes workspace directories older than IAC_WORKSPACE_TTL_HOURS.
    Returns count of directories deleted.
    Call this from a startup event or a background scheduler.
    """
    workspace_root = Path(os.getenv("IAC_WORKSPACE_ROOT", "/tmp/deplai-workspaces"))
    ttl_hours = int(os.getenv("IAC_WORKSPACE_TTL_HOURS", "24"))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=ttl_hours)
    deleted = 0

    if not workspace_root.exists():
        return 0

    for entry in workspace_root.iterdir():
        if not entry.is_dir():
            continue
        mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc)
        if mtime < cutoff:
            shutil.rmtree(entry, ignore_errors=True)
            deleted += 1

    return deleted

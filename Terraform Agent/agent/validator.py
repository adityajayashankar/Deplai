import asyncio
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

if __package__:
    from .template_registry import get_template_path
else:
    from template_registry import get_template_path

WORKSPACE_ROOT = Path(os.getenv("IAC_WORKSPACE_ROOT", "/tmp/deplai-workspaces"))
MAX_RETRIES = int(os.getenv("IAC_MAX_VALIDATION_RETRIES", "3"))


class IaCValidationError(Exception):
    """Raised when validation fails after all retries are exhausted."""

    def __init__(self, service_type: str, attempts: int, last_errors: list[str]):
        self.service_type = service_type
        self.attempts = attempts
        self.last_errors = last_errors
        super().__init__(
            f"Terraform validation failed for {service_type} after {attempts} attempts. "
            f"Last errors: {last_errors}"
        )


@dataclass
class ValidationResult:
    success: bool
    errors: list[str] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""


def prepare_workspace(
    service_type: str,
    params: dict,
    project_id: str,
    aws_credentials: dict,
) -> Path:
    """
    Copies the template directory to a fresh isolated workspace.
    Writes params as terraform.tfvars.json.
    AWS credentials are injected as env vars at subprocess time — never written to disk.
    Returns the workspace Path.
    """
    workspace = WORKSPACE_ROOT / f"{project_id}_{service_type}"

    # Clean up any previous workspace for this project+service
    if workspace.exists():
        shutil.rmtree(workspace)

    workspace.mkdir(parents=True, exist_ok=True)

    # Copy template files
    template_path = get_template_path(service_type)
    for tf_file in template_path.glob("*.tf"):
        shutil.copy2(tf_file, workspace / tf_file.name)

    # Write params as tfvars — this is the only file the LLM influences
    tfvars_path = workspace / "terraform.tfvars.json"
    with open(tfvars_path, "w") as f:
        json.dump(params, f, indent=2)

    return workspace


def _build_env(aws_credentials: dict) -> dict:
    """Build subprocess environment with AWS credentials as env vars."""
    env = os.environ.copy()
    env["AWS_ACCESS_KEY_ID"] = aws_credentials.get("access_key_id", "")
    env["AWS_SECRET_ACCESS_KEY"] = aws_credentials.get("secret_access_key", "")
    env["AWS_DEFAULT_REGION"] = aws_credentials.get("region", "us-east-1")
    env["TF_IN_AUTOMATION"] = "1"
    return env


async def _run_cmd(cmd: list[str], cwd: Path, env: dict) -> tuple[int, str, str]:
    """Run a shell command asynchronously, return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    return proc.returncode, stdout_bytes.decode(), stderr_bytes.decode()


async def validate(workspace: Path, aws_credentials: dict) -> ValidationResult:
    """
    Runs: terraform init -backend=false && terraform validate
    Returns ValidationResult with success flag and any error lines.
    """
    env = _build_env(aws_credentials)

    # Step 1: init (downloads providers/modules, no backend)
    rc, stdout, stderr = await _run_cmd(
        ["terraform", "init", "-backend=false", "-no-color"],
        cwd=workspace,
        env=env,
    )
    if rc != 0:
        return ValidationResult(
            success=False,
            errors=[f"terraform init failed: {stderr}"],
            stdout=stdout,
            stderr=stderr,
        )

    # Step 2: validate
    rc, stdout, stderr = await _run_cmd(
        ["terraform", "validate", "-no-color"],
        cwd=workspace,
        env=env,
    )

    if rc == 0:
        return ValidationResult(success=True, stdout=stdout, stderr=stderr)

    # Parse error lines (strip blank lines and formatting noise)
    error_lines = [
        line.strip() for line in (stdout + "\n" + stderr).splitlines()
        if line.strip() and not line.startswith("╷") and not line.startswith("╵")
        and not line.startswith("│") and line.strip() not in ["", "Error"]
    ]

    return ValidationResult(success=False, errors=error_lines, stdout=stdout, stderr=stderr)


async def validate_with_retry(
    service_type: str,
    params: dict,
    project_id: str,
    aws_credentials: dict,
) -> tuple[Path, dict]:
    """
    Main entry point for the validation phase.
    Loops: prepare workspace -> validate -> on failure, correct params -> repeat.
    Returns (validated_workspace_path, final_params) on success.
    Raises IaCValidationError if max retries exhausted.
    """
    # Import here to avoid circular import
    if __package__:
        from .param_selector import correct_params
    else:
        from param_selector import correct_params

    current_params = dict(params)
    last_errors: list[str] = []

    for attempt in range(1, MAX_RETRIES + 1):
        workspace = prepare_workspace(service_type, current_params, project_id, aws_credentials)
        result = await validate(workspace, aws_credentials)

        if result.success:
            return workspace, current_params

        last_errors = result.errors
        print(f"[validator] Attempt {attempt}/{MAX_RETRIES} failed for {service_type}:")
        for err in last_errors:
            print(f"  {err}")

        if attempt < MAX_RETRIES:
            print(f"[validator] Calling LLM to correct params...")
            current_params = await correct_params(service_type, current_params, last_errors)

    raise IaCValidationError(service_type, MAX_RETRIES, last_errors)

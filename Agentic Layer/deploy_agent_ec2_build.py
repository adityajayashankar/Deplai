"""Agent endpoint to connect to provisioned EC2 via SSM and run build/start commands."""
from __future__ import annotations

from deploy_exec.adapters.ssm import SSMExecutionAdapter
from deploy_exec.errors import DeployError


def run_ec2_build_commands(
    instance_id: str,
    region: str,
    credentials: dict,
    build_command: str,
    start_command: str = "",
    project_slug: str = "deplai-app",
    timeout_seconds: int = 300,
) -> dict:
    adapter = SSMExecutionAdapter(credentials=credentials, region=region)
    commands = []
    if build_command and str(build_command).strip():
        commands.append(f"cd /opt/{project_slug} && bash -lc '{build_command}'")
    if start_command and str(start_command).strip():
        commands.append(f"systemctl restart deplai-app || (pm2 delete {project_slug} 2>/dev/null; pm2 start {start_command})")
    if not commands:
        commands = ["echo 'No build/start commands provided'"]
    result = adapter.execute(instance_id, commands, timeout_seconds=timeout_seconds,
                             metadata={"operation": "agent_ec2_build", "project": project_slug})
    return {
        "ok": result.ok,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exit_code": result.exit_code,
        "execution_id": result.execution_id,
        "instance_id": instance_id,
    }

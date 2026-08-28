"""Allowlisted deployment operations. No generic run_any_shell_command."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable

from deploy_exec.errors import DeployError

_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/=@-]{0,500}$")
_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_INSTANCE = re.compile(r"^i-[0-9a-f]{8,17}$")
_PATH = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@/\-]*$")


def _token(name: str, value: str) -> str:
    raw = str(value or "").strip()
    if not raw or not _SAFE_TOKEN.match(raw) or any(ch in raw for ch in ";|&`$()<>\n"):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"unsafe {name}")
    return raw


def _port(name: str, value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"invalid {name}") from exc
    if port < 1 or port > 65535:
        raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"invalid {name}")
    return port


@dataclass(frozen=True)
class Operation:
    name: str
    timeout_seconds: int
    retryable: bool
    idempotent: bool
    render: Callable[[dict[str, Any]], list[str]]


def _discover(inputs: dict[str, Any]) -> list[str]:
    name = str(inputs.get("container_name") or "").strip()
    if name and not _SAFE_TOKEN.match(name):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="unsafe container_name")
    name_json = json.dumps(name)
    return [
        "python3 - <<'PY'\n"
        "import json, os, shutil, subprocess\n"
        f"container_name = {name_json}\n"
        "def sh(cmd):\n"
        "    try:\n"
        "        return subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.STDOUT, timeout=8).strip()\n"
        "    except Exception as exc:\n"
        "        return str(exc)\n"
        "info = {\n"
        "  'os': sh('uname -s'),\n"
        "  'os_version': sh('uname -r'),\n"
        "  'architecture': sh('uname -m'),\n"
        "  'cpu': sh('nproc'),\n"
        "  'memory_kb': sh(\"awk '/MemAvailable/ {print $2}' /proc/meminfo\"),\n"
        "  'disk_kb': sh(\"df -k / | awk 'NR==2 {print $4}'\"),\n"
        "  'docker_installed': bool(shutil.which('docker')),\n"
        "  'docker_version': sh('docker --version') if shutil.which('docker') else '',\n"
        "  'docker_running': 'ok' in sh('docker info >/dev/null && echo ok || echo no'),\n"
        "  'ssm_connected': True,\n"
        "  'current_container': '',\n"
        "  'current_digest': '',\n"
        "  'current_running': '',\n"
        "}\n"
        "if container_name:\n"
        "    info['current_container'] = sh(\"docker inspect --format '{{.Name}}' \" + container_name)\n"
        "    info['current_digest'] = sh(\"docker inspect --format '{{.Config.Image}}' \" + container_name)\n"
        "    info['current_running'] = sh(\"docker inspect --format '{{.State.Running}}' \" + container_name)\n"
        "print(json.dumps(info))\n"
        "PY"
    ]


def _inspect_digest(inputs: dict[str, Any]) -> list[str]:
    image = _token("image", inputs.get("image", ""))
    digest = str(inputs.get("digest") or "")
    if not _DIGEST.match(digest):
        raise DeployError(code="ARTIFACT_UNVERIFIED", technical_message="inspect requires an immutable digest")
    return [f"docker image inspect --format '{{{{json .RepoDigests}}}} {{{{.Id}}}}' {image}@{digest}"]


def _prepare_docker(inputs: dict[str, Any]) -> list[str]:
    del inputs
    return [
        "command -v docker >/dev/null || dnf install -y docker",
        "systemctl enable --now docker",
        "docker info >/dev/null",
    ]


def _ecr_login(inputs: dict[str, Any]) -> list[str]:
    region = _token("region", inputs.get("region", ""))
    account = _token("account_id", inputs.get("account_id", ""))
    registry = f"{account}.dkr.ecr.{region}.amazonaws.com"
    return [
        f"aws ecr get-login-password --region {region} | docker login --username AWS --password-stdin {registry}",
    ]


def _pull(inputs: dict[str, Any]) -> list[str]:
    image = _token("image", inputs.get("image", ""))
    digest = str(inputs.get("digest") or "")
    if not _DIGEST.match(digest):
        raise DeployError(code="ARTIFACT_UNVERIFIED", technical_message="pull requires an immutable digest")
    return [f"docker pull {image}@{digest}"]


def _stop(inputs: dict[str, Any]) -> list[str]:
    name = _token("container_name", inputs.get("container_name", ""))
    commands = [f"docker inspect {name} >/dev/null 2>&1 && docker stop {name} && docker rm {name} || true"]
    host_port = int(inputs.get("host_port") or 0)
    if host_port in {80, 443}:
        commands.append("systemctl stop nginx || true")
    return commands


def _start(inputs: dict[str, Any]) -> list[str]:
    name = _token("container_name", inputs.get("container_name", ""))
    image = _token("image", inputs.get("image", ""))
    digest = str(inputs.get("digest") or "")
    if not _DIGEST.match(digest):
        raise DeployError(code="ARTIFACT_UNVERIFIED")
    host_port = _port("host_port", inputs.get("host_port", 80))
    container_port = _port("container_port", inputs.get("container_port", 3000))
    env_file = str(inputs.get("env_file") or "")
    env_arg = ""
    if env_file:
        if not re.match(r"^/opt/deplai/[A-Za-z0-9._-]+$", env_file):
            raise DeployError(code="CONFIGURATION_ERROR", technical_message="env file must be under /opt/deplai")
        env_arg = f"--env-file {env_file}"
    return [
        (
            f"if docker inspect --format '{{{{.State.Running}}}} {{{{.Config.Image}}}}' {name} 2>/dev/null | grep -q 'true .*{digest}'; then "
            f"echo already_running; else "
            f"docker inspect {name} >/dev/null 2>&1 && docker rm -f {name} || true; "
            f"docker run -d --name {name} --restart unless-stopped "
            f"-p {host_port}:{container_port} {env_arg} {image}@{digest}; fi"
        ).replace("  ", " "),
    ]


def _inspect(inputs: dict[str, Any]) -> list[str]:
    name = _token("container_name", inputs.get("container_name", ""))
    return [
        f"docker inspect --format '{{{{.State.Running}}}} {{{{.State.Status}}}} {{{{.Config.Image}}}}' {name}"
    ]


def _port_listen(inputs: dict[str, Any]) -> list[str]:
    port = _port("host_port", inputs.get("host_port", 80))
    return [f"ss -ltn | grep -E ':{port}\\s' || netstat -ltn | grep -E ':{port}\\s'"]


def _health(inputs: dict[str, Any]) -> list[str]:
    port = _port("host_port", inputs.get("host_port", 80))
    path = str(inputs.get("health_endpoint") or "/health")
    if not _PATH.match(path):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="unsafe health path")
    expected = _port("expected_status", inputs.get("expected_status", 200))
    return [
        f"code=$(curl -s -o /dev/null -w '%{{http_code}}' --max-time 5 http://127.0.0.1:{port}{path}); "
        f"echo $code; test \"$code\" = \"{expected}\""
    ]


def _smoke(inputs: dict[str, Any]) -> list[str]:
    return _health({**inputs, "health_endpoint": inputs.get("path") or inputs.get("health_endpoint") or "/"})


_ARN = re.compile(r"^arn:aws:(secretsmanager|ssm):[a-z0-9-]+:\d{12}:.+$")
_SAFE_ENV_VALUE = re.compile(r"^[A-Za-z0-9._:/=+@,-]{0,4096}$")


def _write_env(inputs: dict[str, Any]) -> list[str]:
    path = str(inputs.get("env_file") or "/opt/deplai/app.env")
    if not re.match(r"^/opt/deplai/[A-Za-z0-9._-]+$", path):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="env file must be under /opt/deplai")
    keys = inputs.get("env") if isinstance(inputs.get("env"), dict) else {}
    pairs: list[tuple[str, str]] = []
    for key, value in keys.items():
        k = _token("env_key", str(key))
        raw = str(value)
        if not _SAFE_ENV_VALUE.match(raw) or any(ch in raw for ch in ";|&`$()<>\n"):
            raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"unsafe env value for {k}")
        pairs.append((k, raw))
    encoded = json.dumps(pairs)
    return [
        "mkdir -p /opt/deplai",
        "umask 077",
        (
            "python3 - <<'PY'\n"
            "import json, pathlib\n"
            f"pairs = json.loads({json.dumps(encoded)})\n"
            f"path = pathlib.Path({json.dumps(path)})\n"
            "path.write_text(''.join(f'{k}={v}\\n' for k, v in pairs), encoding='utf-8')\n"
            "path.chmod(0o600)\n"
            "print('wrote', len(pairs), 'config keys')\n"
            "PY"
        ),
    ]


def _resolve_secrets(inputs: dict[str, Any]) -> list[str]:
    mapping = inputs.get("secrets") if isinstance(inputs.get("secrets"), dict) else {}
    items: list[dict[str, str]] = []
    for name, arn in mapping.items():
        key = _token("secret_name", str(name))
        raw_arn = str(arn or "").strip()
        if not _ARN.match(raw_arn) or any(ch in raw_arn for ch in ";|&`$()<>"):
            raise DeployError(code="SECRET_RESOLUTION_FAILED", technical_message="unsafe secret ARN")
        items.append({"name": key, "arn": raw_arn})
    path = str(inputs.get("env_file") or "/opt/deplai/app.env")
    if not re.match(r"^/opt/deplai/[A-Za-z0-9._-]+$", path):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="env file must be under /opt/deplai")
    encoded = json.dumps(items)
    return [
        "mkdir -p /opt/deplai",
        "umask 077",
        (
            "python3 - <<'PY'\n"
            "import json, pathlib, subprocess, sys\n"
            f"items = json.loads({json.dumps(encoded)})\n"
            f"path = pathlib.Path({json.dumps(path)})\n"
            "existing = path.read_text(encoding='utf-8') if path.is_file() else ''\n"
            "lines = [line for line in existing.splitlines() if line and not line.startswith('#')]\n"
            "keys = {line.split('=', 1)[0] for line in lines if '=' in line}\n"
            "resolved = 0\n"
            "for item in items:\n"
            "    name, arn = item['name'], item['arn']\n"
            "    try:\n"
            "        raw = subprocess.check_output(\n"
            "            ['aws', 'secretsmanager', 'get-secret-value', '--secret-id', arn, '--query', 'SecretString', '--output', 'text'],\n"
            "            text=True, stderr=subprocess.DEVNULL, timeout=20,\n"
            "        ).strip()\n"
            "    except Exception:\n"
            "        sys.exit(2)\n"
            "    value = raw\n"
            "    try:\n"
            "        parsed = json.loads(raw)\n"
            "        if isinstance(parsed, dict) and name in parsed:\n"
            "            value = str(parsed[name])\n"
            "        elif isinstance(parsed, dict) and len(parsed) == 1:\n"
            "            value = str(next(iter(parsed.values())))\n"
            "    except Exception:\n"
            "        value = raw\n"
            "    lines = [line for line in lines if not line.startswith(name + '=')]\n"
            "    lines.append(name + '=' + value)\n"
            "    resolved += 1\n"
            "path.write_text('\\n'.join(lines) + ('\\n' if lines else ''), encoding='utf-8')\n"
            "path.chmod(0o600)\n"
            "print('resolved', resolved, 'secrets')\n"
            "PY"
        ),
    ]


def _collect_logs(inputs: dict[str, Any]) -> list[str]:
    name = _token("container_name", inputs.get("container_name", ""))
    return [f"docker logs --tail 80 {name} 2>&1 || true"]


REGISTRY: dict[str, Operation] = {
    "discover_host": Operation("discover_host", 30, True, True, _discover),
    "prepare_runtime": Operation("prepare_runtime", 180, True, True, _prepare_docker),
    "authenticate_registry": Operation("authenticate_registry", 60, True, True, _ecr_login),
    "pull_artifact": Operation("pull_artifact", 300, True, True, _pull),
    "inspect_digest": Operation("inspect_digest", 30, True, True, _inspect_digest),
    "stop_previous_version": Operation("stop_previous_version", 60, False, True, _stop),
    "start_application": Operation("start_application", 60, False, True, _start),
    "verify_container": Operation("verify_container", 20, True, True, _inspect),
    "verify_port": Operation("verify_port", 20, True, True, _port_listen),
    "health_check": Operation("health_check", 20, True, True, _health),
    "smoke_test": Operation("smoke_test", 20, True, True, _smoke),
    "render_runtime_configuration": Operation("render_runtime_configuration", 30, False, True, _write_env),
    "resolve_secrets": Operation("resolve_secrets", 60, True, True, _resolve_secrets),
    "collect_logs": Operation("collect_logs", 20, True, True, _collect_logs),
}


def render_operation(name: str, inputs: dict[str, Any]) -> list[str]:
    op = REGISTRY.get(name)
    if op is None:
        raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"unknown operation {name}")
    return op.render(inputs or {})


def get_operation(name: str) -> Operation:
    op = REGISTRY.get(name)
    if op is None:
        raise DeployError(code="CONFIGURATION_ERROR", technical_message=f"unknown operation {name}")
    return op

from __future__ import annotations

import json
import re
from typing import Any

from deploy_exec.contract import NetworkSpec
from deploy_exec.errors import DeployError

MIN_DISK_KB = 512 * 1024
MIN_MEMORY_KB = 200 * 1024


def parse_capabilities(stdout: str) -> dict[str, Any]:
    text = str(stdout or "").strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {}
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _int(value: Any) -> int:
    try:
        return int(re.sub(r"[^0-9-]", "", str(value or "0")) or 0)
    except (TypeError, ValueError):
        return 0


def evaluate_ready(
    capabilities: dict[str, Any],
    network: NetworkSpec | None = None,
    *,
    require_port_free: bool = False,
) -> dict[str, Any]:
    docker_installed = bool(capabilities.get("docker_installed"))
    docker_running = bool(capabilities.get("docker_running"))
    disk_kb = _int(capabilities.get("disk_kb") or capabilities.get("disk_available"))
    memory_kb = _int(capabilities.get("memory_kb") or capabilities.get("memory_available"))
    ssm_connected = bool(capabilities.get("ssm_connected", True))
    reasons: list[str] = []
    if not ssm_connected:
        reasons.append("SSM is not connected")
    if not docker_installed:
        reasons.append("Docker is not installed")
    if docker_installed and not docker_running:
        reasons.append("Docker is not running")
    if disk_kb and disk_kb < MIN_DISK_KB:
        reasons.append("insufficient disk")
    if memory_kb and memory_kb < MIN_MEMORY_KB:
        reasons.append("insufficient memory")
    if require_port_free and network is not None and capabilities.get("port_busy"):
        reasons.append(f"port {network.host_port} is in use")
    return {
        "ready": len(reasons) == 0,
        "can_prepare": (not docker_installed or not docker_running) and ssm_connected,
        "reasons": reasons,
        "docker_installed": docker_installed,
        "docker_running": docker_running,
        "disk_kb": disk_kb,
        "memory_kb": memory_kb,
        "ssm_connected": ssm_connected,
    }


def require_ready(report: dict[str, Any]) -> None:
    if report.get("ready"):
        return
    reasons = list(report.get("reasons") or [])
    if any("Docker" in item for item in reasons) and not report.get("can_prepare"):
        raise DeployError(code="DOCKER_NOT_AVAILABLE", technical_message="; ".join(reasons))
    if any("disk" in item for item in reasons):
        raise DeployError(code="CONFIGURATION_ERROR", technical_message="; ".join(reasons))
    if any("port" in item for item in reasons):
        raise DeployError(code="PORT_CONFLICT", technical_message="; ".join(reasons))
    if not report.get("can_prepare"):
        raise DeployError(code="DOCKER_NOT_AVAILABLE", technical_message="; ".join(reasons))

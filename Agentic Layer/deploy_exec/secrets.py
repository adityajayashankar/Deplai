from __future__ import annotations

from typing import Any

from deploy_exec.contract import DeploymentContract, SecretReference
from deploy_exec.errors import DeployError


def references_from_contract(contract: DeploymentContract) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for item in contract.secret_references:
        if not isinstance(item, SecretReference):
            continue
        mapping[item.name] = item.arn
    extra = (contract.configuration or {}).get("secret_references")
    if isinstance(extra, dict):
        for key, value in extra.items():
            if isinstance(value, str) and value.startswith("arn:aws:"):
                mapping[str(key)] = value
            elif isinstance(value, dict) and value.get("arn"):
                mapping[str(key)] = str(value["arn"])
    return mapping


def non_secret_config(contract: DeploymentContract) -> dict[str, str]:
    blocked = {"secret_references", "secrets", "password", "token"}
    out: dict[str, str] = {}
    for key, value in (contract.configuration or {}).items():
        if str(key).lower() in blocked or "secret" in str(key).lower():
            continue
        if isinstance(value, (str, int, float, bool)):
            out[str(key)] = str(value)
    return out


def classify_secret_failure(exc: Exception) -> DeployError:
    return DeployError(code="SECRET_RESOLUTION_FAILED", technical_message=str(exc)[:300])

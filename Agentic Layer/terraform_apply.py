"""Runtime Terraform apply helper.

Applies generated Terraform files in an ephemeral Docker volume using the
hashicorp/terraform image and returns Terraform outputs.
"""

from __future__ import annotations

import ast
import base64
import io
import json
import os
import re
import secrets
import sys
import tarfile
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from docker.errors import ContainerError

from utils import decode_output, ensure_docker_image, get_docker_client

TERRAFORM_IMAGE = "hashicorp/terraform:1.9.0"
# Docker Desktop's embedded resolver (192.168.65.7) can fail mid-apply
# ("no such host" for rds.<region>.amazonaws.com). Public resolvers keep
# long RDS/ElastiCache waits from dying on a transient lookup.
_TERRAFORM_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"]
_EC2_STANDARD_FAMILY_PREFIXES = {"a", "c", "d", "h", "i", "m", "r", "t", "z"}
_EC2_STANDARD_ONDEMAND_VCPU_QUOTA_CODE = "L-1216C47A"
_SAFE_EC2_INSTANCE_ORDER = ["t3.micro", "t2.micro", "t3a.micro", "t3.small", "t2.small"]
_DEFAULT_FREE_TIER_INSTANCE_ORDER = ["t3.micro", "t2.micro"]
_REQUIRED_IAM_POLICY_HINTS = [
    "ec2:*",
    "vpc:*",
    "s3:*",
    "dynamodb:*",
    "iam:CreateInstanceProfile",
    "iam:AddRoleToInstanceProfile",
    "ssm:*",
]
_REQUIRED_ACTIONS_BY_POLICY = {
    "ec2:*": ["ec2:RunInstances"],
    "vpc:*": ["ec2:CreateVpc"],
    "s3:*": ["s3:CreateBucket"],
    "dynamodb:*": ["dynamodb:CreateTable"],
    "iam:CreateInstanceProfile": ["iam:CreateInstanceProfile"],
    "iam:AddRoleToInstanceProfile": ["iam:AddRoleToInstanceProfile"],
    "ssm:*": ["ssm:DescribeInstanceInformation"],
}


def _ensure_agent_import_path() -> None:
    candidates = [
        Path(__file__).resolve().parents[1],
        Path("/app"),
    ]
    for candidate in candidates:
        if not candidate.exists():
            continue
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


def _parse_instance_types(raw: str | None, fallback: list[str]) -> list[str]:
    values = [str(v or "").strip().lower() for v in str(raw or "").split(",")]
    normalized = [v for v in values if re.match(r"^[a-z0-9]+\.[a-z0-9]+$", v)]
    if not normalized:
        return [*fallback]
    deduped: list[str] = []
    seen: set[str] = set()
    for value in normalized:
        if value in seen:
            continue
        deduped.append(value)
        seen.add(value)
    return deduped


_FREE_TIER_EC2_INSTANCE_ORDER = _parse_instance_types(
    os.getenv("DEPLAI_FREE_TIER_EC2_TYPES"),
    _DEFAULT_FREE_TIER_INSTANCE_ORDER,
)


def _normalize_rel_path(path: str) -> str:
    normalized = str(PurePosixPath(str(path or "").replace("\\", "/"))).strip()
    if not normalized or normalized in {".", "/"}:
        raise ValueError("Invalid file path")
    if normalized.startswith("/"):
        raise ValueError("Absolute paths are not allowed")
    if ".." in PurePosixPath(normalized).parts:
        raise ValueError("Parent directory traversal is not allowed")
    return normalized


def _emit_progress(apply_context: dict[str, Any] | None, msg_type: str, content: str) -> None:
    if not apply_context:
        return
    emitter = apply_context.get("emit")
    if not callable(emitter):
        return
    try:
        emitter(str(msg_type or "info"), str(content or "").strip())
    except Exception:
        pass


def _redact_sensitive_text(text: str, secrets: list[str]) -> str:
    redacted = str(text or "")
    for secret in secrets:
        token = str(secret or "").strip()
        if not token:
            continue
        redacted = redacted.replace(token, "***")
    return redacted


def _parse_plan_change_counts(plan_output: str) -> dict[str, int]:
    match = re.search(
        r"Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy",
        str(plan_output or ""),
        flags=re.IGNORECASE,
    )
    if not match:
        return {"add": 0, "change": 0, "destroy": 0}
    return {
        "add": int(match.group(1) or 0),
        "change": int(match.group(2) or 0),
        "destroy": int(match.group(3) or 0),
    }


def _summarize_ec2_plan_changes(plan_payload: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "resources": [],
        "add": 0,
        "change": 0,
        "destroy": 0,
        "replace": 0,
        "no_op": 0,
        "has_managed_ec2": False,
        "expects_ec2_create_or_replace": False,
    }
    if not isinstance(plan_payload, dict):
        return summary

    resources: list[dict[str, Any]] = []
    for item in plan_payload.get("resource_changes") or []:
        if not isinstance(item, dict):
            continue
        resource_type = str(item.get("type") or "").strip()
        address = str(item.get("address") or "").strip()
        if resource_type != "aws_instance" and "aws_instance." not in address:
            continue

        change = item.get("change") if isinstance(item.get("change"), dict) else {}
        actions = [
            str(action or "").strip()
            for action in (change.get("actions") if isinstance(change, dict) else []) or []
            if str(action or "").strip()
        ]
        if not actions:
            actions = ["unknown"]

        action_set = set(actions)
        if action_set == {"no-op"}:
            summary["no_op"] += 1
        if "create" in action_set and "delete" in action_set:
            summary["replace"] += 1
        elif "create" in action_set:
            summary["add"] += 1
        elif "update" in action_set:
            summary["change"] += 1
        elif "delete" in action_set:
            summary["destroy"] += 1

        resources.append({"address": address, "actions": actions})

    summary["resources"] = resources
    summary["has_managed_ec2"] = bool(resources)
    summary["expects_ec2_create_or_replace"] = any(
        "create" in set(resource.get("actions") or [])
        for resource in resources
    )
    return summary


def _policy_source_arn(identity_arn: str) -> str:
    arn = str(identity_arn or "").strip()
    assumed = re.match(r"^arn:aws:sts::(\d+):assumed-role/([^/]+)/[^/]+$", arn)
    if assumed:
        return f"arn:aws:iam::{assumed.group(1)}:role/{assumed.group(2)}"
    return arn


def _decode_file_payload(item: dict[str, Any], rel_path: str) -> bytes:
    encoding = str(item.get("encoding") or "utf-8").strip().lower()
    content = item.get("content", "")
    content_text = str(content)
    if encoding == "base64":
        try:
            return base64.b64decode(content_text.encode("ascii"), validate=True)
        except Exception as exc:
            raise ValueError(f"Invalid base64 content for {rel_path}: {exc}") from exc
    return content_text.encode("utf-8")


def _write_files_to_volume(volume_name: str, files: list[dict[str, Any]]) -> None:
    docker = get_docker_client()
    container = docker.containers.create(
        "alpine",
        command=["sh", "-lc", "sleep 120"],
        volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
    )
    tar_buffer = io.BytesIO()

    try:
        with tarfile.open(fileobj=tar_buffer, mode="w") as archive:
            for item in files:
                rel_path = _normalize_rel_path(str(item.get("path", "")))
                payload = _decode_file_payload(item, rel_path)
                info = tarfile.TarInfo(name=rel_path)
                info.size = len(payload)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(payload))

        tar_buffer.seek(0)
        container.start()
        ok = container.put_archive("/workspace", tar_buffer.getvalue())
        if not ok:
            raise RuntimeError("Failed to stage Terraform files into runtime workspace.")
    finally:
        try:
            container.remove(force=True)
        except Exception:
            pass


def _terraform_run_kwargs(volume_name: str, env: dict[str, str]) -> dict[str, Any]:
    return {
        "environment": env,
        "volumes": {volume_name: {"bind": "/workspace", "mode": "rw"}},
        "dns": list(_TERRAFORM_DNS_SERVERS),
    }


def _run_terraform(volume_name: str, tf_root: str, args: list[str], env: dict[str, str]) -> str:
    ensure_docker_image(TERRAFORM_IMAGE)
    output = get_docker_client().containers.run(
        TERRAFORM_IMAGE,
        command=[f"-chdir={tf_root}", *args],
        remove=True,
        **_terraform_run_kwargs(volume_name, env),
    )
    return decode_output(output)


def _run_terraform_with_tracking(
    volume_name: str,
    tf_root: str,
    args: list[str],
    env: dict[str, str],
    apply_context: dict[str, Any] | None = None,
) -> str:
    if apply_context and apply_context.get("cancel_requested"):
        raise RuntimeError("Terraform apply cancelled by user.")

    primary = str(args[0] if args else "terraform").strip() or "terraform"
    _emit_progress(apply_context, "info", f"Running terraform {primary}...")

    ensure_docker_image(TERRAFORM_IMAGE)
    docker = get_docker_client()
    container = docker.containers.create(
        TERRAFORM_IMAGE,
        command=[f"-chdir={tf_root}", *args],
        **_terraform_run_kwargs(volume_name, env),
    )
    if apply_context is not None:
        apply_context["container_id"] = container.id

    try:
        container.start()
        
        log_chunks = []
        current_line = []
        for chunk_bytes in container.logs(stream=True, stdout=True, stderr=True):
            chunk_str = chunk_bytes.decode("utf-8", errors="replace")
            log_chunks.append(chunk_str)
            for char in chunk_str:
                if char == "\n":
                    line_str = "".join(current_line).strip()
                    if line_str:
                        _emit_progress(apply_context, "info", f"[{primary}] {line_str}")
                    current_line.clear()
                else:
                    current_line.append(char)
                    
        if current_line:
            line_str = "".join(current_line).strip()
            if line_str:
                _emit_progress(apply_context, "info", f"[{primary}] {line_str}")
                
        result = container.wait()
        logs = "".join(log_chunks)
        if isinstance(result, dict):
            raw_status = result.get("StatusCode")
        else:
            raw_status = result
        try:
            status_code = int(raw_status)
        except Exception:
            status_code = 1
        if status_code != 0:
            _emit_progress(apply_context, "error", f"terraform {primary} failed.")
            raise RuntimeError(logs or f"terraform command failed (exit {status_code})")
        _emit_progress(apply_context, "success", f"terraform {primary} completed.")
        return logs
    finally:
        if apply_context is not None:
            apply_context["container_id"] = None
        try:
            container.remove(force=True)
        except Exception:
            pass


def _required_policy_hints(include_rds: bool = False) -> list[str]:
    hints = list(_REQUIRED_IAM_POLICY_HINTS)
    if include_rds:
        hints.append("rds:*")
    return hints


def _run_iam_permission_preflight(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str,
    aws_region: str,
    include_rds: bool = False,
) -> dict[str, Any]:
    required_actions = dict(_REQUIRED_ACTIONS_BY_POLICY)
    if include_rds:
        required_actions["rds:*"] = ["rds:CreateDBInstance"]

    required_policy_hints = list(required_actions.keys())
    session = boto3.session.Session(
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
        aws_session_token=aws_session_token or None,
        region_name=aws_region,
    )
    sts = session.client("sts", region_name=aws_region)
    identity = sts.get_caller_identity()
    account_id = str(identity.get("Account") or "").strip()
    identity_arn = str(identity.get("Arn") or "").strip()

    if ":root" in identity_arn:
        return {
            "ok": True,
            "identity_arn": identity_arn,
            "account_id": account_id,
            "policy_source_arn": None,
            "missing_policies": [],
            "required_policies": required_policy_hints,
            "simulated_actions": {},
            "skipped_simulation": True,
            "warning": "Running as root user - skipping IAM simulation. Use an IAM user for deploys.",
        }

    source_arn = _policy_source_arn(identity_arn)

    iam = session.client("iam", region_name=aws_region)
    action_names = [action for actions in required_actions.values() for action in actions]
    try:
        simulated = iam.simulate_principal_policy(
            PolicySourceArn=source_arn,
            ActionNames=action_names,
        )
    except Exception as exc:
        return {
            "ok": False,
            "identity_arn": identity_arn,
            "account_id": account_id,
            "policy_source_arn": source_arn,
            "missing_policies": required_policy_hints,
            "reason": (
                "Unable to verify IAM permissions with simulate_principal_policy. "
                f"Attach required policies and optionally allow iam:SimulatePrincipalPolicy. Root cause: {exc}"
            ),
        }

    decisions: dict[str, str] = {}
    for item in simulated.get("EvaluationResults") or []:
        action = str(item.get("EvalActionName") or "").strip()
        decision = str(item.get("EvalDecision") or "").strip().lower()
        if action:
            decisions[action] = decision

    missing_policies: list[str] = []
    for policy_name, actions in required_actions.items():
        if not all(decisions.get(action, "") == "allowed" for action in actions):
            missing_policies.append(policy_name)

    return {
        "ok": len(missing_policies) == 0,
        "identity_arn": identity_arn,
        "account_id": account_id,
        "policy_source_arn": source_arn,
        "missing_policies": missing_policies,
        "required_policies": required_policy_hints,
        "simulated_actions": decisions,
    }


def _tail(text: str, limit: int = 3000) -> str:
    value = text or ""
    if len(value) <= limit:
        return value
    return value[-limit:]


def _nonempty_output_string(outputs: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = outputs.get(key)
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned:
                return cleaned
    return None


def _ec2_output_evidence(outputs: dict[str, Any]) -> dict[str, str]:
    evidence: dict[str, str] = {}
    for keys in (
        ["ec2_instance_id", "instance_id"],
        ["ec2_instance_arn", "instance_arn"],
        ["ec2_public_ip", "public_ip", "instance_public_ip"],
        ["ec2_private_ip", "private_ip", "instance_private_ip"],
        ["ec2_public_dns", "public_dns", "instance_public_dns"],
        ["ec2_private_dns", "private_dns", "instance_private_dns"],
    ):
        value = _nonempty_output_string(outputs, keys)
        if value:
            evidence[keys[0]] = value
    return evidence


def _friendly_terraform_error(combined_output: str) -> str:
    text = combined_output or ""
    if "VcpuLimitExceeded" in text:
        return (
            " AWS EC2 vCPU quota was exceeded for the selected instance family bucket. "
            "Action: terminate/stop unused EC2 instances in that bucket, or request a quota "
            "increase via AWS Service Quotas / EC2 limits, then retry deployment."
        )
    if "InsufficientInstanceCapacity" in text:
        return (
            " AWS reported insufficient instance capacity for the selected type/AZ. "
            "Action: retry with a different instance type or region/AZ."
        )
    if "VpcLimitExceeded" in text:
        return (
            " AWS account reached VPC quota. Regenerate Terraform with default-VPC mode "
            "and redeploy, or clean up unused VPCs in the selected region."
        )
    return ""


def _is_vcpu_quota_error(text: str) -> bool:
    return "VcpuLimitExceeded" in (text or "")


def _is_capacity_error(text: str) -> bool:
    value = (text or "").lower()
    return (
        "insufficientinstancecapacity" in value
        or "not supported in your requested availability zone" in value
        or ("insufficient capacity" in value and "availability zone" in value)
    )


def _is_transient_aws_api_error(text: str) -> bool:
    """True when Terraform lost the AWS API (DNS/network), not a real AWS deny."""
    lowered = str(text or "").lower()
    if not lowered:
        return False
    if any(
        marker in lowered
        for marker in (
            "unauthorizedoperation",
            "accessdenied",
            "invalidclienttokenid",
            "expiredtoken",
            "authfailure",
            "vcpulimitexceeded",
            "vpclimitexceeded",
        )
    ):
        return False
    needles = (
        "no such host",
        "temporary failure in name resolution",
        "server misbehaving",
        "i/o timeout",
        "tls handshake timeout",
        "connection reset by peer",
        "network is unreachable",
        "request send failed",
        "dial tcp",
        "wsarecv",
    )
    if any(needle in lowered for needle in needles):
        return True
    return "lookup " in lowered and ":53" in lowered


def _transient_aws_api_error_message(text: str) -> str:
    match = re.search(r"RDS DB Instance \(([^)]+)\)", text or "", flags=re.IGNORECASE)
    rds_id = match.group(1).strip() if match else ""
    resource = f"RDS instance {rds_id}" if rds_id else "a resource"
    return (
        f"Terraform lost connectivity to the AWS API while waiting for {resource} to finish "
        "creating (Docker DNS lookup failed). Resources created before this failure remain in "
        "remote state. Click Redeploy to resume apply — do not destroy."
    )


def _is_orphan_key_pair_collision(text: str) -> bool:
    value = text or ""
    return "InvalidKeyPair.Duplicate" in value or (
        "aws_key_pair" in value and "already exists" in value.lower()
    )


def _is_orphan_alb_collision(text: str) -> bool:
    value = (text or "").lower()
    return (
        ("load balancer" in value or "aws_lb" in value or "elbv2" in value)
        and "already exists" in value
    )


def _extract_duplicate_key_pair_name(text: str) -> str | None:
    match = re.search(
        r"ImportKeyPair.*?KeyPair[^\n]*?\(([^)]+)\)|key pair[:\s]+([A-Za-z0-9._/-]+)|InvalidKeyPair\.Duplicate[^\n]*?([A-Za-z0-9._/-]+-key)",
        text or "",
        flags=re.IGNORECASE,
    )
    if not match:
        match = re.search(r"EC2 Key Pair \(([^)]+)\)", text or "", flags=re.IGNORECASE)
    if not match:
        return None
    for group in match.groups():
        if group and str(group).strip():
            return str(group).strip()
    return None


def _extract_duplicate_alb_name(text: str) -> str | None:
    match = re.search(
        r"Load Balancer \(([^)]+)\) already exists|ELBv2 Load Balancer \(([^)]+)\) already exists",
        text or "",
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    for group in match.groups():
        if group and str(group).strip():
            return str(group).strip()
    return None


def _orphan_collision_remediation(
    *,
    key_name: str | None,
    alb_name: str | None,
    aws_region: str,
) -> dict[str, Any]:
    """Structured Option A (import/adopt) vs Option B (delete orphan) guidance."""
    key = key_name or "<project>-<env>-key"
    alb = alb_name or "<project>-<env>-alb"
    return {
        "class": "state_aws_divergence",
        "summary": (
            "Static-named resources already exist in AWS but are missing from the current "
            "Terraform state (typical after a partial apply)."
        ),
        "option_a_adopt": {
            "description": "Import existing resources into state (no AWS deletes).",
            "commands": [
                f"aws ec2 describe-key-pairs --key-names {key} --region {aws_region}",
                (
                    f"aws elbv2 describe-load-balancers --names {alb} --region {aws_region} "
                    "--query LoadBalancers[0].LoadBalancerArn --output text"
                ),
                f"terraform import 'module.compute.aws_key_pair.generated[0]' {key}",
                "terraform import 'module.compute.module.alb[0].aws_lb.this[0]' <alb-arn>",
                "terraform plan  # review drift before apply",
            ],
            "note": (
                "Do not import or reuse an existing AWS key pair. AWS never stores the private "
                "half, so DeplAI cannot give the user a PEM. Mint a new key with ec2_key_rotation."
            ),
        },
        "option_b_delete_orphans": {
            "description": "Delete orphans only if they are not serving live traffic, then re-apply.",
            "commands": [
                f"aws ec2 delete-key-pair --key-name {key} --region {aws_region}",
                f"aws elbv2 delete-load-balancer --load-balancer-arn <alb-arn> --region {aws_region}",
            ],
        },
        "prevention": [
            "Keep S3 remote state + DynamoDB lock enabled (already used by enterprise bundles).",
            "ALB names are VPC-suffixed to avoid colliding with orphans from a prior VPC.",
            "Each deploy mints a new EC2 key pair named with a rotation suffix and tagged with the instance ID.",
        ],
    }


def _rotated_az_orders(preferred_azs: list[str]) -> list[list[str]]:
    normalized: list[str] = []
    seen: set[str] = set()
    for az in preferred_azs:
        value = str(az or "").strip().lower()
        if not value or value in seen:
            continue
        normalized.append(value)
        seen.add(value)
    if len(normalized) <= 1:
        return []
    return [normalized[idx:] + normalized[:idx] for idx in range(1, len(normalized))]


def _missing_enable_ec2_var(text: str) -> bool:
    value = text or ""
    return (
        'does not declare a variable named "enable_ec2"' in value
        or "undeclared input variable" in value and "enable_ec2" in value
    )


def _extract_text_payload(item: dict[str, Any]) -> str:
    rel_path = _normalize_rel_path(str(item.get("path", "")))
    payload = _decode_file_payload(item, rel_path)
    try:
        return payload.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _set_text_payload(item: dict[str, Any], text: str) -> dict[str, Any]:
    updated = dict(item)
    encoding = str(updated.get("encoding") or "utf-8").strip().lower()
    if encoding == "base64":
        updated["content"] = base64.b64encode(str(text or "").encode("utf-8")).decode("ascii")
        updated["encoding"] = "base64"
    else:
        updated["content"] = str(text or "")
        updated["encoding"] = "utf-8"
    return updated


def rewrite_ec2_module_v5_compat(text: str) -> tuple[str, bool]:
    """Normalize enterprise EC2 module HCL for terraform-aws-modules/ec2-instance v5.x.

    Prefers the internal registry contract implementation when available.
    """
    try:
        from terraform_agent.agent.internal_registry import (
            rewrite_ec2_module_v5_compat as _registry_rewrite,
        )

        return _registry_rewrite(text)
    except Exception:
        pass

    if not text or 'module "ec2"' not in text:
        return text, False

    # Patch only content before module "alb" so ALB create_security_group stays intact.
    parts = re.split(r'(?=module\s+"alb"\s*\{)', text, maxsplit=1)
    head = parts[0]
    tail = parts[1] if len(parts) > 1 else ""
    updated = head
    changed = False

    stripped = re.sub(r'(?m)^\s*create_security_group\s*=\s*(?:true|false)\s*\r?\n', "", updated)
    if stripped != updated:
        updated = stripped
        changed = True

    if not re.search(r"root_block_device\s*=\s*\[", updated):
        rewritten = re.sub(
            r"(root_block_device\s*=\s*)\{(\s*(?:\r?\n[ \t]+[A-Za-z0-9_]+\s*=\s*[^\n]+)+\s*\r?\n[ \t]*)\}",
            r"\1[{\2}]",
            updated,
            count=1,
        )
        if rewritten != updated:
            updated = rewritten
            changed = True

    if not changed:
        return text, False
    return updated + tail, True


_ARTIFACTS_POLICY_COUNT_PATTERN = re.compile(
    r'(?m)^(\s*count\s*=\s*)var\.enabled\s*&&\s*trimspace\(\s*var\.instance_role_name\s*\)\s*!=\s*""\s*\?\s*1\s*:\s*0\s*$'
)


def rewrite_artifacts_iam_policy_count_known_at_plan(text: str) -> tuple[str, bool]:
    """Make artifacts IAM policy count known at plan (role name is apply-time)."""
    _ensure_agent_import_path()
    try:
        from terraform_agent.agent.internal_registry import (
            rewrite_artifacts_iam_policy_count_known_at_plan as _registry_rewrite,
        )

        return _registry_rewrite(text)
    except Exception:
        pass
    if not text or "instance_role_name" not in text:
        return text, False
    rewritten, n = _ARTIFACTS_POLICY_COUNT_PATTERN.subn(r"\1var.enabled ? 1 : 0", text)
    return (rewritten, True) if n else (text, False)


def enforce_registry_contracts(files: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply internal-registry contracts across all .tf files in a bundle."""
    remediation: dict[str, Any] = {
        "ec2_module_v5_compat_rewritten": False,
        "registry_contract_files": 0,
    }
    _ensure_agent_import_path()
    try:
        from terraform_agent.agent.internal_registry import enforce_registry_contracts_on_text
    except Exception:
        enforce_registry_contracts_on_text = None  # type: ignore[assignment]

    patched = [dict(item) for item in files]
    for idx, item in enumerate(patched):
        path = str(item.get("path") or "").replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        text = _extract_text_payload(item)
        if enforce_registry_contracts_on_text is not None:
            new_text, details = enforce_registry_contracts_on_text(text)
        else:
            new_text, changed = rewrite_ec2_module_v5_compat(text)
            details = {"ec2_module_v5_compat_rewritten": changed}
            new_text, artifacts_count = rewrite_artifacts_iam_policy_count_known_at_plan(new_text)
            if artifacts_count:
                details["artifacts_policy_count_known_at_plan"] = True
        if new_text != text:
            patched[idx] = _set_text_payload(item, new_text)
            remediation["registry_contract_files"] += 1
        if details.get("ec2_module_v5_compat_rewritten"):
            remediation["ec2_module_v5_compat_rewritten"] = True
        if details.get("ec2_count_ungated_from_key_reuse"):
            remediation["ec2_count_ungated_from_key_reuse"] = True
        if details.get("artifacts_policy_count_known_at_plan"):
            remediation["artifacts_policy_count_known_at_plan"] = True
        if details.get("ec2_version_drift"):
            remediation["ec2_version_drift"] = details["ec2_version_drift"]
    return patched, remediation


def _legacy_runtime_bundle_needs_remediation(files: list[dict[str, Any]]) -> bool:
    versions_provider = False
    providers_provider = False
    has_aws_region_var = False
    has_region_var = False
    has_var_region_reference = False
    has_al2023_ami_reference = False
    has_al2023_ami_data = False
    tfvars_environment_alias = re.compile(r'(?mi)^\s*environment\s*=\s*"?(production|development)"?\s*$')
    tfvars_compute_strategy_alias = re.compile(
        r'(?mi)^\s*compute_strategy\s*=\s*"?(ec2-instance|cloudfront|s3cloudfront)"?\s*$'
    )
    single_line_variable_block = re.compile(
        r'variable\s+"[^"]+"\s*\{\s*type\s*=\s*[^{}\n]+,\s*default\s*=\s*[^{}\n]+\s*\}'
    )
    conditional_depends_on = re.compile(r"depends_on\s*=\s*[^\n]*\?")

    for item in files:
        path = _normalize_rel_path(str(item.get("path", ""))).lower()
        text = _extract_text_payload(item)
        if path.endswith(".tfvars") and (
            tfvars_environment_alias.search(text) or tfvars_compute_strategy_alias.search(text)
        ):
            return True
        if not path.endswith(".tf"):
            continue
        if _terraform_has_variable(text, "aws_region"):
            has_aws_region_var = True
        if _terraform_has_variable(text, "region"):
            has_region_var = True
        if path == "terraform/versions.tf" and 'provider "aws"' in text:
            versions_provider = True
        if path == "terraform/providers.tf" and 'provider "aws"' in text:
            providers_provider = True
        if "var.region" in text:
            has_var_region_reference = True
        if "data.aws_ami.al2023.id" in text:
            has_al2023_ami_reference = True
        if 'data "aws_ami" "al2023"' in text:
            has_al2023_ami_data = True
        if 'variable "desired_log_group_name" {{' in text or 'variable "log_group_override" {{' in text:
            return True
        if single_line_variable_block.search(text):
            return True
        if conditional_depends_on.search(text):
            return True
        if 'resource "aws_key_pair" "generated"' in text and (
            "use_existing_key" in text
            or (
                re.search(
                    r'key_name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-key"',
                    text,
                )
                and "ec2_key_rotation" not in text
            )
        ):
            return True
        if 'module "ec2"' in text and (
            re.search(r"(?m)^\s*create_security_group\s*=", text.split('module "alb"')[0])
            or (
                re.search(r"root_block_device\s*=\s*\{", text)
                and not re.search(r"root_block_device\s*=\s*\[", text)
            )
            or re.search(
                r'module\s+"ec2"\s*\{[\s\S]*?count\s*=\s*var\.enabled\s*&&\s*!local\.use_existing_key',
                text,
                flags=re.IGNORECASE,
            )
        ):
            return True
        if _ARTIFACTS_POLICY_COUNT_PATTERN.search(text):
            return True

    if has_al2023_ami_reference and not has_al2023_ami_data:
        return True
    if has_var_region_reference and has_aws_region_var and not has_region_var:
        return True
    return versions_provider and providers_provider


def _remediate_legacy_runtime_bundle(
    files: list[dict[str, Any]], apply_context: dict[str, Any] | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tf_indexes: list[int] = []
    tf_texts: dict[int, str] = {}
    for idx, item in enumerate(files):
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        tf_indexes.append(idx)
        tf_texts[idx] = _extract_text_payload(item)

    if not tf_indexes:
        return files, {}

    combined = "\n".join(tf_texts[idx] for idx in tf_indexes)
    patched_files = [dict(item) for item in files]
    remediation: dict[str, Any] = {
        "legacy_ami_replaced": False,
        "legacy_al2023_ami_data_added": False,
        "legacy_alb_subnets_patched": False,
        "legacy_subnet_clone_added": False,
        "legacy_route_assoc_clone_added": False,
        "legacy_user_data_join_newline_fixed": False,
        "legacy_user_data_bootstrap_quote_fixed": False,
        "legacy_database_module_source_rewritten": False,
        "legacy_storage_stub_added": False,
        "legacy_base64_default_rewritten": False,
        "legacy_inline_blocks_rewritten": False,
        "legacy_key_pair_reuse_support_added": False,
        "legacy_ec2_count_ungated_from_key_reuse": False,
        "unique_ec2_key_rotation_var_added": False,
        "legacy_iam_name_collision_rewritten": False,
        "legacy_versions_provider_deduped": False,
        "legacy_conditional_depends_on_rewritten": False,
        "legacy_single_line_variable_blocks_rewritten": False,
        "legacy_provider_region_var_rewritten": False,
        "legacy_tfvars_environment_canonicalized": False,
        "legacy_tfvars_compute_strategy_canonicalized": False,
        "legacy_nginx_ingress_port_fixed": False,
        "ec2_module_v5_compat_rewritten": False,
        "artifacts_policy_count_known_at_plan": False,
    }

    normalized_paths = {
        idx: _normalize_rel_path(str(item.get("path", "")))
        for idx, item in enumerate(files)
        if str(item.get("path", "")).strip()
    }

    def _upsert_file(path: str, content: str, encoding: str = "utf-8") -> None:
        normalized = _normalize_rel_path(path)
        for index, existing_path in normalized_paths.items():
            if existing_path == normalized:
                patched_files[index] = _set_text_payload(patched_files[index], content)
                return
        patched_files.append({
            "path": normalized,
            "content": content,
            "encoding": encoding,
        })

    def _normalize_tfvars_aliases(text: str) -> str:
        updated = text
        env_rewrites = (
            (r'(?mi)^(\s*environment\s*=\s*)"production"(\s*)$', r'\1"prod"\2'),
            (r'(?mi)^(\s*environment\s*=\s*)"development"(\s*)$', r'\1"dev"\2'),
        )
        for pattern, replacement in env_rewrites:
            rewritten = re.sub(pattern, replacement, updated)
            if rewritten != updated:
                updated = rewritten
                remediation["legacy_tfvars_environment_canonicalized"] = True

        strategy_rewrites = (
            (r'(?mi)^(\s*compute_strategy\s*=\s*)"ec2-instance"(\s*)$', r'\1"ec2"\2'),
            (r'(?mi)^(\s*compute_strategy\s*=\s*)"cloudfront"(\s*)$', r'\1"s3_cloudfront"\2'),
            (r'(?mi)^(\s*compute_strategy\s*=\s*)"s3cloudfront"(\s*)$', r'\1"s3_cloudfront"\2'),
        )
        for pattern, replacement in strategy_rewrites:
            rewritten = re.sub(pattern, replacement, updated)
            if rewritten != updated:
                updated = rewritten
                remediation["legacy_tfvars_compute_strategy_canonicalized"] = True
        return updated

    def _rewrite_bootstrap_default(text: str) -> str:
        pattern = re.compile(
            r'default\s*=\s*base64encode\((?P<literal>"(?:[^"\\]|\\.)*")\)',
            flags=re.DOTALL,
        )

        def _replace(match: re.Match[str]) -> str:
            literal = str(match.group("literal") or "")
            try:
                decoded = ast.literal_eval(literal)
            except Exception:
                return match.group(0)
            encoded = base64.b64encode(str(decoded).encode("utf-8")).decode("ascii")
            remediation["legacy_base64_default_rewritten"] = True
            return f'default = "{encoded}"'

        return pattern.sub(_replace, text)

    def _rewrite_known_inline_blocks(text: str) -> str:
        replacements = {
            'ingress { from_port = var.app_port to_port = var.app_port protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }': """ingress {
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }""",
            'ingress { from_port = 22 to_port = 22 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }': """ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }""",
            'egress  { from_port = 0 to_port = 0 protocol = "-1" cidr_blocks = ["0.0.0.0/0"] }': """egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }""",
            'output "generated_ec2_private_key_pem" { value = try(tls_private_key.generated[0].private_key_pem, null) sensitive = true }': """output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}""",
            'variable "bootstrap_index_html_base64" { type = string sensitive = true }': """variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}""",
            'principals { type = "Service" identifiers = ["ec2.amazonaws.com"] }': """principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }""",
            'data "aws_vpc" "default" { count = var.use_existing_vpc ? 1 : 0 default = true }': """data "aws_vpc" "default" {
  count   = var.use_existing_vpc ? 1 : 0
  default = true
}""",
            'filter { name = "vpc-id" values = [data.aws_vpc.default[0].id] }': """filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }""",
            'filter { name = "name" values = ["al2023-ami-2023*-x86_64"] }': """filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }""",
            'filter { name = "virtualization-type" values = ["hvm"] }': """filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }""",
        }
        updated = text
        for source, target in replacements.items():
            if source in updated:
                updated = updated.replace(source, target)
                remediation["legacy_inline_blocks_rewritten"] = True
        return updated

    def _rewrite_fixed_iam_names(text: str) -> str:
        updated = text
        iam_replacements = (
            (
                r'(?ms)(resource\s+"aws_iam_role"\s+"ec2"\s*\{[\s\S]*?^\s*)name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-ec2-role"\s*$',
                r'\1name_prefix        = substr("${var.project_name}-${var.environment}-ec2-role-", 0, 38)',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_instance_profile"\s+"ec2"\s*\{[\s\S]*?^\s*)name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-instance-profile"\s*$',
                r'\1name_prefix = substr("${var.project_name}-${var.environment}-instance-profile-", 0, 38)',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_role_policy"\s+"app"\s*\{[\s\S]*?^\s*)name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-app"\s*$',
                r'\1name_prefix = substr("${var.project_name}-${var.environment}-app-", 0, 38)',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_role"\s+"ec2"\s*\{[\s\S]*?^\s*)name_prefix\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-ec2-role-"\s*$',
                r'\1name_prefix        = substr("${var.project_name}-${var.environment}-ec2-role-", 0, 38)',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_instance_profile"\s+"ec2"\s*\{[\s\S]*?^\s*)name_prefix\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-instance-profile-"\s*$',
                r'\1name_prefix = substr("${var.project_name}-${var.environment}-instance-profile-", 0, 38)',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_role_policy"\s+"app"\s*\{[\s\S]*?^\s*)name_prefix\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-app-"\s*$',
                r'\1name_prefix = substr("${var.project_name}-${var.environment}-app-", 0, 38)',
            ),
        )
        for pattern, replacement in iam_replacements:
            rewritten = re.sub(pattern, replacement, updated, flags=re.IGNORECASE)
            if rewritten != updated:
                updated = rewritten
                remediation["legacy_iam_name_collision_rewritten"] = True
        return updated

    def _rewrite_nginx_ingress_port(text: str) -> str:
        if "dnf install -y nginx" not in text:
            return text
        if re.search(r"\bfrom_port\s*=\s*80\b", text):
            return text
        rewritten = re.sub(
            r'(?ms)(resource\s+"aws_security_group"\s+"app"\s*\{[\s\S]*?ingress\s*\{[\s\S]*?from_port\s*=\s*)var\.app_port(\s*[\r\n]+\s*to_port\s*=\s*)var\.app_port',
            r"\g<1>80\g<2>80",
            text,
        )
        if rewritten != text:
            remediation["legacy_nginx_ingress_port_fixed"] = True
        return rewritten

    def _rewrite_single_line_variable_blocks(text: str) -> str:
        updated = text
        variable_rewrites = (
            (
                r'variable\s+"desired_log_group_name"\s*\{\{\s*type\s*=\s*string\s*[\n\r]+\s*default\s*=\s*null\s*[\n\r]+\s*\}\}',
                """variable "desired_log_group_name" {
  type    = string
  default = null
}""",
            ),
            (
                r'variable\s+"log_group_override"\s*\{\{\s*type\s*=\s*string\s*[\n\r]+\s*default\s*=\s*null\s*[\n\r]+\s*\}\}',
                """variable "log_group_override" {
  type    = string
  default = null
}""",
            ),
            (
                r'variable\s+"desired_log_group_name"\s*\{\s*type\s*=\s*string\s*,\s*default\s*=\s*null\s*\}',
                """variable "desired_log_group_name" {
  type    = string
  default = null
}""",
            ),
            (
                r'variable\s+"log_group_override"\s*\{\s*type\s*=\s*string\s*,\s*default\s*=\s*null\s*\}',
                """variable "log_group_override" {
  type    = string
  default = null
}""",
            ),
        )
        for pattern, replacement in variable_rewrites:
            rewritten = re.sub(pattern, replacement, updated, flags=re.IGNORECASE)
            if rewritten != updated:
                updated = rewritten
                remediation["legacy_single_line_variable_blocks_rewritten"] = True
        return updated

    def _rewrite_conditional_depends_on(text: str) -> str:
        rewritten = re.sub(
            r'(?mi)^\s*depends_on\s*=\s*var\.load_balancer_enabled\s*\?\s*\[aws_lb_listener\.http\[0\]\]\s*:\s*\[\]\s*$',
            '  depends_on = [aws_lb_listener.http]',
            text,
        )
        if rewritten != text:
            remediation["legacy_conditional_depends_on_rewritten"] = True
        return rewritten

    def _rewrite_artifacts_policy_count(text: str) -> str:
        rewritten, changed = rewrite_artifacts_iam_policy_count_known_at_plan(text)
        if changed:
            remediation["artifacts_policy_count_known_at_plan"] = True
        return rewritten

    bundle_has_aws_region_var = any(_terraform_has_variable(text, "aws_region") for text in tf_texts.values())
    bundle_has_region_var = any(_terraform_has_variable(text, "region") for text in tf_texts.values())

    malformed_user_data_join_pattern = re.compile(
        r'(?mi)^(\s*user_data\s*=\s*join\()\s*"\s*(?:\r?\n)+\s*"\s*,\s*\['
    )
    for idx in tf_indexes:
        text = tf_texts[idx]
        text = _rewrite_bootstrap_default(text)
        text = _rewrite_known_inline_blocks(text)
        text = _rewrite_fixed_iam_names(text)
        text = _rewrite_nginx_ingress_port(text)
        text = _rewrite_single_line_variable_blocks(text)
        text = _rewrite_conditional_depends_on(text)
        text = _rewrite_artifacts_policy_count(text)
        try:
            from terraform_agent.agent.internal_registry import enforce_registry_contracts_on_text

            text, contract_details = enforce_registry_contracts_on_text(text)
            if contract_details.get("ec2_module_v5_compat_rewritten"):
                remediation["ec2_module_v5_compat_rewritten"] = True
            if contract_details.get("ec2_count_ungated_from_key_reuse"):
                remediation["legacy_ec2_count_ungated_from_key_reuse"] = True
            if contract_details.get("artifacts_policy_count_known_at_plan"):
                remediation["artifacts_policy_count_known_at_plan"] = True
        except Exception:
            text, ec2_rewritten = rewrite_ec2_module_v5_compat(text)
            if ec2_rewritten:
                remediation["ec2_module_v5_compat_rewritten"] = True
        if bundle_has_aws_region_var and not bundle_has_region_var and "var.region" in text:
            rewritten = text.replace("var.region", "var.aws_region")
            if rewritten != text:
                text = rewritten
                remediation["legacy_provider_region_var_rewritten"] = True
        if './modules/database' in text and not any(path == "terraform/modules/database/main.tf" for path in normalized_paths.values()) and any(path == "terraform/modules/data/main.tf" for path in normalized_paths.values()):
            text = text.replace('./modules/database', './modules/data')
            remediation["legacy_database_module_source_rewritten"] = True
        replaced = malformed_user_data_join_pattern.sub(r'\1"\\n", [', text)
        if replaced != text:
            text = replaced
            remediation["legacy_user_data_join_newline_fixed"] = True
        tf_texts[idx] = text

    malformed_bootstrap_printf_pattern = re.compile(
        r'(?mi)^(\s*)".*?\$\{var\.bootstrap_index_html_base64\}.*?base64 --decode > ([^"]+)",\s*$'
    )
    for idx in tf_indexes:
        text = tf_texts[idx]
        replaced = malformed_bootstrap_printf_pattern.sub(
            r'\1"printf \'%s\' \'${var.bootstrap_index_html_base64}\' | base64 --decode > \2",',
            text,
        )
        if replaced != text:
            tf_texts[idx] = replaced
            remediation["legacy_user_data_bootstrap_quote_fixed"] = True

    ami_line_pattern = re.compile(r'(?mi)^(\s*)ami\s*=\s*"ami-[a-z0-9]+"\s*$')
    needs_ami_data = False
    for idx in tf_indexes:
        text = tf_texts[idx]
        if not ami_line_pattern.search(text):
            continue
        replaced = ami_line_pattern.sub(r"\1ami = data.aws_ami.deplai_runtime_al2023.id", text)
        if replaced != text:
            tf_texts[idx] = replaced
            remediation["legacy_ami_replaced"] = True
            needs_ami_data = True

    if needs_ami_data and 'data "aws_ami" "deplai_runtime_al2023"' not in combined:
        first_idx = tf_indexes[0]
        tf_texts[first_idx] = (
            "data \"aws_ami\" \"deplai_runtime_al2023\" {\n"
            "  most_recent = true\n"
            "  owners      = [\"amazon\"]\n"
            "  filter {\n"
            "    name   = \"name\"\n"
            "    values = [\"al2023-ami-2023*-x86_64\"]\n"
            "  }\n"
            "  filter {\n"
            "    name   = \"virtualization-type\"\n"
            "    values = [\"hvm\"]\n"
            "  }\n"
            "}\n\n"
            + tf_texts[first_idx]
        )

    post_patch_combined = "\n".join(tf_texts[idx] for idx in tf_indexes)
    versions_tf_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/versions.tf"),
        None,
    )
    providers_tf_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/providers.tf"),
        None,
    )
    if versions_tf_idx is not None and providers_tf_idx is not None:
        versions_text = tf_texts[versions_tf_idx]
        if 'provider "aws"' in versions_text:
            stripped_versions = re.sub(
                r'(?is)\s*provider\s+"aws"\s*\{.*?\}\s*',
                "\n",
                versions_text,
            ).strip()
            if not stripped_versions:
                stripped_versions = """terraform {
  required_version = ">= 1.5.0"
}
"""
            tf_texts[versions_tf_idx] = f"{stripped_versions.rstrip()}\n"
            remediation["legacy_versions_provider_deduped"] = True

    post_patch_combined = "\n".join(tf_texts[idx] for idx in tf_indexes)
    if 'data.aws_ami.al2023.id' in post_patch_combined and 'data "aws_ami" "al2023"' not in post_patch_combined:
        data_tf_idx = next(
            (idx for idx, path in normalized_paths.items() if path == "terraform/data.tf"),
            None,
        )
        target_idx = data_tf_idx if data_tf_idx is not None else tf_indexes[0]
        tf_texts[target_idx] = (
            "data \"aws_ami\" \"al2023\" {\n"
            "  most_recent = true\n"
            "  owners      = [\"amazon\"]\n"
            "  filter {\n"
            "    name   = \"name\"\n"
            "    values = [\"al2023-ami-2023*-x86_64\"]\n"
            "  }\n"
            "  filter {\n"
            "    name   = \"virtualization-type\"\n"
            "    values = [\"hvm\"]\n"
            "  }\n"
            "}\n\n"
            + tf_texts[target_idx]
        )
        remediation["legacy_al2023_ami_data_added"] = True

    alb_subnet_line_pattern = re.compile(
        r'(?mi)^\s*subnets\s*=\s*(?:\[\s*aws_subnet\.main\.id\s*\]|aws_subnet\.main\.id)\s*$'
    )
    needs_subnet_clone = False
    for idx in tf_indexes:
        text = tf_texts[idx]
        replaced = alb_subnet_line_pattern.sub("  subnets            = [aws_subnet.main.id, aws_subnet.main_b.id]", text)
        if replaced != text:
            tf_texts[idx] = replaced
            remediation["legacy_alb_subnets_patched"] = True
            needs_subnet_clone = True

    post_patch_combined = "\n".join(tf_texts[idx] for idx in tf_indexes)
    target_idx: int | None = None
    if needs_subnet_clone and 'resource "aws_subnet" "main_b"' not in post_patch_combined:
        for idx in tf_indexes:
            if re.search(r'(?is)resource\s+"aws_subnet"\s+"main"\s*\{', tf_texts[idx]):
                target_idx = idx
                break
        if target_idx is not None:
            tf_texts[target_idx] = (
                tf_texts[target_idx]
                + "\n"
                + "data \"aws_vpc\" \"deplai_runtime_main\" {\n"
                + "  id = aws_subnet.main.vpc_id\n"
                + "}\n\n"
                + "resource \"aws_subnet\" \"main_b\" {\n"
                + "  vpc_id                  = aws_subnet.main.vpc_id\n"
                + "  cidr_block              = cidrsubnet(data.aws_vpc.deplai_runtime_main.cidr_block, 8, 2)\n"
                + "  availability_zone       = regexreplace(aws_subnet.main.availability_zone, \"[a-z]$\", \"b\")\n"
                + "  map_public_ip_on_launch = true\n"
                + "}\n"
            )
            remediation["legacy_subnet_clone_added"] = True

    for idx, item in enumerate(patched_files):
        path = _normalize_rel_path(str(item.get("path", ""))).lower()
        if not path.endswith(".tfvars"):
            continue
        text = _extract_text_payload(item)
        normalized_text = _normalize_tfvars_aliases(text)
        if normalized_text != text:
            patched_files[idx] = _set_text_payload(item, normalized_text)

    if (
        needs_subnet_clone
        and target_idx is not None
        and 'resource "aws_route_table_association" "main"' in post_patch_combined
        and 'resource "aws_route_table_association" "main_b"' not in post_patch_combined
    ):
        tf_texts[target_idx] = (
            tf_texts[target_idx]
            + "\n"
            + "resource \"aws_route_table_association\" \"main_b\" {\n"
            + "  subnet_id      = aws_subnet.main_b.id\n"
            + "  route_table_id = aws_route_table_association.main.route_table_id\n"
            + "}\n"
        )
        remediation["legacy_route_assoc_clone_added"] = True

    changed = any(bool(value) for value in remediation.values())
    normalized_tf_paths = set(normalized_paths.values())
    main_tf_text = next(
        (tf_texts[idx] for idx, path in normalized_paths.items() if path == "terraform/main.tf"),
        "",
    )
    if './modules/storage' in main_tf_text and "terraform/modules/storage/main.tf" not in normalized_tf_paths:
        _upsert_file(
            "terraform/modules/storage/main.tf",
            """locals {
  storage_enabled = var.enabled
}
""",
        )
        _upsert_file(
            "terraform/modules/storage/variables.tf",
            """variable "enabled" { type = bool }
variable "project_name" { type = string }
variable "environment" { type = string }
variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}
variable "common_tags" { type = map(string) }
""",
        )
        _upsert_file(
            "terraform/modules/storage/outputs.tf",
            """output "cloudfront_url" {
  value = null
}

output "cloudfront_domain_name" {
  value = null
}

output "website_bucket_name" {
  value = null
}
""",
        )
        remediation["legacy_storage_stub_added"] = True
        changed = True
    if './modules/database' in main_tf_text and "terraform/modules/database/main.tf" not in normalized_tf_paths and "terraform/modules/data/main.tf" not in normalized_tf_paths:
        _upsert_file(
            "terraform/modules/database/main.tf",
            """locals {
  database_enabled = var.enable_postgres || var.enable_redis
}
""",
        )
        _upsert_file(
            "terraform/modules/database/variables.tf",
            """variable "enable_postgres" { type = bool }
variable "enable_redis" { type = bool }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_cidrs" { type = list(string) }
variable "common_tags" { type = map(string) }
""",
        )
        _upsert_file(
            "terraform/modules/database/outputs.tf",
            """output "rds_endpoint" {
  value = null
}

output "redis_endpoint" {
  value = null
}
""",
        )
        remediation["legacy_database_module_source_rewritten"] = True
        changed = True

    root_variables_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/variables.tf"),
        None,
    )
    if root_variables_idx is not None:
        root_variables_text = tf_texts[root_variables_idx]
        if 'variable "existing_ec2_key_pair_name"' not in root_variables_text:
            root_variables_text = (
                root_variables_text.rstrip()
                + "\n\n"
                + "variable \"existing_ec2_key_pair_name\" {\n"
                + "  type    = string\n"
                + "  default = \"\"\n"
                + "}\n"
            )
            tf_texts[root_variables_idx] = root_variables_text
            changed = True
        if 'variable "ec2_key_rotation"' not in root_variables_text:
            root_variables_text = (
                tf_texts[root_variables_idx].rstrip()
                + "\n\n"
                + "variable \"ec2_key_rotation\" {\n"
                + "  type        = string\n"
                + "  default     = \"init\"\n"
                + "  description = \"Unique suffix so each deploy mints a new EC2 key pair.\"\n"
                + "}\n"
            )
            tf_texts[root_variables_idx] = root_variables_text
            remediation["unique_ec2_key_rotation_var_added"] = True
            changed = True

    root_main_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/main.tf"),
        None,
    )
    if root_main_idx is not None:
        root_main_text = tf_texts[root_main_idx]
        module_compute_pattern = re.compile(r'(module\s+"compute"\s*\{)([\s\S]*?)(\n\})', flags=re.IGNORECASE)

        def _inject_compute_arg(match: re.Match[str]) -> str:
            body = str(match.group(2) or "")
            extras = ""
            if "existing_ec2_key_pair_name" not in body:
                extras += "\n  existing_ec2_key_pair_name  = \"\"\n"
            if "ec2_key_rotation" not in body:
                extras += "\n  ec2_key_rotation            = var.ec2_key_rotation\n"
            if not extras:
                return match.group(0)
            body = body.rstrip() + extras
            return f"{match.group(1)}{body}{match.group(3)}"

        updated_main = module_compute_pattern.sub(_inject_compute_arg, root_main_text, count=1)
        if updated_main != root_main_text:
            tf_texts[root_main_idx] = updated_main
            remediation["unique_ec2_key_rotation_var_added"] = True
            changed = True

    compute_variables_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/modules/compute/variables.tf"),
        None,
    )
    if compute_variables_idx is not None:
        compute_variables_text = tf_texts[compute_variables_idx]
        extras = ""
        if 'variable "existing_ec2_key_pair_name"' not in compute_variables_text:
            extras += "variable \"existing_ec2_key_pair_name\" { type = string default = \"\" }\n"
        if 'variable "ec2_key_rotation"' not in compute_variables_text:
            extras += "variable \"ec2_key_rotation\" { type = string }\n"
        if extras:
            tf_texts[compute_variables_idx] = compute_variables_text.rstrip() + "\n" + extras
            remediation["unique_ec2_key_rotation_var_added"] = True
            changed = True

    compute_main_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/modules/compute/main.tf"),
        None,
    )
    if compute_main_idx is not None:
        compute_main_text = tf_texts[compute_main_idx]
        if 'resource "aws_key_pair" "generated"' in compute_main_text:
            compute_main_text = re.sub(
                r'use_existing_key\s*=\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*!=\s*""',
                "use_existing_key = false",
                compute_main_text,
            )
            compute_main_text = re.sub(
                r'ec2_key_name\s*=\s*local\.use_existing_key\s*\?\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*:\s*aws_key_pair\.generated\[0\]\.key_name',
                "ec2_key_name     = try(aws_key_pair.generated[0].key_name, null)",
                compute_main_text,
            )
            # Repair prior bad remediations that accidentally gated module.ec2 on key reuse.
            repaired_ec2, ec2_n = re.subn(
                r'(module\s+"ec2"\s*\{[^}]*?count\s*=\s*)var\.enabled\s*&&\s*!local\.use_existing_key\s*\?\s*1\s*:\s*0',
                r'\1var.enabled ? 1 : 0',
                compute_main_text,
                count=1,
                flags=re.IGNORECASE | re.DOTALL,
            )
            if ec2_n:
                compute_main_text = repaired_ec2
                remediation["legacy_ec2_count_ungated_from_key_reuse"] = True
            compute_main_text = compute_main_text.replace(
                'key_name                    = aws_key_pair.generated[0].key_name',
                'key_name                    = local.ec2_key_name',
            )

            if compute_main_text != tf_texts[compute_main_idx]:
                tf_texts[compute_main_idx] = compute_main_text
                changed = True

    if changed:
        for idx in tf_indexes:
            patched_files[idx] = _set_text_payload(patched_files[idx], tf_texts[idx])

    patched_files, key_fix = _ensure_unique_ec2_key_pair(patched_files)
    if any(bool(value) for value in key_fix.values()):
        remediation.update(key_fix)
        changed = True

    if not changed:
        return files, {}

    _emit_progress(
        apply_context,
        "info",
        "Applied runtime compatibility fixes for the Terraform bundle (AMI, ALB, user_data, unique EC2 key rotation, IAM names, and variable normalization).",
    )
    return patched_files, remediation


# Production-style pin: ~> 5.100.0 => >= 5.100.0, < 5.101.0 (patch-only within tested minor).
# Do not float ~> 5.x or jump to 6.x until EC2 6 + ALB 10 are curated. Prefer .terraform.lock.hcl.
_REGISTRY_AWS_PROVIDER_CONSTRAINT = "~> 5.100.0"
_REGISTRY_AWS_PROVIDER_PATTERN = re.compile(
    r'(source\s*=\s*"hashicorp/aws"[^}]*?version\s*=\s*")[^"]+(")',
    flags=re.IGNORECASE | re.DOTALL,
)


def _bundle_uses_ec2_module_v5(text: str) -> bool:
    if "terraform-aws-modules/ec2-instance/aws" not in text:
        return False
    # Treat any 5.x pin (or missing explicit major-6 pin next to the module) as v5 stack.
    if re.search(r'terraform-aws-modules/ec2-instance/aws[\s\S]{0,120}version\s*=\s*"6\.', text):
        return False
    return True


def _normalize_aws_provider_to_registry_pin(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Force AWS provider 5.x when the bundle uses EC2 module 5.x / ALB 9.x.

    A previous runtime path rewrote constraints to ``~> 6.0``, which makes
    ``terraform-aws-modules/ec2-instance/aws`` 5.8.0 fail with unsupported
    ``cpu_core_count`` / ``block_duration_minutes`` arguments.
    """
    combined = "\n".join(_extract_text_payload(item) for item in files if str(item.get("path", "")).lower().endswith(".tf"))
    if not _bundle_uses_ec2_module_v5(combined) and "terraform-aws-modules/alb/aws" not in combined:
        return files

    patched: list[dict[str, Any]] = []
    changed = False
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            patched.append(item)
            continue
        text = _extract_text_payload(item)
        rewritten = _REGISTRY_AWS_PROVIDER_PATTERN.sub(
            rf'\1{_REGISTRY_AWS_PROVIDER_CONSTRAINT}\2',
            text,
        )
        # Also collapse mistaken ~> 6.0 pins written by older remediations.
        rewritten = re.sub(
            r'(source\s*=\s*"hashicorp/aws"[^}]*?version\s*=\s*")~>\s*6\.[0-9.]+(")',
            rf'\1{_REGISTRY_AWS_PROVIDER_CONSTRAINT}\2',
            rewritten,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if rewritten != text:
            item = _set_text_payload(dict(item), rewritten)
            changed = True
        patched.append(item)
    if changed:
        _emit_progress(
            apply_context,
            "info",
            f"Pinned AWS provider to {_REGISTRY_AWS_PROVIDER_CONSTRAINT} for EC2 module 5.x / ALB 9.x compatibility.",
        )
    return patched


def _normalize_rds_elasticache_provider_versions(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Align RDS/ElastiCache provider pins with the internal registry (AWS 5.x).

    Historically this rewrote constraints to ``~> 6.0`` for an older EC2 patcher.
    The curated registry stack uses EC2 module 5.8.0 + ALB 9.x, which require
    AWS provider 5.x — provider 6 breaks those modules.
    """
    return _normalize_aws_provider_to_registry_pin(files, apply_context)


# Map of retired/invalid RDS engine versions -> current valid replacement.
# AWS periodically removes old minor versions from the CreateDBInstance API.
# Keep this list updated when AWS retires more versions.
_CURRENT_POSTGRES_VERSION = "15.17"
_POSTGRES_CURRENT_BY_MAJOR = {
    "13": "13.18",
    "14": "14.15",
    "15": _CURRENT_POSTGRES_VERSION,
    "16": "16.13",
    "17": "17.4",
}
_POSTGRES_SENTINELS = {"", "latest", "lts", "stable", "current", "alpine"}
_RETIRED_POSTGRES_VERSIONS: dict[str, str] = {
    # PostgreSQL 15 — prefer a current available minor (15.10 is not offered in all regions).
    "15.1": "15.17",
    "15.2": "15.17",
    "15.3": "15.17",
    "15.4": "15.17",
    "15.5": "15.17",
    "15.6": "15.17",
    "15.7": "15.17",
    "15.8": "15.17",
    "15.9": "15.17",
    "15.10": "15.17",
    "15.11": "15.17",
    "15.12": "15.17",
    "15.13": "15.17",
    "15.14": "15.17",
    "15.15": "15.17",
    "15.16": "15.17",
    # PostgreSQL 14 — AWS retired 14.1-14.12; minimum available is 14.15
    "14.1": "14.15",
    "14.2": "14.15",
    "14.3": "14.15",
    "14.4": "14.15",
    "14.5": "14.15",
    "14.6": "14.15",
    "14.7": "14.15",
    "14.8": "14.15",
    "14.9": "14.15",
    "14.10": "14.15",
    "14.11": "14.15",
    "14.12": "14.15",
    "14.13": "14.15",
    "14.14": "14.15",
    # PostgreSQL 13 — AWS retired 13.1-13.17; minimum available is 13.18
    "13.1": "13.18",
    "13.2": "13.18",
    "13.3": "13.18",
    "13.4": "13.18",
    "13.5": "13.18",
    "13.6": "13.18",
    "13.7": "13.18",
    "13.8": "13.18",
    "13.9": "13.18",
    "13.10": "13.18",
    "13.11": "13.18",
    "13.12": "13.18",
    "13.13": "13.18",
    "13.14": "13.18",
    "13.15": "13.18",
    "13.16": "13.18",
    "13.17": "13.18",
    # PostgreSQL 16 — keep on a current available minor
    "16.1": "16.13",
    "16.2": "16.13",
    "16.3": "16.13",
    "16.4": "16.13",
    "16.5": "16.13",
    "16.6": "16.13",
    "16.7": "16.13",
    "16.8": "16.13",
    "16.9": "16.13",
    "16.10": "16.13",
    "16.11": "16.13",
    "16.12": "16.13",
}


def _canonical_postgres_engine_version(version: str) -> str:
    raw = str(version or "").strip()
    token = raw.lower().split("-")[0].split("_")[0]
    if token in _POSTGRES_SENTINELS or not token or not token[0].isdigit():
        return _CURRENT_POSTGRES_VERSION
    if token in _POSTGRES_CURRENT_BY_MAJOR:
        return _POSTGRES_CURRENT_BY_MAJOR[token]
    mapped = _RETIRED_POSTGRES_VERSIONS.get(token) or _RETIRED_POSTGRES_VERSIONS.get(raw)
    if mapped:
        return mapped
    major = token.split(".")[0]
    return _POSTGRES_CURRENT_BY_MAJOR.get(major, _CURRENT_POSTGRES_VERSION)


def _normalize_rds_engine_versions(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Replace invalid AWS RDS engine_version values in Terraform files.

    AWS rejects Docker tags such as ``latest`` and retired minors such as
    ``15.5`` with InvalidParameterCombination on CreateDBInstance.
    """
    version_key_pattern = re.compile(
        r'((?:postgres_engine_version|db_engine_version|rds_engine_version|(?<![A-Za-z0-9_])engine_version)\s*=\s*)"([^"]+)"',
        flags=re.IGNORECASE,
    )
    default_sentinel_pattern = re.compile(
        r'(default\s*=\s*)"(latest|lts|stable|current|alpine|[\w.]+-alpine[^"]*)"',
        flags=re.IGNORECASE,
    )
    retired_pattern = re.compile(
        r'((?:engine_version|default|value)\s*=\s*)"(' + "|".join(re.escape(v) for v in _RETIRED_POSTGRES_VERSIONS) + r')"',
        flags=re.IGNORECASE,
    )
    var_assign_pattern = re.compile(
        r'^(\s*)engine_version\s*=\s*var\.(postgres_engine_version|db_engine_version|rds_engine_version)\s*$',
        flags=re.MULTILINE,
    )

    def _replace_assigned(match: re.Match[str]) -> str:
        prefix = match.group(1)
        old_ver = match.group(2)
        new_ver = _canonical_postgres_engine_version(old_ver)
        if new_ver == old_ver:
            return match.group(0)
        return f'{prefix}"{new_ver}"'

    def _replace_var_assign(match: re.Match[str]) -> str:
        indent = match.group(1)
        name = match.group(2)
        pin = _CURRENT_POSTGRES_VERSION
        return (
            f'{indent}engine_version = contains(["", "latest", "lts", "stable", "current", "alpine"], '
            f'lower(trimspace(var.{name}))) ? "{pin}" : var.{name}'
        )

    declares_postgres_version = any(
        re.search(r'variable\s+"postgres_engine_version"', _extract_text_payload(item))
        for item in files
        if str(item.get("path", "")).replace("\\", "/").lower().endswith(".tf")
    )

    patched: list[dict[str, Any]] = []
    changed = False
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not (path.endswith(".tf") or path.endswith(".tfvars")):
            patched.append(item)
            continue
        text = _extract_text_payload(item)
        rewritten = version_key_pattern.sub(_replace_assigned, text)
        rewritten = default_sentinel_pattern.sub(
            lambda match: f'{match.group(1)}"{_canonical_postgres_engine_version(match.group(2))}"',
            rewritten,
        )
        rewritten = retired_pattern.sub(_replace_assigned, rewritten)
        rewritten = var_assign_pattern.sub(_replace_var_assign, rewritten)
        if (
            declares_postgres_version
            and path.endswith("terraform.tfvars")
            and "/envs/" not in path
        ):
            rewritten = _upsert_tfvars_assignment(
                rewritten, "postgres_engine_version", _CURRENT_POSTGRES_VERSION
            )
        if rewritten != text:
            item = _set_text_payload(dict(item), rewritten)
            changed = True
        patched.append(item)
    if changed:
        _emit_progress(
            apply_context,
            "info",
            "Patched invalid RDS engine_version values to current AWS-supported versions (e.g. latest -> 15.17).",
        )
    return patched


def _upsert_tfvars_assignment(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'(?m)^{re.escape(key)}\s*=\s*".*?"\s*$')
    line = f'{key} = "{value}"'
    if pattern.search(text or ""):
        return pattern.sub(line, text)
    body = str(text or "")
    if body and not body.endswith("\n"):
        body += "\n"
    return body + line + "\n"


_SSM_CORE_ATTACHMENT = """
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
"""

_ECR_PULL_POLICY = """
resource "aws_iam_role_policy" "ecr_pull" {
  name_prefix = substr("${var.project_name}-${var.environment}-ecr-", 0, 38)
  role        = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:DescribeImages"
        ]
        Resource = "*"
      }
    ]
  })
}
"""


def _ensure_ssm_managed_instance_core(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Attach SSM Session Manager to the EC2 instance role when the bundle has one."""
    patched: list[dict[str, Any]] = []
    changed = False
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            patched.append(item)
            continue
        text = _extract_text_payload(item)
        if "AmazonSSMManagedInstanceCore" in text or 'resource "aws_iam_role" "ec2"' not in text:
            patched.append(item)
            continue
        item = _set_text_payload(dict(item), text.rstrip() + "\n" + _SSM_CORE_ATTACHMENT)
        changed = True
        patched.append(item)
    if changed:
        _emit_progress(
            apply_context,
            "info",
            "Attached AmazonSSMManagedInstanceCore so the instance can be reached with Session Manager.",
        )
    return patched


def _ensure_ecr_pull_policy(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Allow the instance role to authenticate to ECR and pull immutable images."""
    patched: list[dict[str, Any]] = []
    changed = False
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            patched.append(item)
            continue
        text = _extract_text_payload(item)
        if "ecr:GetAuthorizationToken" in text or 'resource "aws_iam_role" "ec2"' not in text:
            patched.append(item)
            continue
        item = _set_text_payload(dict(item), text.rstrip() + "\n" + _ECR_PULL_POLICY)
        changed = True
        patched.append(item)
    if changed:
        _emit_progress(
            apply_context,
            "info",
            "Attached ECR pull permissions so the instance can fetch Docker images without long-lived keys.",
        )
    return patched


def rewrite_app_artifact_filemd5_guard(text: str) -> tuple[str, bool]:
    """Guard filemd5 so terraform validate passes when artifacts/app.tgz is absent.

    Terraform still evaluates ``etag = filemd5(...)`` even when ``count = 0``.
    """
    pattern = re.compile(
        r'etag\s*=\s*filemd5\("\$\{path\.root\}/artifacts/app\.tgz"\)',
    )
    replacement = (
        'etag   = fileexists("${path.root}/artifacts/app.tgz") '
        '? filemd5("${path.root}/artifacts/app.tgz") : ""'
    )
    updated, count = pattern.subn(replacement, text)
    return updated, count > 0


def _extract_tfvars_app_archive_base64(files: list[dict[str, Any]]) -> bytes | None:
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tfvars"):
            continue
        text = _extract_text_payload(item)
        match = re.search(
            r'(?m)^\s*app_archive_base64\s*=\s*("(?:\\.|[^"\\])*")\s*$',
            text,
        )
        if not match:
            continue
        try:
            encoded = str(json.loads(match.group(1)) or "").strip()
        except json.JSONDecodeError:
            continue
        if not encoded:
            continue
        try:
            return base64.b64decode(encoded.encode("ascii"), validate=True)
        except Exception:
            continue
    return None


def _append_app_artifact_tarball(
    files: list[dict[str, Any]],
    payload: bytes,
    *,
    apply_context: dict[str, Any] | None,
    source_label: str,
) -> list[dict[str, Any]]:
    if not payload:
        return files
    updated = list(files)
    updated.append(
        {
            "path": "terraform/artifacts/app.tgz",
            "content": base64.b64encode(payload).decode("ascii"),
            "encoding": "base64",
        }
    )
    _emit_progress(
        apply_context,
        "info",
        f"Attached deployment package from {source_label} as terraform/artifacts/app.tgz for S3 app delivery.",
    )
    return updated


def _remediate_app_artifact_filemd5(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    patched = [dict(item) for item in files]
    changed = False
    for idx, item in enumerate(patched):
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        text = _extract_text_payload(item)
        updated, did_change = rewrite_app_artifact_filemd5_guard(text)
        if did_change:
            patched[idx] = _set_text_payload(item, updated)
            changed = True
    if changed:
        _emit_progress(
            apply_context,
            "info",
            "Guarded aws_s3_object.app etag so terraform validate tolerates a missing artifacts/app.tgz.",
        )
    return patched, {"app_artifact_filemd5_guarded": changed}


def _inject_app_artifact_tarball(
    files: list[dict[str, Any]],
    apply_context: dict[str, Any] | None = None,
    project_name: str = "",
) -> list[dict[str, Any]]:
    """Copy the packaged app tarball into the Terraform workspace for aws_s3_object.source."""
    already = any(
        str(item.get("path", "")).replace("\\", "/").rstrip("/").endswith("artifacts/app.tgz")
        for item in files
    )
    if already:
        return files

    package_id = ""
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/")
        if not path.endswith(".tfvars"):
            continue
        match = re.search(
            r'deployment_package_id\s*=\s*"([^"]*)"',
            _extract_text_payload(item),
        )
        if match:
            package_id = str(match.group(1) or "").strip()
            break

    try:
        from deployment_packager import load_persisted_app_tarball
    except Exception:
        load_persisted_app_tarball = None  # type: ignore[assignment,misc]

    if load_persisted_app_tarball is not None:
        loaded = load_persisted_app_tarball(package_id=package_id, project_slug=project_name)
        if loaded:
            loaded_id, payload = loaded
            if payload:
                return _append_app_artifact_tarball(
                    files,
                    payload,
                    apply_context=apply_context,
                    source_label=f"package store ({loaded_id})",
                )

    embedded = _extract_tfvars_app_archive_base64(files)
    if embedded:
        return _append_app_artifact_tarball(
            files,
            embedded,
            apply_context=apply_context,
            source_label="terraform.tfvars app_archive_base64",
        )

    return files


def _collect_terraform_text(files: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        chunks.append(_extract_text_payload(item))
    return "\n".join(chunks)


def _is_terraform_root_tf_path(path: str) -> bool:
    try:
        normalized = _normalize_rel_path(path)
    except ValueError:
        return False
    if not normalized.endswith(".tf"):
        return False
    parts = [part for part in normalized.split("/") if part]
    return len(parts) == 2 and parts[0] == "terraform"


def _collect_root_terraform_text(files: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for item in files:
        if _is_terraform_root_tf_path(str(item.get("path", ""))):
            chunks.append(_extract_text_payload(item))
    return "\n".join(chunks)


def _terraform_has_variable(tf_text: str, variable_name: str) -> bool:
    pattern = rf'variable\s+"{re.escape(variable_name)}"\s*\{{'
    return re.search(pattern, tf_text or "", flags=re.IGNORECASE) is not None


def _ec2_key_pair_exists(ec2_client: Any, key_name: str) -> bool:
    try:
        ec2_client.describe_key_pairs(KeyNames=[key_name])
        return True
    except Exception as exc:
        message = str(exc or "")
        if "InvalidKeyPair.NotFound" in message or "not found" in message.lower():
            return False
        return False


def _new_ec2_key_rotation() -> str:
    return secrets.token_hex(4)


def _scrub_workspace_private_keys(terraform_root: str | None) -> None:
    root = Path(str(terraform_root or "").strip())
    if not root.is_dir():
        return
    for pem_file in root.rglob("*.pem"):
        try:
            pem_file.unlink()
        except OSError:
            continue


def _boto3_client(service: str, *, region: str, aws_access_key_id: str, aws_secret_access_key: str, aws_session_token: str | None) -> Any:
    kwargs: dict[str, Any] = {"region_name": region}
    if aws_access_key_id and aws_secret_access_key:
        kwargs["aws_access_key_id"] = aws_access_key_id
        kwargs["aws_secret_access_key"] = aws_secret_access_key
        if aws_session_token:
            kwargs["aws_session_token"] = aws_session_token
    return boto3.client(service, **kwargs)


def _tag_key_pair_with_instance(
    *,
    key_name: str,
    instance_id: str,
    project_name: str,
    aws_region: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
) -> dict[str, str]:
    result = {"key_name": key_name, "instance_id": instance_id, "tagged": "false"}
    if not key_name or not instance_id or not aws_access_key_id or not aws_secret_access_key:
        return result
    try:
        ec2 = _boto3_client(
            "ec2",
            region=aws_region,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token,
        )
        described = ec2.describe_key_pairs(KeyNames=[key_name])
        pairs = described.get("KeyPairs") or []
        key_pair_id = str((pairs[0] if pairs else {}).get("KeyPairId") or "").strip()
        resource_id = key_pair_id or key_name
        ec2.create_tags(
            Resources=[resource_id],
            Tags=[
                {"Key": "Name", "Value": key_name},
                {"Key": "deplai:instance-id", "Value": instance_id},
                {"Key": "deplai:project", "Value": str(project_name or "")[:256]},
                {"Key": "deplai:managed", "Value": "true"},
            ],
        )
        result["tagged"] = "true"
        result["key_pair_id"] = resource_id
    except Exception as exc:
        result["error"] = str(exc)[:240]
    return result


def _fetch_secret_string(
    secret_arn: str,
    *,
    aws_region: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
) -> dict[str, Any] | None:
    arn = str(secret_arn or "").strip()
    if not arn or arn.lower() in {"null", "none"}:
        return None
    try:
        client = _boto3_client(
            "secretsmanager",
            region=aws_region,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token,
        )
        payload = client.get_secret_value(SecretId=arn)
        raw = str(payload.get("SecretString") or "").strip()
        if not raw:
            return None
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"value": raw}
    except Exception:
        return None


def _database_env_from_secret(secret: dict[str, Any] | None) -> str:
    if not isinstance(secret, dict) or not secret:
        return ""
    user = str(secret.get("username") or secret.get("user") or "").strip()
    password = str(secret.get("password") or "").strip()
    host = str(secret.get("host") or secret.get("hostname") or "").strip()
    port = str(secret.get("port") or "5432").strip() or "5432"
    dbname = str(secret.get("dbname") or secret.get("database") or "appdb").strip() or "appdb"
    lines = [
        f"PGHOST={host}" if host else "",
        f"PGPORT={port}",
        f"PGUSER={user}" if user else "",
        f"PGPASSWORD={password}" if password else "",
        f"PGDATABASE={dbname}",
    ]
    if user and password and host:
        engine = str(secret.get("engine") or "postgres").lower()
        scheme = "mysql" if "mysql" in engine or "mariadb" in engine else "postgresql"
        lines.append(
            f"DATABASE_URL={scheme}://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}/{dbname}"
        )
    return "\n".join(item for item in lines if item) + ("\n" if any(lines) else "")


def _collect_one_time_credentials(
    outputs: dict[str, Any],
    *,
    project_name: str,
    aws_region: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
    terraform_root: str | None = None,
) -> dict[str, Any]:
    pem = str(
        outputs.get("generated_ec2_private_key_pem")
        or outputs.get("generated_private_key_pem")
        or outputs.get("ec2_private_key_pem")
        or ""
    ).strip()
    key_name = str(outputs.get("ec2_key_name") or outputs.get("generated_ec2_key_name") or "").strip()
    instance_id = str(outputs.get("ec2_instance_id") or outputs.get("instance_id") or "").strip()
    secret_arn = str(
        outputs.get("rds_secret_arn")
        or outputs.get("database_secret_arn")
        or outputs.get("db_secret_arn")
        or ""
    ).strip()
    database_env = ""
    if secret_arn:
        database_env = _database_env_from_secret(
            _fetch_secret_string(
                secret_arn,
                aws_region=aws_region,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=aws_session_token,
            )
        )
    tag_info = _tag_key_pair_with_instance(
        key_name=key_name,
        instance_id=instance_id,
        project_name=project_name,
        aws_region=aws_region,
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
        aws_session_token=aws_session_token,
    ) if key_name and instance_id else {}
    _scrub_workspace_private_keys(terraform_root)
    file_stem = "-".join(part for part in (key_name or "deplai-ec2-key", instance_id) if part)
    return {
        "private_key_pem": pem or None,
        "key_name": key_name or None,
        "instance_id": instance_id or None,
        "key_file_name": f"{file_stem}.pem" if pem else None,
        "database_env": database_env or None,
        "database_file_name": f"{file_stem}-database.env" if database_env else None,
        "key_tags": tag_info,
        "download_once": True,
    }


_EC2_KEY_ROTATION_ROOT_VAR = """
variable "ec2_key_rotation" {
  type        = string
  default     = "init"
  description = "Unique suffix so each deploy mints a new EC2 key pair. AWS never stores the private half."
}
""".strip()

_EC2_KEY_ROTATION_MODULE_VAR = 'variable "ec2_key_rotation" { type = string }'


def _ensure_unique_ec2_key_pair(
    files: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Force a new TLS key on every apply. Never attach an AWS key whose PEM DeplAI does not have."""
    details: dict[str, Any] = {
        "unique_ec2_key_rotation_var_added": False,
        "unique_ec2_key_name_rewritten": False,
        "unique_ec2_key_always_generated": False,
        "unique_ec2_key_reuse_disabled": False,
    }
    patched = [dict(item) for item in files]
    combined = "\n".join(_extract_text_payload(item) for item in patched)
    if 'resource "aws_key_pair"' not in combined and 'resource "tls_private_key"' not in combined:
        return files, details

    def _path_of(item: dict[str, Any]) -> str:
        return _normalize_rel_path(str(item.get("path", "")))

    for index, item in enumerate(patched):
        path = _path_of(item).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        text = _extract_text_payload(item)
        original = text

        if path.endswith("variables.tf"):
            if "modules/compute/" in path:
                if 'variable "ec2_key_rotation"' not in text:
                    text = text.rstrip() + "\n" + _EC2_KEY_ROTATION_MODULE_VAR + "\n"
                    details["unique_ec2_key_rotation_var_added"] = True
            elif 'variable "ec2_key_rotation"' not in text:
                text = text.rstrip() + "\n\n" + _EC2_KEY_ROTATION_ROOT_VAR + "\n"
                details["unique_ec2_key_rotation_var_added"] = True

        if re.search(r'module\s+"compute"\s*\{', text, flags=re.IGNORECASE):
            module_pattern = re.compile(
                r'(module\s+"compute"\s*\{)([\s\S]*?)(\n\})',
                flags=re.IGNORECASE,
            )

            def _inject_rotation(match: re.Match[str]) -> str:
                body = str(match.group(2) or "")
                extra = ""
                if not re.search(r'(?m)^\s*ec2_key_rotation\s*=', body):
                    extra += "\n  ec2_key_rotation            = var.ec2_key_rotation\n"
                if re.search(r'(?m)^\s*existing_ec2_key_pair_name\s*=', body):
                    body = re.sub(
                        r'(?m)^(\s*)existing_ec2_key_pair_name\s*=\s*.+$',
                        r'\1existing_ec2_key_pair_name  = ""',
                        body,
                    )
                    details["unique_ec2_key_reuse_disabled"] = True
                if extra:
                    details["unique_ec2_key_rotation_var_added"] = True
                    body = body.rstrip() + extra
                return f"{match.group(1)}{body}{match.group(3)}"

            text = module_pattern.sub(_inject_rotation, text, count=1)

        text = re.sub(
            r'use_existing_key\s*=\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*!=\s*""',
            "use_existing_key = false",
            text,
        )
        text = re.sub(
            r'ec2_key_name\s*=\s*local\.use_existing_key\s*\?\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*:\s*aws_key_pair\.generated\[0\]\.key_name',
            "ec2_key_name     = try(aws_key_pair.generated[0].key_name, null)",
            text,
        )
        text = re.sub(
            r'(selected_(?:ec2_)?key_name\s*=\s*)!var\.enable_ec2\s*\?\s*null\s*:\s*\(\s*'
            r'trimspace\(var\.existing_ec2_key_pair_name\)\s*!=\s*""\s*'
            r'\?\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*'
            r':\s*try\(aws_key_pair\.generated\[0\]\.key_name,\s*null\)\s*\)',
            r"\1var.enable_ec2 ? try(aws_key_pair.generated[0].key_name, null) : null",
            text,
            flags=re.DOTALL,
        )
        if "use_existing_key = false" in text or "try(aws_key_pair.generated[0].key_name" in text:
            if original != text:
                details["unique_ec2_key_reuse_disabled"] = True

        def _rewrite_generated_resource(src: str, resource_type: str) -> str:
            header_match = re.search(
                rf'resource\s+"{re.escape(resource_type)}"\s+"generated"\s*\{{',
                src,
                flags=re.IGNORECASE,
            )
            if not header_match:
                return src
            brace_at = header_match.end() - 1
            depth = 0
            end = None
            for idx in range(brace_at, len(src)):
                char = src[idx]
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        end = idx
                        break
            if end is None:
                return src
            body = src[brace_at + 1:end]
            new_body = body
            if re.search(r'!local\.use_existing_key|existing_ec2_key_pair_name', new_body):
                new_body = re.sub(
                    r'(?m)^(\s*)count\s*=\s*var\.enabled\s*&&\s*!local\.use_existing_key\s*\?\s*1\s*:\s*0\s*$',
                    r'\1count      = var.enabled ? 1 : 0',
                    new_body,
                )
                new_body = re.sub(
                    r'(?m)^(\s*)count\s*=\s*var\.enable_ec2\s*&&\s*trimspace\(var\.existing_ec2_key_pair_name\)\s*==\s*""\s*\?\s*1\s*:\s*0\s*$',
                    r'\1count      = var.enable_ec2 ? 1 : 0',
                    new_body,
                )
                details["unique_ec2_key_always_generated"] = True
            if resource_type == "aws_key_pair" and "var.ec2_key_rotation" not in new_body:
                replaced, n = re.subn(
                    r'(?m)^(\s*)key_name\s*=\s*.+$',
                    r'\1key_name   = "${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key"',
                    new_body,
                    count=1,
                )
                if n:
                    new_body = replaced
                    details["unique_ec2_key_name_rewritten"] = True
            if new_body == body:
                return src
            return src[:brace_at + 1] + new_body + src[end:]

        text = _rewrite_generated_resource(text, "tls_private_key")
        text = _rewrite_generated_resource(text, "aws_key_pair")

        if "deplai_key_rotation" not in text:
            rotated = text.replace(
                "#!/bin/bash\nset -euxo pipefail",
                "#!/bin/bash\n# deplai_key_rotation=${var.ec2_key_rotation}\nset -euxo pipefail",
                1,
            )
            if rotated == text:
                rotated = text.replace(
                    "#!/bin/bash\n              set -euo pipefail",
                    "#!/bin/bash\n              # deplai_key_rotation=${var.ec2_key_rotation}\n              set -euo pipefail",
                    1,
                )
            if rotated != text:
                text = rotated
                details["unique_ec2_key_name_rewritten"] = True

        if re.search(r'resource\s+"random_id"\s+"key_suffix"', text) and "ec2_key_rotation" not in text.split('resource "random_id" "key_suffix"')[1][:400]:
            text, n = re.subn(
                r'(resource\s+"random_id"\s+"key_suffix"\s*\{[\s\S]*?keepers\s*=\s*\{)',
                r'\1\n    ec2_key_rotation = var.ec2_key_rotation',
                text,
                count=1,
            )
            if n:
                details["unique_ec2_key_always_generated"] = True

        if text != original:
            patched[index] = _set_text_payload(item, text)

    return patched, details


def _region_has_default_vpc(ec2_client: Any) -> bool | None:
    """Return True/False when the region default VPC can be listed, else None."""
    try:
        resp = ec2_client.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])
        vpcs = resp.get("Vpcs") or []
        return any(str(item.get("VpcId") or "").strip() for item in vpcs if isinstance(item, dict))
    except Exception:
        return None


def _is_missing_default_vpc_error(text: str) -> bool:
    lowered = str(text or "").lower()
    if "no matching ec2 vpc found" in lowered:
        return True
    if "data.aws_vpc.default" in lowered and ("no matching" in lowered or "not found" in lowered):
        return True
    if "default vpc not found" in lowered or "no default vpc" in lowered:
        return True
    return False


_HARD_DEFAULT_VPC_LOOKUP = re.compile(
    r'data\s+"aws_vpc"\s+"default"\s*\{[^{}]*\bdefault\s*=\s*true[^{}]*\}',
    re.IGNORECASE | re.DOTALL,
)


def _terraform_module_dir(path: str) -> str:
    parent = str(PurePosixPath(_normalize_rel_path(path)).parent)
    return "" if parent == "." else parent


def _soft_default_vpc_lookup_hcl(prefer_expr: str) -> str:
    return f'''data "aws_vpcs" "default" {{
  filter {{
    name   = "isDefault"
    values = ["true"]
  }}
}}

locals {{
  deplai_prefer_default_vpc = {prefer_expr}
  has_default_vpc           = local.deplai_prefer_default_vpc && length(data.aws_vpcs.default.ids) > 0
}}

data "aws_vpc" "default" {{
  count = local.has_default_vpc ? 1 : 0
  id    = data.aws_vpcs.default.ids[0]
}}'''


def _detect_default_vpc_prefer_var(lookup_block: str, module_text: str) -> str | None:
    count_match = re.search(
        r"\bcount\s*=\s*var\.(use_default_vpc|use_existing_vpc)\b",
        lookup_block or "",
        flags=re.IGNORECASE,
    )
    if count_match:
        return count_match.group(1)
    if _terraform_has_variable(module_text, "use_default_vpc") or re.search(
        r"\bvar\.use_default_vpc\b", module_text or ""
    ):
        return "use_default_vpc"
    if _terraform_has_variable(module_text, "use_existing_vpc") or re.search(
        r"\bvar\.use_existing_vpc\b", module_text or ""
    ):
        return "use_existing_vpc"
    return None


def _replace_prefer_var_with_has_default_vpc(text: str, prefer_var: str | None) -> str:
    if not prefer_var:
        return text
    keep = f"deplai_prefer_default_vpc = var.{prefer_var}"
    placeholder = f"deplai_prefer_default_vpc = DEPLAI_KEEP_VAR_{prefer_var}"
    updated = text.replace(keep, placeholder)
    updated = re.sub(rf"\bvar\.{re.escape(prefer_var)}\b", "local.has_default_vpc", updated)
    return updated.replace(placeholder, keep)


def _rewrite_hard_default_vpc_lookup(
    files: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Replace failing default-VPC data lookups with a list filter plus create-VPC fallback.

    `data.aws_vpc.default { default = true }` errors when the region has no default VPC.
    Listing default VPCs returns empty instead, and `local.has_default_vpc` then creates
    `aws_vpc.main` instead of planning against a missing data source.

    Locals are module-scoped, so the prefer-var rewrite stays inside the Terraform module
    that received the soft lookup. Root module references such as
    `var.use_existing_vpc || var.use_default_vpc` must not become `local.has_default_vpc`.
    """
    remediation = {"default_vpc_lookup_softened": False}
    patched = [dict(item) for item in files]
    groups: dict[str, list[int]] = {}
    for idx, item in enumerate(patched):
        raw_path = str(item.get("path", ""))
        try:
            normalized = _normalize_rel_path(raw_path)
        except ValueError:
            continue
        if not normalized.lower().endswith(".tf"):
            continue
        groups.setdefault(_terraform_module_dir(raw_path), []).append(idx)

    for indices in groups.values():
        module_text = "\n".join(_extract_text_payload(patched[idx]) for idx in indices)
        if 'data "aws_vpcs" "default"' in module_text or "local.has_default_vpc" in module_text:
            continue
        lookup_block = ""
        for idx in indices:
            match = _HARD_DEFAULT_VPC_LOOKUP.search(_extract_text_payload(patched[idx]))
            if match:
                lookup_block = match.group(0)
                break
        if not lookup_block or not re.search(r"\bcount\s*=", lookup_block):
            continue
        prefer_var = _detect_default_vpc_prefer_var(lookup_block, module_text)
        prefer_expr = f"var.{prefer_var}" if prefer_var else "true"
        injected = False
        for idx in indices:
            text = _extract_text_payload(patched[idx])
            updated = text
            if not injected and _HARD_DEFAULT_VPC_LOOKUP.search(updated):
                updated = _HARD_DEFAULT_VPC_LOOKUP.sub(
                    _soft_default_vpc_lookup_hcl(prefer_expr),
                    updated,
                    count=1,
                )
                injected = True
            updated = _replace_prefer_var_with_has_default_vpc(updated, prefer_var)
            if updated != text:
                patched[idx] = _set_text_payload(patched[idx], updated)
                remediation["default_vpc_lookup_softened"] = True
    return patched, remediation


def _project_slug_for_key(project_name: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", str(project_name or "").strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug[:40] or "deplai-project"


def _ec2_name_tag(instance: dict[str, Any]) -> str:
    for tag in instance.get("Tags") or []:
        if not isinstance(tag, dict):
            continue
        if str(tag.get("Key") or "").strip() == "Name":
            return str(tag.get("Value") or "").strip()
    return ""


def _instance_matches_project_name(instance: dict[str, Any], project_name: str) -> bool:
    requested_slug = _project_slug_for_key(project_name)
    if not requested_slug:
        return False
    name_slug = _project_slug_for_key(_ec2_name_tag(instance))
    if not name_slug:
        return False
    return name_slug == requested_slug or name_slug.startswith(f"{requested_slug}-")


def _summarize_live_ec2_instance(instance: dict[str, Any], aws_region: str) -> dict[str, str | None]:
    instance_id = str(instance.get("InstanceId") or "").strip() or None
    account_id = None
    owner_id = str(instance.get("OwnerId") or "").strip()
    if owner_id:
        account_id = owner_id
    return {
        "instance_id": instance_id,
        "instance_state": str((instance.get("State") or {}).get("Name") or "").strip() or None,
        "instance_type": str(instance.get("InstanceType") or "").strip() or None,
        "public_ip": str(instance.get("PublicIpAddress") or "").strip() or None,
        "private_ip": str(instance.get("PrivateIpAddress") or "").strip() or None,
        "public_dns": str(instance.get("PublicDnsName") or "").strip() or None,
        "private_dns": str(instance.get("PrivateDnsName") or "").strip() or None,
        "vpc_id": str(instance.get("VpcId") or "").strip() or None,
        "subnet_id": str(instance.get("SubnetId") or "").strip() or None,
        "instance_arn": (
            f"arn:aws:ec2:{aws_region}:{account_id}:instance/{instance_id}"
            if aws_region and account_id and instance_id
            else None
        ),
        "name_tag": _ec2_name_tag(instance) or None,
    }


def _lookup_live_ec2_instance_for_project(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str,
    aws_region: str,
    project_name: str,
) -> dict[str, str | None] | None:
    if not str(project_name or "").strip():
        return None
    try:
        session = boto3.session.Session(
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token or None,
            region_name=aws_region,
        )
        ec2 = session.client("ec2", region_name=aws_region)
        response = ec2.describe_instances(
            Filters=[{"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}]
        )
        matches = [
            instance
            for reservation in response.get("Reservations") or []
            for instance in reservation.get("Instances") or []
            if _instance_matches_project_name(instance, project_name)
        ]
        if not matches:
            return None
        matches.sort(
            key=lambda item: str(item.get("LaunchTime") or ""),
            reverse=True,
        )
        return _summarize_live_ec2_instance(matches[0], aws_region)
    except Exception:
        return None


def _extract_variable_default_string(tf_text: str, variable_name: str) -> str | None:
    body_match = re.search(
        rf'variable\s+"{re.escape(variable_name)}"\s*\{{(?P<body>.*?)\}}',
        tf_text or "",
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not body_match:
        return None
    body = str(body_match.group("body") or "")
    return _extract_assignment_string(body, "default")


def _discover_existing_ec2_key_pair_name(
    files: list[dict[str, Any]],
    fallback_project_name: str,
) -> str | None:
    tf_chunks: list[str] = []
    tfvars_chunks: list[str] = []

    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if path.endswith(".tf"):
            tf_chunks.append(_extract_text_payload(item))
        elif path.endswith(".tfvars"):
            tfvars_chunks.append(_extract_text_payload(item))

    tf_text = "\n".join(tf_chunks)
    tfvars_text = "\n".join(tfvars_chunks)

    explicit_key_name = (
        _extract_assignment_string(tfvars_text, "existing_ec2_key_pair_name")
        or _extract_variable_default_string(tf_text, "existing_ec2_key_pair_name")
    )
    if explicit_key_name and not _is_unresolved_template_value(explicit_key_name):
        return explicit_key_name

    key_name_match = re.search(
        r'(?is)resource\s+"aws_key_pair"\s+"generated"\s*\{(?P<body>.*?)\}',
        tf_text,
    )
    if key_name_match:
        key_name_value = _extract_assignment_string(str(key_name_match.group("body") or ""), "key_name")
        if key_name_value and not _is_unresolved_template_value(key_name_value):
            return key_name_value

    project_name = (
        _extract_assignment_string(tfvars_text, "project_name")
        or _extract_variable_default_string(tf_text, "project_name")
        or _project_slug_for_key(fallback_project_name)
    )
    environment = (
        _extract_assignment_string(tfvars_text, "environment")
        or _extract_variable_default_string(tf_text, "environment")
    )

    if _is_unresolved_template_value(project_name):
        project_name = _project_slug_for_key(fallback_project_name)
    if _is_unresolved_template_value(environment):
        environment = None

    uses_env_key = bool(
        re.search(
            r'key_name\s*=\s*"[^"]*\$\{var\.project_name\}-\$\{var\.environment\}-key"',
            tf_text,
            flags=re.IGNORECASE,
        )
    )
    uses_project_key = bool(
        re.search(
            r'key_name\s*=\s*"[^"]*\$\{var\.project_name\}-key"',
            tf_text,
            flags=re.IGNORECASE,
        )
    )

    if uses_env_key and project_name and environment:
        return f"{project_name}-{environment}-key"
    if uses_project_key and project_name:
        return f"{project_name}-key"
    # Enterprise default naming when template detection is ambiguous.
    if project_name and environment:
        return f"{project_name}-{environment}-key"
    if project_name:
        return f"{project_name}-key"
    return None


def _terraform_has_aws_instance(tf_text: str) -> bool:
    text = tf_text or ""
    if re.search(r'resource\s+"aws_instance"\s+"[^"]+"', text, flags=re.IGNORECASE):
        return True
    # Enterprise / runtime slice uses the registry EC2 module (no root aws_instance).
    if "terraform-aws-modules/ec2-instance/aws" in text:
        return True
    if re.search(r'resource\s+"aws_key_pair"\s+"[^"]+"', text, flags=re.IGNORECASE):
        return True
    return bool(re.search(r'module\s+"(ec2|compute)"\s*\{', text, flags=re.IGNORECASE))


def _collect_tfvars_text(files: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if path.endswith(".tfvars") or path.endswith(".auto.tfvars") or path.endswith(".tfvars.json"):
            chunks.append(_extract_text_payload(item))
    return "\n".join(chunks)


def _bundle_requests_ec2(tf_text: str, tfvars_text: str) -> bool:
    """True when this apply is expected to create a live EC2 instance.

    Static-site stacks still embed a gated compute module. RDS/ElastiCache
    templates always contain ``resource "aws_db_instance"`` with count=0.
    Neither of those should count as a successful EC2 deploy.
    """
    vars_text = tfvars_text or ""
    if re.search(
        r'^\s*compute_strategy\s*=\s*"(s3_cloudfront|cloudfront|s3cloudfront|static_site)"\s*$',
        vars_text,
        flags=re.IGNORECASE | re.MULTILINE,
    ):
        return False
    enable_false = re.search(r'^\s*enable_ec2\s*=\s*false\s*$', vars_text, flags=re.IGNORECASE | re.MULTILINE)
    enable_true = re.search(r'^\s*enable_ec2\s*=\s*true\s*$', vars_text, flags=re.IGNORECASE | re.MULTILINE)
    if enable_false and not enable_true:
        return False
    return _terraform_has_aws_instance(tf_text)


def _ec2_addresses_from_state_list(state_list_output: str) -> list[str]:
    rows: list[str] = []
    for line in (state_list_output or "").splitlines():
        row = line.strip()
        if not row:
            continue
        if "aws_instance." in row:
            rows.append(row)
    return rows


def _missing_required_ec2_error(
    *,
    requests_ec2: bool,
    ec2_fallback_applied: bool,
    ec2_state_resources: list[str],
    ec2_output_evidence: dict[str, str],
) -> str | None:
    if not requests_ec2:
        return None
    if ec2_state_resources or ec2_output_evidence:
        return None
    if ec2_fallback_applied:
        return (
            "Deployment incomplete: EC2 was disabled by quota fallback, so no instance "
            "was provisioned in AWS. Request a vCPU quota increase or free capacity, then retry."
        )
    return (
        "Terraform apply finished but no EC2 instance was found in Terraform state, "
        "outputs, or live AWS. Success requires terraform-aws-modules/ec2-instance "
        "(or aws_instance) to actually create an instance."
    )


def _terraform_has_rds_or_elasticache(tf_text: str) -> bool:
    """Return True if the bundle contains RDS or ElastiCache resources (including module-based)."""
    patterns = [
        r'resource\s+"aws_db_instance"',
        r'resource\s+"aws_elasticache_replication_group"',
        r'resource\s+"aws_elasticache_cluster"',
        r'source\s*=\s*"terraform-aws-modules/rds/',
        r'source\s*=\s*"terraform-aws-modules/elasticache/',
        r'module\s+"db"\s*\{',
        r'module\s+"rds"\s*\{',
        r'module\s+"cache"\s*\{',
        r'module\s+"redis"\s*\{',
    ]
    text = tf_text or ""
    return any(re.search(p, text, flags=re.IGNORECASE) is not None for p in patterns)


def _terraform_has_registry_module(tf_text: str) -> bool:
    """Return True if any file uses a Terraform registry module source (not local or git)."""
    return re.search(
        r'source\s*=\s*"[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+"',
        tf_text or "",
        flags=re.IGNORECASE,
    ) is not None


def _build_provisioning_report(
    state_list_output: str,
    outputs: dict[str, Any],
    apply_log: str,
    tf_text: str,
    has_ec2_resource: bool,
    has_rds_or_elasticache: bool,
) -> dict[str, Any]:
    """Build a per-resource-category provisioning report from terraform state.

    Returns a dict with a ``resources`` list where each entry describes a
    resource category (vpc, ec2, rds, elasticache, …) and whether it was
    planned, provisioned, and any relevant resource IDs or error information.
    """
    state_lines = [line.strip() for line in (state_list_output or "").splitlines() if line.strip()]

    # ---- resource category definitions ----
    _CATEGORIES: list[tuple[str, str, list[str], list[str]]] = [
        # (display_name, key, state_prefixes, tf_resource_patterns)
        ("VPC", "vpc", ["aws_vpc.", "aws_subnet.", "aws_internet_gateway.", "aws_route_table.", "aws_nat_gateway.", "module.vpc."],
         [r'resource\s+"aws_vpc"', r'resource\s+"aws_subnet"', r'terraform-aws-modules/vpc/', r'module\s+"vpc"']),
        ("EC2 Instance", "ec2", ["aws_instance.", "aws_key_pair.", "module.ec2."],
         [r'resource\s+"aws_instance"', r'terraform-aws-modules/ec2-instance', r'module\s+"ec2"']),
        ("Security Group", "security_group", ["aws_security_group."],
         [r'resource\s+"aws_security_group"']),
        ("RDS Database", "rds", ["aws_db_instance.", "aws_db_subnet_group.", "module.db.", "module.rds."],
         [r'resource\s+"aws_db_instance"', r'module\s+"db"', r'module\s+"rds"', r'terraform-aws-modules/rds/']),
        ("ElastiCache / Redis", "elasticache", [
            "aws_elasticache_replication_group.", "aws_elasticache_cluster.",
            "aws_elasticache_subnet_group.", "module.cache.", "module.redis.",
        ], [r'resource\s+"aws_elasticache', r'module\s+"cache"', r'module\s+"redis"']),
        ("S3 Bucket", "s3", ["aws_s3_bucket."],
         [r'resource\s+"aws_s3_bucket"']),
        ("CloudFront", "cloudfront", ["aws_cloudfront_distribution.", "aws_cloudfront_origin_access_control."],
         [r'resource\s+"aws_cloudfront_distribution"']),
        ("IAM", "iam", ["aws_iam_role.", "aws_iam_policy.", "aws_iam_instance_profile.", "aws_iam_role_policy."],
         [r'resource\s+"aws_iam_role"', r'resource\s+"aws_iam_policy"']),
        ("Load Balancer", "alb", ["aws_lb.", "aws_lb_listener.", "aws_lb_target_group.", "aws_alb.", "module.alb."],
         [r'resource\s+"aws_lb"', r'resource\s+"aws_alb"', r'terraform-aws-modules/alb/', r'module\s+"alb"']),
    ]

    resources: list[dict[str, Any]] = []
    total_planned = 0
    total_provisioned = 0
    total_failed = 0

    for display_name, key, state_prefixes, tf_patterns in _CATEGORIES:
        # Was this category planned (present in the .tf files)?
        planned = any(
            re.search(p, tf_text, flags=re.IGNORECASE)
            for p in tf_patterns
        )
        # Was this category provisioned (appears in terraform state)?
        matched_state_lines = [
            s for s in state_lines
            if any(s.startswith(prefix) or f".{prefix}" in s for prefix in state_prefixes)
        ]
        provisioned = len(matched_state_lines) > 0

        # Extract resource IDs from outputs
        resource_ids: list[str] = matched_state_lines[:5]  # cap at 5

        # Detect errors in apply log specific to this category
        error_hint: str | None = None
        if planned and not provisioned:
            # Search apply log for error lines mentioning this resource type
            error_keywords = state_prefixes[:2]
            for log_line in (apply_log or "").splitlines():
                lowered = log_line.lower()
                if "error" in lowered and any(kw.rstrip(".").lower() in lowered for kw in error_keywords):
                    error_hint = log_line.strip()[:300]
                    break

        if planned:
            total_planned += 1
            if provisioned:
                total_provisioned += 1
            else:
                total_failed += 1

        status = "not_planned"
        if planned and provisioned:
            status = "provisioned"
        elif planned and not provisioned:
            status = "failed"

        entry: dict[str, Any] = {
            "name": display_name,
            "key": key,
            "status": status,
            "planned": planned,
            "provisioned": provisioned,
            "resource_count": len(matched_state_lines),
            "resource_ids": resource_ids,
        }
        if error_hint:
            entry["error_hint"] = error_hint

        # Enrich with output values
        if key == "ec2" and provisioned:
            entry["instance_id"] = outputs.get("ec2_instance_id")
            entry["public_ip"] = outputs.get("ec2_public_ip")
        elif key == "rds" and provisioned:
            entry["endpoint"] = (
                outputs.get("rds_endpoint")
                or outputs.get("db_endpoint")
                or outputs.get("postgres_endpoint")
            )
        elif key == "elasticache" and provisioned:
            entry["endpoint"] = (
                outputs.get("redis_endpoint")
                or outputs.get("elasticache_endpoint")
                or outputs.get("cache_endpoint")
            )
        elif key == "vpc" and provisioned:
            entry["vpc_id"] = outputs.get("vpc_id") or outputs.get("ec2_vpc_id")
        elif key == "s3" and provisioned:
            entry["bucket_name"] = outputs.get("website_bucket") or outputs.get("s3_bucket_name")
        elif key == "cloudfront" and provisioned:
            entry["url"] = outputs.get("cloudfront_url") or outputs.get("cloudfront_domain_name")

        if planned:
            resources.append(entry)

    return {
        "resources": resources,
        "total_planned": total_planned,
        "total_provisioned": total_provisioned,
        "total_failed": total_failed,
        "all_succeeded": total_failed == 0,
        "partial": total_provisioned > 0 and total_failed > 0,
    }


def _terraform_default_instance_type(tf_text: str) -> str | None:
    body_match = re.search(
        r'variable\s+"instance_type"\s*\{(?P<body>.*?)\}',
        tf_text or "",
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not body_match:
        return None
    body = body_match.group("body") or ""
    default_match = re.search(r'default\s*=\s*"([^"]+)"', body, flags=re.IGNORECASE)
    if not default_match:
        return None
    value = str(default_match.group(1) or "").strip().lower()
    return value or None


def _terraform_literal_instance_types(tf_text: str) -> list[str]:
    values = [
        str(match.group(1) or "").strip().lower()
        for match in re.finditer(r'instance_type\s*=\s*"([^"]+)"', tf_text or "", flags=re.IGNORECASE)
    ]
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value in seen:
            continue
        deduped.append(value)
        seen.add(value)
    return deduped


def _preferred_azs_for_region(aws_region: str, max_count: int = 3) -> list[str]:
    region = str(aws_region or "").strip().lower()
    if not re.match(r"^[a-z]{2}-[a-z0-9-]+-\d+$", region):
        return []
    suffixes = ["a", "b", "c", "d", "e", "f"]
    return [f"{region}{suffix}" for suffix in suffixes[: max(1, min(max_count, len(suffixes)))]]


def _get_instance_vcpus(ec2_client: Any, instance_type: str) -> int | None:
    try:
        resp = ec2_client.describe_instance_types(InstanceTypes=[instance_type])
        entries = resp.get("InstanceTypes") or []
        if not entries:
            return None
        info = entries[0] or {}
        vcpu_info = info.get("VCpuInfo") or {}
        vcpus = int(vcpu_info.get("DefaultVCpus") or 0)
        return vcpus if vcpus > 0 else None
    except Exception:
        return None


def _get_standard_vcpu_quota(session: Any, aws_region: str) -> float | None:
    try:
        sq = session.client("service-quotas", region_name=aws_region)
        resp = sq.get_service_quota(
            ServiceCode="ec2",
            QuotaCode=_EC2_STANDARD_ONDEMAND_VCPU_QUOTA_CODE,
        )
        quota = (((resp or {}).get("Quota") or {}).get("Value"))
        if quota is None:
            return None
        value = float(quota)
        return value if value > 0 else None
    except Exception:
        return None


def _count_running_standard_vcpus(ec2_client: Any) -> int | None:
    try:
        paginator = ec2_client.get_paginator("describe_instances")
        type_names: set[str] = set()
        for page in paginator.paginate(
            Filters=[{"Name": "instance-state-name", "Values": ["pending", "running"]}],
            PaginationConfig={"PageSize": 200},
        ):
            for reservation in page.get("Reservations") or []:
                for instance in reservation.get("Instances") or []:
                    t = str(instance.get("InstanceType") or "").strip().lower()
                    if not t:
                        continue
                    family_prefix = t.split(".", 1)[0][:1]
                    if family_prefix in _EC2_STANDARD_FAMILY_PREFIXES:
                        type_names.add(t)
        if not type_names:
            return 0

        type_to_vcpus: dict[str, int] = {}
        pending = sorted(type_names)
        while pending:
            batch = pending[:100]
            pending = pending[100:]
            desc = ec2_client.describe_instance_types(InstanceTypes=batch)
            for item in desc.get("InstanceTypes") or []:
                name = str(item.get("InstanceType") or "").strip().lower()
                vcpu = int(((item.get("VCpuInfo") or {}).get("DefaultVCpus") or 0))
                if name and vcpu > 0:
                    type_to_vcpus[name] = vcpu

        used_vcpus = 0
        for page in paginator.paginate(
            Filters=[{"Name": "instance-state-name", "Values": ["pending", "running"]}],
            PaginationConfig={"PageSize": 200},
        ):
            for reservation in page.get("Reservations") or []:
                for instance in reservation.get("Instances") or []:
                    t = str(instance.get("InstanceType") or "").strip().lower()
                    if not t:
                        continue
                    family_prefix = t.split(".", 1)[0][:1]
                    if family_prefix not in _EC2_STANDARD_FAMILY_PREFIXES:
                        continue
                    used_vcpus += int(type_to_vcpus.get(t) or 0)

        return used_vcpus
    except Exception:
        return None


def _ordered_instance_candidates(preferred: str | None, enforce_free_tier: bool) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    base_order = _FREE_TIER_EC2_INSTANCE_ORDER if enforce_free_tier else _SAFE_EC2_INSTANCE_ORDER
    if preferred:
        p = preferred.strip().lower()
        if p and (not enforce_free_tier or p in set(base_order)):
            ordered.append(p)
            seen.add(p)
    for value in base_order:
        if value not in seen:
            ordered.append(value)
            seen.add(value)
    return ordered


def _inspect_website_bucket(
    bucket_name: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str,
    aws_region: str,
) -> dict[str, Any]:
    # Keep post-apply bucket checks fast so UI isn't stuck after infra is already up.
    s3_cfg = Config(connect_timeout=5, read_timeout=8, retries={"max_attempts": 2, "mode": "standard"})
    session = boto3.session.Session(
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
        aws_session_token=aws_session_token or None,
        region_name=aws_region,
    )
    s3 = session.client("s3", config=s3_cfg)

    object_count = 0
    has_policy = False
    block_public_access = "unknown"

    listed = s3.list_objects_v2(Bucket=bucket_name, MaxKeys=1000)
    object_count = int(listed.get("KeyCount") or 0)

    try:
        s3.get_bucket_policy(Bucket=bucket_name)
        has_policy = True
    except Exception as exc:
        code = str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))
        if code not in {"NoSuchBucketPolicy", "NoSuchPolicy"}:
            raise

    try:
        bpa = s3.get_public_access_block(Bucket=bucket_name)
        cfg = bpa.get("PublicAccessBlockConfiguration") or {}
        all_true = all(bool(cfg.get(k, False)) for k in (
            "BlockPublicAcls",
            "IgnorePublicAcls",
            "BlockPublicPolicy",
            "RestrictPublicBuckets",
        ))
        all_false = all(not bool(cfg.get(k, False)) for k in (
            "BlockPublicAcls",
            "IgnorePublicAcls",
            "BlockPublicPolicy",
            "RestrictPublicBuckets",
        ))
        if all_true:
            block_public_access = "on"
        elif all_false:
            block_public_access = "off"
        else:
            block_public_access = "partial"
    except Exception as exc:
        code = str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))
        if code in {"NoSuchPublicAccessBlockConfiguration", "NoSuchPublicAccessBlock"}:
            block_public_access = "not_configured"
        else:
            raise

    return {
        "bucket": bucket_name,
        "object_count": object_count,
        "has_policy": has_policy,
        "block_public_access": block_public_access,
    }


def _extract_assignment_string(text: str, key: str) -> str | None:
    patterns = [
        rf"(?mi)^\s*{re.escape(key)}\s*=\s*\"([^\"\n]+)\"",
        rf"(?mi)^\s*{re.escape(key)}\s*=\s*([^#\s\n]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text or "")
        if not match:
            continue
        value = str(match.group(1) or "").strip().strip('"').strip("'")
        if value:
            return value
    return None


def _is_unresolved_template_value(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    lowered = raw.lower()
    return "${" in raw or "}" in raw or "var." in lowered or "random_" in lowered


def _extract_s3_backend_values(tf_text: str) -> tuple[str | None, str | None]:
    backend_blocks = re.finditer(r'(?is)backend\s+"s3"\s*\{(.*?)\}', tf_text or "")
    for match in backend_blocks:
        body = str(match.group(1) or "")
        bucket = _extract_assignment_string(body, "bucket")
        lock_table = _extract_assignment_string(body, "dynamodb_table")
        return bucket, lock_table
    return None, None


def _discover_remote_state_backend(files: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    tfvars_chunks: list[str] = []
    tf_chunks: list[str] = []

    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if path.endswith(".tfvars"):
            tfvars_chunks.append(_extract_text_payload(item))
        elif path.endswith(".tf"):
            tf_chunks.append(_extract_text_payload(item))

    tfvars_text = "\n".join(tfvars_chunks)
    tf_text = "\n".join(tf_chunks)
    backend_bucket, backend_lock_table = _extract_s3_backend_values(tf_text)

    bucket_candidate = (
        _extract_assignment_string(tfvars_text, "tf_state_bucket")
        or _extract_assignment_string(tfvars_text, "state_bucket")
        or backend_bucket
    )
    lock_table_candidate = (
        _extract_assignment_string(tfvars_text, "tf_lock_table")
        or _extract_assignment_string(tfvars_text, "lock_table")
        or backend_lock_table
    )

    bucket = None if _is_unresolved_template_value(bucket_candidate) else bucket_candidate
    lock_table = None if _is_unresolved_template_value(lock_table_candidate) else lock_table_candidate
    return bucket, lock_table


def _is_missing_remote_state_error(text: str) -> bool:
    value = (text or "").lower()
    return any(
        marker in value
        for marker in (
            "nosuchbucket",
            "failed to get existing workspaces",
            "the referenced s3 bucket must have been previously created",
            "resourcenotfoundexception",
            "dynamodb table",
        )
    )


def _is_backend_region_mismatch_error(text: str) -> bool:
    value = (text or "").lower()
    return "requested bucket from" in value and "actual location" in value


def _extract_actual_bucket_region(text: str) -> str | None:
    match = re.search(r'actual location\s+"([a-z0-9-]+)"', str(text or ""), flags=re.IGNORECASE)
    if not match:
        return None
    region = str(match.group(1) or "").strip().lower()
    return region or None


def _normalize_s3_bucket_region(location: str | None) -> str:
    value = str(location or "").strip()
    if not value:
        return "us-east-1"
    lowered = value.lower()
    if lowered == "eu":
        return "eu-west-1"
    return lowered


def _ensure_remote_state_backend(
    *,
    state_bucket: str | None,
    lock_table: str | None,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str,
    aws_region: str,
    apply_context: dict[str, Any] | None,
) -> dict[str, Any]:
    state_bucket_name = str(state_bucket or "").strip()
    lock_table_name = str(lock_table or "").strip()
    result: dict[str, Any] = {
        "state_bucket": state_bucket_name or None,
        "lock_table": lock_table_name or None,
        "state_bucket_created": False,
        "lock_table_created": False,
        "state_bucket_region": None,
    }

    if not state_bucket_name and not lock_table_name:
        return result

    session = boto3.session.Session(
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
        aws_session_token=aws_session_token or None,
        region_name=aws_region,
    )
    aws_cfg = Config(connect_timeout=8, read_timeout=15, retries={"max_attempts": 3, "mode": "standard"})

    if state_bucket_name:
        s3 = session.client("s3", region_name=aws_region, config=aws_cfg)
        try:
            s3.head_bucket(Bucket=state_bucket_name)
            location = s3.get_bucket_location(Bucket=state_bucket_name).get("LocationConstraint")
            result["state_bucket_region"] = _normalize_s3_bucket_region(str(location) if location else None)
        except ClientError as exc:
            code = str((exc.response or {}).get("Error", {}).get("Code", ""))
            status = int((exc.response or {}).get("ResponseMetadata", {}).get("HTTPStatusCode", 0) or 0)
            if code in {"404", "NoSuchBucket", "NotFound"} or status == 404:
                _emit_progress(apply_context, "info", f"Creating missing Terraform state bucket {state_bucket_name}.")
                create_params: dict[str, Any] = {"Bucket": state_bucket_name}
                if str(aws_region).strip().lower() != "us-east-1":
                    create_params["CreateBucketConfiguration"] = {"LocationConstraint": aws_region}
                s3.create_bucket(**create_params)
                result["state_bucket_created"] = True
                result["state_bucket_region"] = str(aws_region).strip().lower() or "us-east-1"
            else:
                raise RuntimeError(
                    f"Unable to access Terraform state bucket {state_bucket_name}: {code or str(exc)}"
                ) from exc

        # Enforce required durability controls for state backend.
        try:
            s3.put_bucket_versioning(
                Bucket=state_bucket_name,
                VersioningConfiguration={"Status": "Enabled"},
            )
            s3.put_bucket_encryption(
                Bucket=state_bucket_name,
                ServerSideEncryptionConfiguration={
                    "Rules": [
                        {
                            "ApplyServerSideEncryptionByDefault": {
                                "SSEAlgorithm": "AES256",
                            }
                        }
                    ]
                },
            )
        except Exception as exc:
            raise RuntimeError(
                f"Unable to enforce versioning/encryption for Terraform state bucket {state_bucket_name}: {exc}"
            ) from exc

    if lock_table_name:
        ddb = session.client("dynamodb", region_name=aws_region, config=aws_cfg)
        try:
            ddb.describe_table(TableName=lock_table_name)
        except ClientError as exc:
            code = str((exc.response or {}).get("Error", {}).get("Code", ""))
            if code == "ResourceNotFoundException":
                _emit_progress(apply_context, "info", f"Creating missing Terraform lock table {lock_table_name}.")
                ddb.create_table(
                    TableName=lock_table_name,
                    AttributeDefinitions=[{"AttributeName": "LockID", "AttributeType": "S"}],
                    KeySchema=[{"AttributeName": "LockID", "KeyType": "HASH"}],
                    BillingMode="PAY_PER_REQUEST",
                )
                ddb.get_waiter("table_exists").wait(TableName=lock_table_name)
                result["lock_table_created"] = True
            else:
                raise RuntimeError(
                    f"Unable to access Terraform lock table {lock_table_name}: {code or str(exc)}"
                ) from exc

    return result


def _terraform_init_args(backend_region_override: str | None, upgrade: bool = False) -> list[str]:
    args = ["init", "-input=false", "-no-color"]
    if upgrade:
        args.append("-upgrade")
    if str(backend_region_override or "").strip():
        args.append(f"-backend-config=region={str(backend_region_override).strip()}")
    return args


def apply_terraform_bundle(
    files: list[dict[str, Any]],
    project_name: str,
    provider: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str,
    aws_region: str,
    state_bucket: str = "",
    lock_table: str = "",
    enforce_free_tier_ec2: bool = True,
    confirm_apply: bool = False,
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if provider.lower() != "aws":
        return {"success": False, "error": "Runtime apply currently supports AWS only."}

    aws_access_key_id = str(aws_access_key_id or "").strip().strip('"').strip("'")
    aws_secret_access_key = str(aws_secret_access_key or "").strip().strip('"').strip("'")
    aws_session_token = str(aws_session_token or "").strip().strip('"').strip("'")
    aws_region = str(aws_region or "").strip() or "eu-north-1"

    if not files:
        _emit_progress(apply_context, "error", "Terraform apply aborted: no files were provided.")
        return {"success": False, "error": "No files were provided for Terraform apply."}

    if not aws_access_key_id or not aws_secret_access_key:
        _emit_progress(apply_context, "error", "Terraform apply aborted: AWS credentials are missing.")
        return {"success": False, "error": "AWS credentials are required for runtime Terraform apply."}
    if aws_access_key_id.upper().startswith("ASIA") and not aws_session_token:
        message = "AWS_SESSION_TOKEN is required when using temporary ASIA credentials."
        _emit_progress(apply_context, "error", f"Terraform apply aborted: {message}")
        return {
            "success": False,
            "error": message,
            "details": {
                "hint": "Paste the session token issued with the temporary access key, or use long-lived IAM credentials.",
            },
        }

    docker = get_docker_client()
    volume_name = f"deplai_tf_apply_{uuid.uuid4().hex[:12]}"
    volume = docker.volumes.create(name=volume_name)

    fmt_log = ""
    init_log = ""
    validate_log = ""
    plan_log = ""
    plan_json_log = ""
    apply_log = ""
    backend_bootstrap: dict[str, Any] = {}
    backend_region_override: str | None = None
    bundle_remediation: dict[str, Any] = {}

    try:
        normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
        _write_files_to_volume(volume_name, files)
        files, contract_remediation = enforce_registry_contracts(files)
        if any(bool(value) for value in contract_remediation.values()):
            bundle_remediation.update(contract_remediation)
            normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
            _write_files_to_volume(volume_name, files)
            _emit_progress(
                apply_context,
                "info",
                "Applied internal Terraform registry contract remediations to the bundle.",
            )
        # Always pin AWS provider to registry 5.x when EC2 5.x / ALB 9.x are present.
        files = _normalize_aws_provider_to_registry_pin(files, apply_context)
        normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
        _write_files_to_volume(volume_name, files)
        if _legacy_runtime_bundle_needs_remediation(files):
            files, legacy_remediation = _remediate_legacy_runtime_bundle(files, apply_context)
            bundle_remediation = {**bundle_remediation, **legacy_remediation}
            normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
            _write_files_to_volume(volume_name, files)
        files, vpc_lookup_remediation = _rewrite_hard_default_vpc_lookup(files)
        if vpc_lookup_remediation.get("default_vpc_lookup_softened"):
            bundle_remediation.update(vpc_lookup_remediation)
            normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
            _write_files_to_volume(volume_name, files)
            _emit_progress(
                apply_context,
                "info",
                "Rewrote hardcoded default-VPC lookups so regions without a default VPC can still apply.",
            )
        files, key_rotation_remediation = _ensure_unique_ec2_key_pair(files)
        if any(bool(value) for value in key_rotation_remediation.values()):
            bundle_remediation.update(key_rotation_remediation)
            normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
            _write_files_to_volume(volume_name, files)
            _emit_progress(
                apply_context,
                "info",
                "Each deploy mints a new EC2 SSH key tagged with the instance ID. Download the PEM and database password once — DeplAI does not keep them.",
            )
        # Normalize AWS provider version constraints when bundle mixes EC2 and
        # RDS/ElastiCache templates (keep registry 5.x pin — never bump to 6.x here).
        tf_text_preflight = _collect_terraform_text(files)
        bundle_has_rds_or_elasticache = _terraform_has_rds_or_elasticache(tf_text_preflight)
        bundle_has_registry_module = _terraform_has_registry_module(tf_text_preflight)
        if bundle_has_rds_or_elasticache:
            files = _normalize_rds_elasticache_provider_versions(files, apply_context)
        files = _normalize_rds_engine_versions(files, apply_context)
        files = _ensure_ssm_managed_instance_core(files, apply_context)
        files = _ensure_ecr_pull_policy(files, apply_context)
        files, artifact_guard = _remediate_app_artifact_filemd5(files, apply_context)
        if artifact_guard.get("app_artifact_filemd5_guarded"):
            bundle_remediation.update(artifact_guard)
            normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
            _write_files_to_volume(volume_name, files)
        files = _inject_app_artifact_tarball(files, apply_context, project_name)
        normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
        _write_files_to_volume(volume_name, files)
        _emit_progress(apply_context, "info", "Terraform files staged into runtime workspace.")

        if not any(path.endswith(".tf") for path in normalized_paths):
            return {
                "success": False,
                "error": "Standard Terraform bundle is missing .tf configuration files.",
                "details": {
                    "terraform_root": "/workspace/terraform",
                    "received_paths": normalized_paths[:50],
                },
            }

        has_terraform_dir = any(path == "terraform" or path.startswith("terraform/") for path in normalized_paths)
        tf_root = "/workspace/terraform" if has_terraform_dir else "/workspace"

        env = {
            "AWS_ACCESS_KEY_ID": aws_access_key_id,
            "AWS_SECRET_ACCESS_KEY": aws_secret_access_key,
            "AWS_DEFAULT_REGION": aws_region,
            "TF_IN_AUTOMATION": "1",
            "AWS_RETRY_MODE": "adaptive",
            "AWS_MAX_ATTEMPTS": "10",
        }
        if aws_session_token:
            env["AWS_SESSION_TOKEN"] = aws_session_token

        auto_bootstrap_backend = str(
            os.getenv("DEPLAI_AUTO_BOOTSTRAP_TERRAFORM_BACKEND", "1")
        ).strip().lower() in {"1", "true", "yes"}
        discovered_bucket, discovered_lock_table = _discover_remote_state_backend(files)
        state_bucket_name = str(state_bucket or "").strip() or discovered_bucket
        lock_table_name = str(lock_table or "").strip() or discovered_lock_table

        if auto_bootstrap_backend and (state_bucket_name or lock_table_name):
            try:
                backend_bootstrap = _ensure_remote_state_backend(
                    state_bucket=state_bucket_name,
                    lock_table=lock_table_name,
                    aws_access_key_id=aws_access_key_id,
                    aws_secret_access_key=aws_secret_access_key,
                    aws_session_token=aws_session_token,
                    aws_region=aws_region,
                    apply_context=apply_context,
                )
                backend_region_override = str(backend_bootstrap.get("state_bucket_region") or "").strip() or None
            except Exception as exc:
                return {
                    "success": False,
                    "error": f"Terraform backend bootstrap failed: {exc}",
                    "details": {
                        "terraform_root": tf_root,
                        "state_bucket": state_bucket_name,
                        "lock_table": lock_table_name,
                        "bundle_remediation": bundle_remediation,
                    },
                }

        try:
            fmt_log = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                ["fmt", "-recursive", "-no-color"],
                env,
                apply_context=apply_context,
            )
        except Exception as fmt_exc:
            return {
                "success": False,
                "error": f"terraform fmt failed: {fmt_exc}",
                "details": {
                    "terraform_root": tf_root,
                    "fmt_log_tail": _tail(str(fmt_exc)),
                    "backend_bootstrap": backend_bootstrap,
                    "bundle_remediation": bundle_remediation,
                },
            }

        # Exact module pins + lock file: never auto -upgrade (that floats modules to
        # newest majors that often require AWS provider 6.x). Opt in via apply_context.
        use_upgrade_init = bool(apply_context and apply_context.get("terraform_init_upgrade"))
        if use_upgrade_init:
            _emit_progress(
                apply_context,
                "warning",
                "Running terraform init -upgrade (review .terraform.lock.hcl diff afterward).",
            )
        try:
            init_log = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                _terraform_init_args(backend_region_override, upgrade=use_upgrade_init),
                env,
                apply_context=apply_context,
            )
        except Exception as init_exc:
            init_error = str(init_exc)
            lowered_init = init_error.lower()
            if any(
                marker in lowered_init
                for marker in (
                    "failed to download",
                    "error downloading",
                    "could not download",
                    "unable to download",
                    "failed to retrieve module",
                )
            ):
                return {
                    "success": False,
                    "error": (
                        "Terraform failed to download pinned AWS modules from the Terraform Registry. "
                        "Apply cannot succeed without terraform-aws-modules/vpc, ec2-instance, and alb. "
                        f"Init error: {_tail(init_error, 800)}"
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_error),
                    },
                }
            actual_region_from_error = _extract_actual_bucket_region(init_error)
            needs_retry = _is_missing_remote_state_error(init_error) or _is_backend_region_mismatch_error(init_error)
            # Do not auto-retry with -upgrade: open module floors + upgrade grabs 6.x-requiring modules.
            if needs_retry:
                if auto_bootstrap_backend:
                    backend_bootstrap = _ensure_remote_state_backend(
                        state_bucket=state_bucket_name,
                        lock_table=lock_table_name,
                        aws_access_key_id=aws_access_key_id,
                        aws_secret_access_key=aws_secret_access_key,
                        aws_session_token=aws_session_token,
                        aws_region=aws_region,
                        apply_context=apply_context,
                    )
                    backend_region_override = (
                        actual_region_from_error
                        or str(backend_bootstrap.get("state_bucket_region") or "").strip()
                        or backend_region_override
                    )
                    _emit_progress(apply_context, "info", "Retrying terraform init after backend bootstrap.")
                    init_log = _run_terraform_with_tracking(
                        volume_name,
                        tf_root,
                        _terraform_init_args(backend_region_override, upgrade=use_upgrade_init),
                        env,
                        apply_context=apply_context,
                    )
                else:
                    raise
            elif init_error:
                raise
        if apply_context and apply_context.get("cancel_requested"):
            _emit_progress(apply_context, "error", "Terraform apply cancelled during init.")
            return {
                "success": False,
                "error": "Deployment stopped by user.",
                "details": {
                    "terraform_root": tf_root,
                    "fmt_log_tail": _tail(fmt_log),
                    "init_log_tail": _tail(init_log),
                },
            }

        validate_log = _run_terraform_with_tracking(
            volume_name,
            tf_root,
            ["validate", "-no-color"],
            env,
            apply_context=apply_context,
        )
        if apply_context and apply_context.get("cancel_requested"):
            _emit_progress(apply_context, "error", "Terraform apply cancelled during validate.")
            return {
                "success": False,
                "error": "Deployment stopped by user.",
                "details": {
                    "terraform_root": tf_root,
                    "fmt_log_tail": _tail(fmt_log),
                    "init_log_tail": _tail(init_log),
                    "validate_log_tail": _tail(validate_log),
                },
            }

        tf_text = _collect_terraform_text(files)
        tfvars_text = _collect_tfvars_text(files)
        root_tf_text = _collect_root_terraform_text(files)
        has_ec2_resource = _terraform_has_aws_instance(tf_text)
        requests_ec2 = _bundle_requests_ec2(tf_text, tfvars_text)
        has_rds_or_elasticache = _terraform_has_rds_or_elasticache(tf_text)
        has_instance_type_var = _terraform_has_variable(root_tf_text, "instance_type")
        has_enable_ec2_var = _terraform_has_variable(root_tf_text, "enable_ec2")
        has_aws_region_var = _terraform_has_variable(root_tf_text, "aws_region")
        has_preferred_azs_var = _terraform_has_variable(root_tf_text, "preferred_availability_zones")
        has_existing_key_name_var = _terraform_has_variable(root_tf_text, "existing_ec2_key_pair_name")
        has_ec2_key_rotation_var = _terraform_has_variable(root_tf_text, "ec2_key_rotation")
        has_use_default_vpc_var = _terraform_has_variable(root_tf_text, "use_default_vpc")
        preferred_azs = _preferred_azs_for_region(aws_region)
        selected_az_order = [*preferred_azs]
        attempted_az_orders: list[list[str]] = [[*preferred_azs]] if preferred_azs else []
        use_default_vpc_override: bool | None = None
        if has_use_default_vpc_var:
            try:
                vpc_session = boto3.session.Session(
                    aws_access_key_id=aws_access_key_id,
                    aws_secret_access_key=aws_secret_access_key,
                    aws_session_token=aws_session_token or None,
                    region_name=aws_region,
                )
                vpc_ec2 = vpc_session.client("ec2", region_name=aws_region)
                has_default_vpc = _region_has_default_vpc(vpc_ec2)
                if has_default_vpc is False:
                    use_default_vpc_override = False
                    _emit_progress(
                        apply_context,
                        "info",
                        f"No default VPC in {aws_region}. Terraform will create a dedicated VPC instead of failing lookup.",
                    )
            except Exception as vpc_exc:
                _emit_progress(
                    apply_context,
                    "warning",
                    f"Could not check for a default VPC in {aws_region}: {vpc_exc}",
                )
        enforce_free_tier = bool(enforce_free_tier_ec2)
        allowed_instance_types = _FREE_TIER_EC2_INSTANCE_ORDER if enforce_free_tier else _SAFE_EC2_INSTANCE_ORDER
        allowed_instance_type_set = set(allowed_instance_types)

        ec2_fallback_applied = False
        precheck_disable_ec2 = False
        apply_mode = "default"
        selected_instance_type: str | None = None
        quota_info: dict[str, Any] = {}
        attempted_instance_types: list[str] = []
        plan_args_base = ["plan", "-input=false", "-no-color", "-parallelism=20"]
        apply_args_base = ["apply", "-auto-approve", "-input=false", "-no-color", "-parallelism=20"]
        saved_plan_path = "deplai-runtime.tfplan"
        allow_disable_fallback = str(
            os.getenv("DEPLAI_ALLOW_EC2_DISABLE_FALLBACK", "0")
        ).strip().lower() in {"1", "true", "yes"}
        requested_instance_type = (
            os.getenv("DEPLAI_EC2_INSTANCE_TYPE", "").strip().lower()
            or _terraform_default_instance_type(tf_text)
            or "t3.micro"
        )
        existing_key_name_override: str | None = None
        key_rotation = _new_ec2_key_rotation()
        instance_candidates = _ordered_instance_candidates(
            requested_instance_type,
            enforce_free_tier=enforce_free_tier,
        )
        if not (has_ec2_resource and has_instance_type_var):
            instance_candidates = []

        # Always mint a new TLS key for this apply. Reusing an AWS key pair
        # hides the private half (AWS never stores it) and leaves the user
        # without a PEM. Collision retries use a fresh rotation suffix instead.
        if has_existing_key_name_var:
            _emit_progress(
                apply_context,
                "info",
                f"Generating a new EC2 key pair for this deploy (rotation {key_rotation}); existing AWS keys will not be reused.",
            )

        if has_ec2_resource and enforce_free_tier and not has_instance_type_var:
            literal_types = _terraform_literal_instance_types(tf_text)
            disallowed = [itype for itype in literal_types if itype not in allowed_instance_type_set]
            if disallowed:
                return {
                    "success": False,
                    "error": (
                        "Terraform defines non-free-tier EC2 instance types and cannot be overridden "
                        "because variable \"instance_type\" is missing."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "enforce_free_tier_ec2": enforce_free_tier,
                        "allowed_instance_types": allowed_instance_types,
                        "disallowed_literal_instance_types": disallowed,
                        "init_log_tail": _tail(init_log),
                    },
                }

        if has_ec2_resource and has_instance_type_var:
            session = boto3.session.Session(
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=aws_session_token or None,
                region_name=aws_region,
            )
            ec2 = session.client("ec2", region_name=aws_region)
            quota_limit = _get_standard_vcpu_quota(session, aws_region)
            used_vcpus = _count_running_standard_vcpus(ec2)
            quota_info["requested_instance_type"] = requested_instance_type
            quota_info["quota_limit_vcpus"] = quota_limit
            quota_info["used_vcpus"] = used_vcpus
            quota_info["enforce_free_tier_ec2"] = enforce_free_tier
            quota_info["allowed_instance_types"] = allowed_instance_types
            quota_info["preferred_azs"] = selected_az_order

            if quota_limit is not None and used_vcpus is not None:
                headroom_vcpus = float(quota_limit) - float(used_vcpus)
                quota_info["headroom_vcpus"] = max(0.0, headroom_vcpus)
                viable: list[tuple[str, int]] = []
                for itype in instance_candidates:
                    vcpus = _get_instance_vcpus(ec2, itype)
                    if vcpus is None:
                        continue
                    if headroom_vcpus >= float(vcpus):
                        viable.append((itype, vcpus))
                if not viable:
                    quota_is_zero = float(quota_limit or 0.0) <= 0.0
                    used_is_zero = float(used_vcpus or 0.0) <= 0.0
                    if allow_disable_fallback and has_enable_ec2_var:
                        ec2_fallback_applied = True
                        precheck_disable_ec2 = True
                        apply_mode = "ec2_disabled_quota_precheck_fallback"
                        quota_info["quota_diagnosis"] = (
                            "zero_account_quota" if quota_is_zero and used_is_zero else "insufficient_headroom"
                        )
                        quota_info["precheck_disable_ec2"] = True
                    else:
                        if quota_is_zero and used_is_zero:
                            friendly = (
                                f"EC2 quota precheck failed in {aws_region}: account has 0.0 standard-family "
                                "On-Demand vCPU quota in this region. This is an account quota baseline issue "
                                "(not active instances). Request a quota increase for "
                                "'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances' "
                                "or use a region where this quota is available."
                            )
                        else:
                            friendly = (
                                f"EC2 quota precheck failed in {aws_region}: standard-family vCPU "
                                f"headroom is {max(0.0, headroom_vcpus):.1f}, not enough for smallest "
                                "safe instance candidate. Stop/terminate running EC2 instances in this "
                                "region or request a quota increase, then retry."
                            )
                        return {
                            "success": False,
                            "error": friendly,
                            "details": {
                                "terraform_root": tf_root,
                                "quota_info": quota_info,
                                "quota_diagnosis": "zero_account_quota" if quota_is_zero and used_is_zero else "insufficient_headroom",
                                "init_log_tail": _tail(init_log),
                            },
                        }
                if viable:
                    selected_instance_type = viable[0][0]
            else:
                selected_instance_type = instance_candidates[0] if instance_candidates else None

        def _build_apply_args(
            instance_type_override: str | None,
            disable_ec2: bool = False,
            preferred_azs_override: list[str] | None = None,
            existing_key_name: str | None = None,
            force_default_vpc: bool = False,
            use_default_vpc_override_arg: bool | None = None,
            key_rotation_override: str | None = None,
        ) -> list[str]:
            args = [*apply_args_base]
            if has_enable_ec2_var and has_ec2_resource:
                args.append(f"-var=enable_ec2={'false' if disable_ec2 else 'true'}")
            if has_aws_region_var:
                args.append(f"-var=aws_region={aws_region}")
            az_order = preferred_azs_override if preferred_azs_override is not None else preferred_azs
            if has_preferred_azs_var and az_order:
                args.append(f"-var=preferred_availability_zones={json.dumps(az_order)}")
            vpc_override = True if force_default_vpc else use_default_vpc_override_arg
            if vpc_override is None:
                vpc_override = use_default_vpc_override
            if vpc_override is not None and has_use_default_vpc_var:
                args.append(f"-var=use_default_vpc={'true' if vpc_override else 'false'}")
            if has_existing_key_name_var:
                args.append('-var=existing_ec2_key_pair_name=')
            rotation = key_rotation_override if key_rotation_override is not None else key_rotation
            if has_ec2_key_rotation_var and rotation:
                args.append(f"-var=ec2_key_rotation={rotation}")
            if instance_type_override:
                args.append(f"-var=instance_type={instance_type_override}")
            return args

        def _build_plan_args(
            instance_type_override: str | None,
            disable_ec2: bool = False,
            preferred_azs_override: list[str] | None = None,
            existing_key_name: str | None = None,
            force_default_vpc: bool = False,
            output_path: str | None = None,
            use_default_vpc_override_arg: bool | None = None,
            key_rotation_override: str | None = None,
        ) -> list[str]:
            args = [*plan_args_base]
            if has_enable_ec2_var and has_ec2_resource:
                args.append(f"-var=enable_ec2={'false' if disable_ec2 else 'true'}")
            if has_aws_region_var:
                args.append(f"-var=aws_region={aws_region}")
            az_order = preferred_azs_override if preferred_azs_override is not None else preferred_azs
            if has_preferred_azs_var and az_order:
                args.append(f"-var=preferred_availability_zones={json.dumps(az_order)}")
            vpc_override = True if force_default_vpc else use_default_vpc_override_arg
            if vpc_override is None:
                vpc_override = use_default_vpc_override
            if vpc_override is not None and has_use_default_vpc_var:
                args.append(f"-var=use_default_vpc={'true' if vpc_override else 'false'}")
            if has_existing_key_name_var:
                args.append('-var=existing_ec2_key_pair_name=')
            rotation = key_rotation_override if key_rotation_override is not None else key_rotation
            if has_ec2_key_rotation_var and rotation:
                args.append(f"-var=ec2_key_rotation={rotation}")
            if instance_type_override:
                args.append(f"-var=instance_type={instance_type_override}")
            if output_path:
                args.append(f"-out={output_path}")
            return args

        ec2_plan_changes: dict[str, Any] = _summarize_ec2_plan_changes(None)
        plan_json_error: str | None = None
        try:
            plan_log = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                _build_plan_args(
                    selected_instance_type,
                    disable_ec2=precheck_disable_ec2,
                    preferred_azs_override=selected_az_order,
                    existing_key_name=existing_key_name_override,
                    force_default_vpc=False,
                    output_path=saved_plan_path,
                ),
                env,
                apply_context=apply_context,
            )
            try:
                plan_json_log = _run_terraform_with_tracking(
                    volume_name,
                    tf_root,
                    ["show", "-json", saved_plan_path],
                    env,
                    apply_context=apply_context,
                )
                ec2_plan_changes = _summarize_ec2_plan_changes(json.loads(plan_json_log or "{}"))
            except Exception as plan_json_exc:
                plan_json_error = str(plan_json_exc)
                ec2_plan_changes = _summarize_ec2_plan_changes(None)
            plan_counts = _parse_plan_change_counts(plan_log)
            plan_summary = {
                "total_resources": plan_counts,
                "terraform_root": tf_root,
                "selected_instance_type": selected_instance_type,
                "ec2_disabled": precheck_disable_ec2,
                "ec2_plan_changes": ec2_plan_changes,
                "state_bucket": state_bucket_name or None,
                "lock_table": lock_table_name or None,
                "requires_confirmation": True,
            }
            if not confirm_apply:
                _emit_progress(apply_context, "info", "Terraform plan completed and is awaiting confirmation before apply.")
                return {
                    "success": True,
                    "status": "awaiting_plan_confirmation",
                    "outputs": {},
                    "cloudfront_url": None,
                    "plan_summary": plan_summary,
                    "details": {
                        "terraform_root": tf_root,
                        "fmt_log_tail": _tail(fmt_log),
                        "init_log_tail": _tail(init_log),
                        "validate_log_tail": _tail(validate_log),
                        "plan_log_tail": _tail(plan_log),
                        "plan_json_error": plan_json_error,
                        "backend_bootstrap": backend_bootstrap,
                        "bundle_remediation": bundle_remediation,
                        "selected_instance_type": selected_instance_type,
                        "existing_ec2_key_pair_name": None,
                        "key_pair_reused": False,
                        "ec2_key_rotation": key_rotation,
                    },
                }
            args = _build_apply_args(
                selected_instance_type,
                disable_ec2=precheck_disable_ec2,
                preferred_azs_override=selected_az_order,
                existing_key_name=existing_key_name_override,
                force_default_vpc=False,
            )
            if not precheck_disable_ec2:
                args = ["apply", "-input=false", "-no-color", "-parallelism=20", saved_plan_path]
            if precheck_disable_ec2:
                _emit_progress(apply_context, "info", "EC2 quota unavailable. Applying fallback with enable_ec2=false.")
                apply_log = (
                    f"[precheck] EC2 quota/headroom unavailable in {aws_region}; "
                    "proceeding with enable_ec2=false fallback.\n"
                )
            elif selected_instance_type:
                attempted_instance_types.append(selected_instance_type)
                apply_mode = "ec2_forced_small_instance"
            apply_log = f"{apply_log}{_run_terraform_with_tracking(volume_name, tf_root, args, env, apply_context=apply_context)}"
        except Exception as exc:
            if apply_context and apply_context.get("cancel_requested"):
                _emit_progress(apply_context, "error", "Terraform apply cancelled during apply.")
                return {
                    "success": False,
                    "error": "Deployment stopped by user.",
                    "details": {
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "plan_log_tail": _tail(plan_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }
            combined = str(exc).strip()
            stderr = combined
            stdout = ""

            handled_missing_default_vpc = False
            apply_recovered = False
            if _is_transient_aws_api_error(combined):
                transient_errors: list[str] = [_tail(combined, 1200)]
                recovered = False
                retry_log = ""
                for attempt in range(1, 4):
                    if apply_context and apply_context.get("cancel_requested"):
                        _emit_progress(apply_context, "error", "Terraform apply cancelled during DNS/API retry.")
                        return {
                            "success": False,
                            "error": "Deployment stopped by user.",
                            "details": {
                                "terraform_root": tf_root,
                                "init_log_tail": _tail(init_log),
                                "plan_log_tail": _tail(plan_log),
                                "apply_log_tail": _tail(combined, 1800),
                            },
                        }
                    wait_s = 5 * attempt
                    _emit_progress(
                        apply_context,
                        "info",
                        (
                            "Lost connectivity to the AWS API (Docker DNS/network). "
                            f"Retrying apply in {wait_s}s ({attempt}/3). "
                            "Already-created resources stay in remote state."
                        ),
                    )
                    time.sleep(wait_s)
                    try:
                        retry_log = _run_terraform_with_tracking(
                            volume_name,
                            tf_root,
                            _build_apply_args(
                                selected_instance_type,
                                disable_ec2=precheck_disable_ec2,
                                preferred_azs_override=selected_az_order,
                                existing_key_name=existing_key_name_override,
                                force_default_vpc=False,
                            ),
                            env,
                            apply_context=apply_context,
                        )
                        apply_mode = "transient_aws_api_retry"
                        apply_log = (
                            f"{apply_log}\n[attempt-1] apply lost AWS API connectivity.\n"
                            f"{_tail(combined, 900)}\n\n"
                            f"[attempt-retry:{attempt}] apply retry log:\n{retry_log}"
                        )
                        recovered = True
                        break
                    except Exception as retry_exc:
                        retry_combined = str(retry_exc).strip()
                        transient_errors.append(_tail(retry_combined, 900))
                        if apply_context and apply_context.get("cancel_requested"):
                            _emit_progress(apply_context, "error", "Terraform apply cancelled during DNS/API retry.")
                            return {
                                "success": False,
                                "error": "Deployment stopped by user.",
                                "details": {
                                    "terraform_root": tf_root,
                                    "init_log_tail": _tail(init_log),
                                    "apply_log_tail": _tail(retry_combined, 1800),
                                },
                            }
                        if not _is_transient_aws_api_error(retry_combined):
                            combined = retry_combined
                            stderr = combined
                            break
                if recovered:
                    apply_recovered = True
                elif _is_transient_aws_api_error(combined):
                    _emit_progress(apply_context, "error", _transient_aws_api_error_message(combined))
                    return {
                        "success": False,
                        "error": _transient_aws_api_error_message(combined),
                        "details": {
                            "terraform_root": tf_root,
                            "apply_mode": "transient_aws_api_retry_exhausted",
                            "retry_errors": transient_errors[-4:],
                            "init_log_tail": _tail(init_log),
                            "plan_log_tail": _tail(plan_log),
                            "apply_log_tail": _tail(combined, 1800),
                        },
                    }

            if apply_recovered:
                pass
            elif _is_missing_default_vpc_error(combined) and has_use_default_vpc_var:
                _emit_progress(
                    apply_context,
                    "info",
                    f"Default VPC lookup failed in {aws_region}. Retrying Terraform with a dedicated VPC.",
                )
                use_default_vpc_override = False
                try:
                    plan_log = _run_terraform_with_tracking(
                        volume_name,
                        tf_root,
                        _build_plan_args(
                            selected_instance_type,
                            disable_ec2=precheck_disable_ec2,
                            preferred_azs_override=selected_az_order,
                            existing_key_name=existing_key_name_override,
                            use_default_vpc_override_arg=False,
                            output_path=saved_plan_path,
                        ),
                        env,
                        apply_context=apply_context,
                    )
                    try:
                        plan_json_log = _run_terraform_with_tracking(
                            volume_name,
                            tf_root,
                            ["show", "-json", saved_plan_path],
                            env,
                            apply_context=apply_context,
                        )
                        ec2_plan_changes = _summarize_ec2_plan_changes(json.loads(plan_json_log or "{}"))
                    except Exception as plan_json_exc:
                        plan_json_error = str(plan_json_exc)
                        ec2_plan_changes = _summarize_ec2_plan_changes(None)
                    plan_counts = _parse_plan_change_counts(plan_log)
                    plan_summary = {
                        "total_resources": plan_counts,
                        "terraform_root": tf_root,
                        "selected_instance_type": selected_instance_type,
                        "ec2_disabled": precheck_disable_ec2,
                        "ec2_plan_changes": ec2_plan_changes,
                        "state_bucket": state_bucket_name or None,
                        "lock_table": lock_table_name or None,
                        "requires_confirmation": True,
                        "created_dedicated_vpc": True,
                    }
                    if not confirm_apply:
                        _emit_progress(
                            apply_context,
                            "info",
                            "Terraform plan completed without a default VPC and is awaiting confirmation before apply.",
                        )
                        return {
                            "success": True,
                            "status": "awaiting_plan_confirmation",
                            "outputs": {},
                            "cloudfront_url": None,
                            "plan_summary": plan_summary,
                            "details": {
                                "terraform_root": tf_root,
                                "fmt_log_tail": _tail(fmt_log),
                                "init_log_tail": _tail(init_log),
                                "validate_log_tail": _tail(validate_log),
                                "plan_log_tail": _tail(plan_log),
                                "plan_json_error": plan_json_error,
                                "backend_bootstrap": backend_bootstrap,
                                "bundle_remediation": bundle_remediation,
                                "selected_instance_type": selected_instance_type,
                                "existing_ec2_key_pair_name": None,
                                "key_pair_reused": False,
                                "ec2_key_rotation": key_rotation,
                                "use_default_vpc": False,
                            },
                        }
                    apply_mode = "dedicated_vpc_fallback"
                    apply_log = (
                        f"[attempt-1] plan/apply failed: no default VPC in {aws_region}.\n"
                        f"{_tail(combined, 900)}\n\n"
                        "[attempt-retry:use_default_vpc=false] apply log:\n"
                    )
                    apply_log = (
                        f"{apply_log}"
                        f"{_run_terraform_with_tracking(volume_name, tf_root, ['apply', '-input=false', '-no-color', '-parallelism=20', saved_plan_path], env, apply_context=apply_context)}"
                    )
                    handled_missing_default_vpc = True
                except Exception as retry_exc:
                    retry_combined = str(retry_exc).strip()
                    if "VpcLimitExceeded" in retry_combined:
                        retry_error = (
                            f"No default VPC exists in {aws_region}, and creating a dedicated VPC hit AWS VPC quota. "
                            "Delete unused VPCs or request a quota increase, then retry."
                        )
                    else:
                        retry_error = (
                            f"No default VPC exists in {aws_region}, and creating a dedicated VPC also failed. "
                            f"{retry_combined}"
                        )
                    return {
                        "success": False,
                        "error": retry_error,
                        "details": {
                            "terraform_root": tf_root,
                            "init_log_tail": _tail(init_log),
                            "plan_log_tail": _tail(plan_log),
                            "apply_log_tail": _tail(retry_combined, 1800),
                        },
                    }

            if apply_recovered or handled_missing_default_vpc:
                pass
            elif "VpcLimitExceeded" in combined:
                return {
                    "success": False,
                    "error": (
                        "AWS VPC quota exceeded and the provided Terraform bundle still creates a new VPC. "
                        "Regenerate IaC with default-VPC mode (latest Stage 8 template) and retry, or clean up unused VPCs."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(combined, 1800),
                    },
                }

            elif "OriginAccessControlAlreadyExists" in combined:
                return {
                    "success": False,
                    "error": (
                        "CloudFront Origin Access Control name conflict detected in Terraform bundle. "
                        "Regenerate IaC with unique OAC naming (latest Stage 8 template) and retry."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(combined, 1800),
                    },
                }

            elif "InvalidAMIID.NotFound" in combined:
                return {
                    "success": False,
                    "error": (
                        "Terraform bundle references an invalid or region-mismatched AMI. "
                        "Runtime remediation attempted to swap hardcoded AMI values to a region-safe Amazon Linux 2023 lookup, "
                        "but EC2 creation still failed. Regenerate Terraform and retry."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "bundle_remediation": bundle_remediation,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(combined, 1800),
                    },
                }

            elif "At least two subnets in two different Availability Zones must be specified" in combined:
                return {
                    "success": False,
                    "error": (
                        "Terraform bundle configured an ALB with only one subnet/AZ. "
                        "Runtime remediation attempted to patch legacy single-subnet ALB topology, "
                        "but ALB validation still failed. Regenerate Terraform with multi-AZ networking and retry."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "bundle_remediation": bundle_remediation,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(combined, 1800),
                    },
                }

            elif _is_orphan_key_pair_collision(combined) and not _is_orphan_alb_collision(combined) and has_ec2_key_rotation_var:
                key_rotation = _new_ec2_key_rotation()
                _emit_progress(
                    apply_context,
                    "info",
                    f"EC2 key pair name already exists in AWS. Creating a new key ({key_rotation}) instead of reusing a key with no private PEM.",
                )
                try:
                    retry_log = _run_terraform_with_tracking(
                        volume_name,
                        tf_root,
                        _build_apply_args(
                            selected_instance_type,
                            preferred_azs_override=selected_az_order,
                            existing_key_name=None,
                            force_default_vpc=False,
                            key_rotation_override=key_rotation,
                        ),
                        env,
                        apply_context=apply_context,
                    )
                    apply_mode = "ec2_new_key_on_duplicate"
                    apply_log = (
                        f"{apply_log}\n\n[key-rotation-retry {key_rotation}]\n{retry_log}"
                    )
                except Exception as retry_exc:
                    return {
                        "success": False,
                        "error": (
                            "Terraform could not create a new EC2 key pair after a name collision. "
                            "DeplAI will not reuse the existing AWS key because AWS never stores the private half."
                        ),
                        "details": {
                            "terraform_root": tf_root,
                            "ec2_key_rotation": key_rotation,
                            "init_log_tail": _tail(init_log),
                            "apply_log_tail": _tail(str(retry_exc), 1800),
                        },
                    }

            elif _is_orphan_key_pair_collision(combined) or _is_orphan_alb_collision(combined):
                duplicate_key = _extract_duplicate_key_pair_name(combined) or existing_key_name_override
                if not duplicate_key and has_existing_key_name_var:
                    duplicate_key = _discover_existing_ec2_key_pair_name(files, project_name)
                duplicate_alb = _extract_duplicate_alb_name(combined)
                remediation = _orphan_collision_remediation(
                    key_name=duplicate_key,
                    alb_name=duplicate_alb,
                    aws_region=aws_region,
                )
                _emit_progress(
                    apply_context,
                    "error",
                    "State/AWS divergence on static-named key pair and/or ALB. See Option A (adopt) vs Option B (delete orphans).",
                )
                return {
                    "success": False,
                    "error": (
                        "Terraform tried to create static-named resources that already exist in AWS "
                        "but are missing from the current state (partial prior apply / lost state). "
                        "See details.orphan_collision. DeplAI mints a new SSH key on each deploy and does not reuse AWS key pairs."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "orphan_collision": remediation,
                        "existing_ec2_key_pair_name": existing_key_name_override,
                        "duplicate_key_pair": duplicate_key,
                        "duplicate_alb": duplicate_alb,
                        "bundle_remediation": bundle_remediation,
                        "init_log_tail": _tail(init_log),
                        "plan_log_tail": _tail(plan_log),
                        "apply_log_tail": _tail(combined, 2200),
                    },
                }

            elif _is_vcpu_quota_error(combined) and has_ec2_resource and has_instance_type_var:
                retry_errors: list[str] = [_tail(combined, 1200)]
                retry_log = ""
                for candidate in instance_candidates:
                    if candidate in attempted_instance_types:
                        continue
                    attempted_instance_types.append(candidate)
                    try:
                        _emit_progress(apply_context, "info", f"Retrying terraform apply with instance type {candidate}.")
                        retry_log = _run_terraform_with_tracking(
                            volume_name,
                            tf_root,
                            _build_apply_args(
                                candidate,
                                existing_key_name=existing_key_name_override,
                                force_default_vpc=False,
                            ),
                            env,
                            apply_context=apply_context,
                        )
                        selected_instance_type = candidate
                        apply_mode = "ec2_quota_retry_smaller_type"
                        apply_log = (
                            "[attempt-1] apply failed with VcpuLimitExceeded.\n"
                            f"{_tail(combined, 900)}\n\n"
                            f"[attempt-retry:{candidate}] apply retry log:\n{retry_log}"
                        )
                        break
                    except Exception as retry_exc:
                        retry_combined = str(retry_exc).strip()
                        retry_errors.append(f"{candidate}: {_tail(retry_combined, 700)}")
                else:
                    if allow_disable_fallback and has_enable_ec2_var:
                        _emit_progress(apply_context, "info", "Quota retry exhausted. Applying final fallback with EC2 disabled.")
                        retry_args = _build_apply_args(
                            None,
                            disable_ec2=True,
                            existing_key_name=existing_key_name_override,
                            force_default_vpc=False,
                        )
                        retry_log = _run_terraform_with_tracking(volume_name, tf_root, retry_args, env, apply_context=apply_context)
                        apply_log = (
                            "[attempt-1] EC2 apply failed across quota-safe instance candidates.\n"
                            f"{_tail(combined, 900)}\n\n"
                            "[attempt-final] fallback with enable_ec2=false succeeded.\n"
                            f"{_tail(retry_log, 1400)}"
                        )
                        ec2_fallback_applied = True
                        apply_mode = "ec2_disabled_quota_fallback"
                    else:
                        return {
                            "success": False,
                            "error": (
                                "EC2 creation failed due to vCPU quota limits even after retrying "
                                "smaller instance types. Free quota by stopping/terminating other "
                                "EC2 instances in this region or request an EC2 quota increase."
                            ),
                            "details": {
                                "terraform_root": tf_root,
                                "selected_instance_type": selected_instance_type,
                                "attempted_instance_types": attempted_instance_types,
                                "attempted_preferred_az_orders": attempted_az_orders,
                                "quota_info": quota_info,
                                "stderr_tail": _tail(stderr),
                                "stdout_tail": _tail(stdout),
                                "retry_errors": retry_errors[-5:],
                                "init_log_tail": _tail(init_log),
                                "enforce_free_tier_ec2": enforce_free_tier,
                                "allowed_instance_types": allowed_instance_types,
                            },
                        }
            elif _is_capacity_error(combined) and has_ec2_resource and has_preferred_azs_var and preferred_azs:
                retry_log = ""
                capacity_retry_errors: list[str] = [_tail(combined, 1200)]
                for az_order in _rotated_az_orders(preferred_azs):
                    if az_order in attempted_az_orders:
                        continue
                    attempted_az_orders.append([*az_order])
                    try:
                        retry_log = _run_terraform_with_tracking(
                            volume_name,
                            tf_root,
                            _build_apply_args(
                                selected_instance_type,
                                preferred_azs_override=az_order,
                                existing_key_name=existing_key_name_override,
                                force_default_vpc=False,
                            ),
                            env,
                            apply_context=apply_context,
                        )
                        selected_az_order = [*az_order]
                        quota_info["preferred_azs"] = selected_az_order
                        apply_mode = "ec2_capacity_retry_az_rotation"
                        apply_log = (
                            "[attempt-1] apply failed with AZ capacity constraints.\n"
                            f"{_tail(combined, 900)}\n\n"
                            f"[attempt-retry-az-order:{','.join(az_order)}] apply retry log:\n{retry_log}"
                        )
                        break
                    except Exception as retry_exc:
                        retry_combined = str(retry_exc).strip()
                        capacity_retry_errors.append(
                            f"{','.join(az_order)}: {_tail(retry_combined, 700)}"
                        )
                else:
                    return {
                        "success": False,
                        "error": (
                            "EC2 creation failed due to insufficient capacity across preferred "
                            "availability zones. Retry shortly, choose another region, or pick "
                            "a different instance type."
                        ),
                        "details": {
                            "terraform_root": tf_root,
                            "selected_instance_type": selected_instance_type,
                            "attempted_instance_types": attempted_instance_types,
                            "attempted_preferred_az_orders": attempted_az_orders,
                            "quota_info": quota_info,
                            "stderr_tail": _tail(stderr),
                            "stdout_tail": _tail(stdout),
                            "capacity_retry_errors": capacity_retry_errors[-5:],
                            "init_log_tail": _tail(init_log),
                            "enforce_free_tier_ec2": enforce_free_tier,
                            "allowed_instance_types": allowed_instance_types,
                        },
                    }
            else:
                raise

        outputs_raw = ""
        output_payload: Any = {}
        output_read_error: str | None = None
        try:
            outputs_raw = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                ["output", "-json"],
                env,
                apply_context=apply_context,
            )
            if apply_context and apply_context.get("cancel_requested"):
                _emit_progress(apply_context, "error", "Terraform apply cancelled while reading outputs.")
                return {
                    "success": False,
                    "error": "Deployment stopped by user.",
                    "details": {
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }
            output_payload = json.loads(outputs_raw or "{}")
        except Exception as exc:
            output_read_error = str(exc)
            output_payload = {}
            _emit_progress(
                apply_context,
                "info",
                "terraform output -json failed after apply. Attempting live AWS reconciliation.",
            )

        outputs: dict[str, Any] = {}
        if isinstance(output_payload, dict):
            for key, value in output_payload.items():
                if isinstance(value, dict) and "value" in value:
                    outputs[key] = value.get("value")

        ec2_output_evidence = _ec2_output_evidence(outputs)
        ec2_state_resources: list[str] = []
        ec2_state_list_error: str | None = None
        live_ec2_reconciliation: dict[str, str | None] | None = None
        state_list_raw = ""

        _emit_progress(apply_context, "info", "Fetching Terraform state to build provisioning report.")
        try:
            state_list_raw = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                ["state", "list"],
                env,
                apply_context=apply_context,
            )
            ec2_state_resources = _ec2_addresses_from_state_list(state_list_raw)
        except Exception as exc:
            ec2_state_list_error = str(exc)
            ec2_state_resources = []

        if requests_ec2:
            if not ec2_state_resources and not ec2_output_evidence:
                live_ec2_reconciliation = _lookup_live_ec2_instance_for_project(
                    aws_access_key_id=aws_access_key_id,
                    aws_secret_access_key=aws_secret_access_key,
                    aws_session_token=aws_session_token,
                    aws_region=aws_region,
                    project_name=project_name,
                )
                if live_ec2_reconciliation:
                    if live_ec2_reconciliation.get("instance_id"):
                        outputs["ec2_instance_id"] = live_ec2_reconciliation["instance_id"]
                    if live_ec2_reconciliation.get("instance_arn"):
                        outputs["ec2_instance_arn"] = live_ec2_reconciliation["instance_arn"]
                    if live_ec2_reconciliation.get("instance_state"):
                        outputs["ec2_instance_state"] = live_ec2_reconciliation["instance_state"]
                    if live_ec2_reconciliation.get("instance_type"):
                        outputs["ec2_instance_type"] = live_ec2_reconciliation["instance_type"]
                    if live_ec2_reconciliation.get("public_ip"):
                        outputs["ec2_public_ip"] = live_ec2_reconciliation["public_ip"]
                    if live_ec2_reconciliation.get("private_ip"):
                        outputs["ec2_private_ip"] = live_ec2_reconciliation["private_ip"]
                    if live_ec2_reconciliation.get("public_dns"):
                        outputs["ec2_public_dns"] = live_ec2_reconciliation["public_dns"]
                    if live_ec2_reconciliation.get("private_dns"):
                        outputs["ec2_private_dns"] = live_ec2_reconciliation["private_dns"]
                    if live_ec2_reconciliation.get("vpc_id"):
                        outputs["ec2_vpc_id"] = live_ec2_reconciliation["vpc_id"]
                    if live_ec2_reconciliation.get("subnet_id"):
                        outputs["ec2_subnet_id"] = live_ec2_reconciliation["subnet_id"]
                    ec2_output_evidence = _ec2_output_evidence(outputs)
                    _emit_progress(
                        apply_context,
                        "info",
                        "Live AWS reconciliation confirmed EC2 provisioning despite incomplete Terraform state/output evidence.",
                    )
            ec2_error = _missing_required_ec2_error(
                requests_ec2=True,
                ec2_fallback_applied=ec2_fallback_applied,
                ec2_state_resources=ec2_state_resources,
                ec2_output_evidence=ec2_output_evidence,
            )
            if ec2_error:
                _emit_progress(apply_context, "error", ec2_error)
                return {
                    "success": False,
                    "error": ec2_error,
                    "details": {
                        "terraform_root": tf_root,
                        "selected_instance_type": selected_instance_type,
                        "attempted_instance_types": attempted_instance_types,
                        "attempted_preferred_az_orders": attempted_az_orders,
                        "quota_info": quota_info,
                        "ec2_plan_changes": ec2_plan_changes,
                        "ec2_output_evidence": ec2_output_evidence,
                        "ec2_state_list_error": ec2_state_list_error,
                        "output_read_error": output_read_error,
                        "plan_json_error": plan_json_error,
                        "live_ec2_reconciliation": live_ec2_reconciliation,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }
            if ec2_output_evidence and not ec2_state_resources:
                _emit_progress(
                    apply_context,
                    "info",
                    "Terraform outputs confirm EC2 provisioning even though terraform state list did not return aws_instance entries.",
                )

        cloudfront_url = None
        if isinstance(outputs.get("cloudfront_url"), str):
            cloudfront_url = outputs.get("cloudfront_url")
        elif isinstance(outputs.get("cloudfront_domain_name"), str):
            cloudfront_url = f"https://{outputs.get('cloudfront_domain_name')}"

        website_inspection: dict[str, Any] | None = None
        website_bucket = outputs.get("website_bucket")
        if isinstance(website_bucket, str) and website_bucket.strip():
            _emit_progress(apply_context, "info", f"Inspecting deployed website bucket {website_bucket.strip()}.")
            website_inspection = _inspect_website_bucket(
                bucket_name=website_bucket.strip(),
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=aws_session_token,
                aws_region=aws_region,
            )
            outputs["website_object_count"] = website_inspection.get("object_count")
            outputs["website_has_policy"] = website_inspection.get("has_policy")
            outputs["website_block_public_access"] = website_inspection.get("block_public_access")

            if int(website_inspection.get("object_count") or 0) <= 0:
                return {
                    "success": False,
                    "error": (
                        f"Deployment incomplete: website bucket {website_bucket} has 0 objects."
                    ),
                    "details": {
                        "website_bucket_inspection": website_inspection,
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }
            if not bool(website_inspection.get("has_policy")):
                return {
                    "success": False,
                    "error": (
                        f"Deployment incomplete: website bucket {website_bucket} has no bucket policy."
                    ),
                    "details": {
                        "website_bucket_inspection": website_inspection,
                        "terraform_root": tf_root,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }

        provisioning_report = _build_provisioning_report(
            state_list_output=state_list_raw,
            outputs=outputs,
            apply_log=apply_log,
            tf_text=tf_text_preflight if "tf_text_preflight" in locals() else "",
            has_ec2_resource=has_ec2_resource,
            has_rds_or_elasticache=has_rds_or_elasticache,
        )

        one_time_credentials = _collect_one_time_credentials(
            outputs,
            project_name=project_name,
            aws_region=aws_region,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token,
            terraform_root=tf_root,
        )
        if one_time_credentials.get("private_key_pem"):
            outputs["generated_ec2_private_key_pem"] = one_time_credentials["private_key_pem"]
            outputs["ec2_key_name"] = one_time_credentials.get("key_name") or outputs.get("ec2_key_name")
            _emit_progress(
                apply_context,
                "info",
                "SSH key and database credentials are ready for a one-time download. They are deleted from DeplAI after you save them.",
            )

        return {
            "success": True,
            "provider": provider,
            "project_name": project_name,
            "outputs": outputs,
            "cloudfront_url": cloudfront_url,
            "plan_summary": plan_summary,
            "provisioning_report": provisioning_report,
            "one_time_credentials": one_time_credentials,
            "has_database_resources": bool(
                _nonempty_output_string(outputs, ["rds_endpoint", "rds_address", "db_endpoint", "postgres_endpoint"])
                or _nonempty_output_string(outputs, ["redis_endpoint", "elasticache_endpoint", "cache_endpoint"])
            ),
            "details": {
                "apply_mode": apply_mode,
                "ec2_fallback_applied": ec2_fallback_applied,
                "selected_instance_type": selected_instance_type,
                "attempted_instance_types": attempted_instance_types,
                "attempted_preferred_az_orders": attempted_az_orders,
                "quota_info": quota_info,
                "enforce_free_tier_ec2": enforce_free_tier,
                "allowed_instance_types": allowed_instance_types,
                "ec2_plan_changes": ec2_plan_changes,
                "ec2_output_evidence": ec2_output_evidence,
                "ec2_state_resources": ec2_state_resources,
                "ec2_state_list_error": ec2_state_list_error,
                "output_read_error": output_read_error,
                "plan_json_error": plan_json_error,
                "live_ec2_reconciliation": live_ec2_reconciliation,
                "terraform_root": tf_root,
                "fmt_log_tail": _tail(fmt_log),
                "init_log_tail": _tail(init_log),
                "validate_log_tail": _tail(validate_log),
                "plan_log_tail": _tail(plan_log),
                "apply_log_tail": _tail(apply_log),
                "website_bucket_inspection": website_inspection,
                "backend_bootstrap": backend_bootstrap,
                "bundle_remediation": bundle_remediation,
                "existing_ec2_key_pair_name": None,
                "key_pair_reused": False,
                "ec2_key_rotation": key_rotation,
                "key_file_name": one_time_credentials.get("key_file_name"),
            },
        }

    except ContainerError as exc:
        _emit_progress(apply_context, "error", "Terraform container failed during runtime apply.")
        stderr = decode_output(getattr(exc, "stderr", b"") or b"")
        stdout = decode_output(getattr(exc, "stdout", b"") or b"")
        combined = f"{stderr}\n{stdout}".strip()
        friendly = _friendly_terraform_error(combined)
        return {
            "success": False,
            "error": f"Terraform container failed: {str(exc)}{friendly}",
            "details": {
                "stderr_tail": _tail(stderr),
                "stdout_tail": _tail(stdout),
                "fmt_log_tail": _tail(fmt_log),
                "init_log_tail": _tail(init_log),
                "validate_log_tail": _tail(validate_log),
                "plan_log_tail": _tail(plan_log),
                "plan_json_error": plan_json_error if "plan_json_error" in locals() else None,
                "apply_log_tail": _tail(apply_log),
            },
        }
    except Exception as exc:
        _emit_progress(apply_context, "error", f"Terraform runtime apply failed: {exc}")
        return {
            "success": False,
            "error": f"Terraform runtime apply failed: {str(exc)}",
            "details": {
                "fmt_log_tail": _tail(fmt_log),
                "init_log_tail": _tail(init_log),
                "validate_log_tail": _tail(validate_log),
                "plan_log_tail": _tail(plan_log),
                "plan_json_error": plan_json_error if "plan_json_error" in locals() else None,
                "apply_log_tail": _tail(apply_log),
                "backend_bootstrap": backend_bootstrap,
                "bundle_remediation": bundle_remediation,
            },
        }
    finally:
        try:
            volume.remove(force=True)
        except Exception:
            pass


def apply_saved_terraform_run(
    *,
    run_id: str,
    workspace: str,
    project_name: str,
    provider: str,
    state_bucket: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_region: str,
    lock_table: str = "",
    aws_session_token: str = "",
    enforce_free_tier_ec2: bool = True,
    confirm_apply: bool = False,
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from deployment_run_store import load_terraform_run

    saved_run = load_terraform_run(workspace=workspace, run_id=run_id)
    if saved_run is not None:
        files = saved_run.get("files")
        if not isinstance(files, list) or not files:
            return {"success": False, "error": f"Saved Terraform run {run_id} has no files."}
        metadata = saved_run.get("metadata") if isinstance(saved_run.get("metadata"), dict) else {}
        deployment_metadata = (
            apply_context.get("deployment_metadata")
            if isinstance(apply_context, dict) and isinstance(apply_context.get("deployment_metadata"), dict)
            else {}
        )
        expected_source = (
            deployment_metadata.get("customization_source")
            if isinstance(deployment_metadata.get("customization_source"), dict)
            else None
        )
        if expected_source:
            run_source = metadata.get("source_metadata") if isinstance(metadata.get("source_metadata"), dict) else {}
            identity_fields = ("kind", "project_id", "tenant_id", "snapshot_id", "source_tree_hash")
            if any(str(run_source.get(key) or "") != str(expected_source.get(key) or "") for key in identity_fields):
                return {
                    "success": False,
                    "error": "Saved Terraform run source does not match the validated customization snapshot.",
                }
        return apply_terraform_bundle(
            files=[item for item in files if isinstance(item, dict)],
            project_name=project_name,
            provider=provider,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token,
            aws_region=aws_region,
            state_bucket=state_bucket or str(metadata.get("state_bucket") or ""),
            lock_table=lock_table or str(metadata.get("lock_table") or ""),
            enforce_free_tier_ec2=enforce_free_tier_ec2,
            confirm_apply=confirm_apply,
            apply_context=apply_context,
        )

    deployment_metadata = (
        apply_context.get("deployment_metadata")
        if isinstance(apply_context, dict) and isinstance(apply_context.get("deployment_metadata"), dict)
        else {}
    )
    if isinstance(deployment_metadata.get("customization_source"), dict):
        return {
            "success": False,
            "error": "Snapshot deployment requires a saved Terraform run with source metadata.",
        }

    _ensure_agent_import_path()
    from terraform_agent.agent.engine import apply_terraform_run

    return apply_terraform_run(
        {
            "run_id": run_id,
            "workspace": workspace,
            "project_name": project_name,
            "provider": provider,
            "state_bucket": state_bucket,
            "aws_access_key_id": aws_access_key_id,
            "aws_secret_access_key": aws_secret_access_key,
            "aws_session_token": aws_session_token,
            "aws_region": aws_region,
        },
        apply_context=apply_context,
    )

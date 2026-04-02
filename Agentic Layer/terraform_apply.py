"""Runtime Terraform apply helper.

Applies generated Terraform files in an ephemeral Docker volume using the
hashicorp/terraform image and returns Terraform outputs.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import tarfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import boto3
from botocore.config import Config
from docker.errors import ContainerError

from utils import decode_output, get_docker_client

TERRAFORM_IMAGE = "hashicorp/terraform:1.9.0"
_EC2_STANDARD_FAMILY_PREFIXES = {"a", "c", "d", "h", "i", "m", "r", "t", "z"}
_EC2_STANDARD_ONDEMAND_VCPU_QUOTA_CODE = "L-1216C47A"
_SAFE_EC2_INSTANCE_ORDER = ["t3.micro", "t2.micro", "t3a.micro", "t3.small", "t2.small"]
_DEFAULT_FREE_TIER_INSTANCE_ORDER = ["t3.micro", "t2.micro"]


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


def _run_terraform(volume_name: str, tf_root: str, args: list[str], env: dict[str, str]) -> str:
    output = get_docker_client().containers.run(
        TERRAFORM_IMAGE,
        command=[f"-chdir={tf_root}", *args],
        environment=env,
        volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
        remove=True,
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

    docker = get_docker_client()
    container = docker.containers.create(
        TERRAFORM_IMAGE,
        command=[f"-chdir={tf_root}", *args],
        environment=env,
        volumes={volume_name: {"bind": "/workspace", "mode": "rw"}},
    )
    if apply_context is not None:
        apply_context["container_id"] = container.id

    try:
        container.start()
        result = container.wait()
        logs = decode_output(container.logs(stdout=True, stderr=True))
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


def _tail(text: str, limit: int = 3000) -> str:
    value = text or ""
    if len(value) <= limit:
        return value
    return value[-limit:]


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


def _collect_terraform_text(files: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
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


def _project_slug_for_key(project_name: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", str(project_name or "").strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug[:40] or "deplai-project"


def _terraform_has_aws_instance(tf_text: str) -> bool:
    return re.search(r'resource\s+"aws_instance"\s+"[^"]+"', tf_text or "", flags=re.IGNORECASE) is not None


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
    aws_region: str,
) -> dict[str, Any]:
    # Keep post-apply bucket checks fast so UI isn't stuck after infra is already up.
    s3_cfg = Config(connect_timeout=5, read_timeout=8, retries={"max_attempts": 2, "mode": "standard"})
    session = boto3.session.Session(
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
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


def apply_terraform_bundle(
    files: list[dict[str, Any]],
    project_name: str,
    provider: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_region: str,
    enforce_free_tier_ec2: bool = True,
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if provider.lower() != "aws":
        return {"success": False, "error": "Runtime apply currently supports AWS only."}

    if not files:
        _emit_progress(apply_context, "error", "Terraform apply aborted: no files were provided.")
        return {"success": False, "error": "No files were provided for Terraform apply."}

    if not aws_access_key_id or not aws_secret_access_key:
        _emit_progress(apply_context, "error", "Terraform apply aborted: AWS credentials are missing.")
        return {"success": False, "error": "AWS credentials are required for runtime Terraform apply."}

    docker = get_docker_client()
    volume_name = f"deplai_tf_apply_{uuid.uuid4().hex[:12]}"
    volume = docker.volumes.create(name=volume_name)

    init_log = ""
    apply_log = ""

    try:
        normalized_paths = [_normalize_rel_path(str(item.get("path", ""))) for item in files]
        _write_files_to_volume(volume_name, files)
        _emit_progress(apply_context, "info", "Terraform files staged into runtime workspace.")

        has_terraform_dir = any(path == "terraform" or path.startswith("terraform/") for path in normalized_paths)
        tf_root = "/workspace/terraform" if has_terraform_dir else "/workspace"

        env = {
            "AWS_ACCESS_KEY_ID": aws_access_key_id,
            "AWS_SECRET_ACCESS_KEY": aws_secret_access_key,
            "AWS_DEFAULT_REGION": aws_region,
            "TF_IN_AUTOMATION": "1",
        }

        init_log = _run_terraform_with_tracking(
            volume_name,
            tf_root,
            ["init", "-input=false", "-no-color"],
            env,
            apply_context=apply_context,
        )
        if apply_context and apply_context.get("cancel_requested"):
            _emit_progress(apply_context, "error", "Terraform apply cancelled during init.")
            return {
                "success": False,
                "error": "Deployment stopped by user.",
                "details": {
                    "terraform_root": tf_root,
                    "init_log_tail": _tail(init_log),
                },
            }

        tf_text = _collect_terraform_text(files)
        has_ec2_resource = _terraform_has_aws_instance(tf_text)
        has_instance_type_var = _terraform_has_variable(tf_text, "instance_type")
        has_enable_ec2_var = _terraform_has_variable(tf_text, "enable_ec2")
        has_aws_region_var = _terraform_has_variable(tf_text, "aws_region")
        has_preferred_azs_var = _terraform_has_variable(tf_text, "preferred_availability_zones")
        has_existing_key_name_var = _terraform_has_variable(tf_text, "existing_ec2_key_pair_name")
        has_use_default_vpc_var = _terraform_has_variable(tf_text, "use_default_vpc")
        preferred_azs = _preferred_azs_for_region(aws_region)
        selected_az_order = [*preferred_azs]
        attempted_az_orders: list[list[str]] = [[*preferred_azs]] if preferred_azs else []
        enforce_free_tier = bool(enforce_free_tier_ec2)
        allowed_instance_types = _FREE_TIER_EC2_INSTANCE_ORDER if enforce_free_tier else _SAFE_EC2_INSTANCE_ORDER
        allowed_instance_type_set = set(allowed_instance_types)

        ec2_fallback_applied = False
        precheck_disable_ec2 = False
        apply_mode = "default"
        selected_instance_type: str | None = None
        quota_info: dict[str, Any] = {}
        attempted_instance_types: list[str] = []
        apply_args_base = ["apply", "-auto-approve", "-input=false", "-no-color", "-parallelism=20"]
        allow_disable_fallback = str(
            os.getenv("DEPLAI_ALLOW_EC2_DISABLE_FALLBACK", "1")
        ).strip().lower() in {"1", "true", "yes"}
        requested_instance_type = (
            os.getenv("DEPLAI_EC2_INSTANCE_TYPE", "").strip().lower()
            or _terraform_default_instance_type(tf_text)
            or "t3.micro"
        )
        existing_key_name_override: str | None = None
        instance_candidates = _ordered_instance_candidates(
            requested_instance_type,
            enforce_free_tier=enforce_free_tier,
        )
        if not (has_ec2_resource and has_instance_type_var):
            instance_candidates = []

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
                region_name=aws_region,
            )
            ec2 = session.client("ec2", region_name=aws_region)
            if has_existing_key_name_var:
                key_candidate = f"{_project_slug_for_key(project_name)}-key"
                if _ec2_key_pair_exists(ec2, key_candidate):
                    existing_key_name_override = key_candidate
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
        ) -> list[str]:
            args = [*apply_args_base]
            if has_enable_ec2_var and has_ec2_resource:
                args.append(f"-var=enable_ec2={'false' if disable_ec2 else 'true'}")
            if has_aws_region_var:
                args.append(f"-var=aws_region={aws_region}")
            az_order = preferred_azs_override if preferred_azs_override is not None else preferred_azs
            if has_preferred_azs_var and az_order:
                args.append(f"-var=preferred_availability_zones={json.dumps(az_order)}")
            if force_default_vpc and has_use_default_vpc_var:
                args.append("-var=use_default_vpc=true")
            if existing_key_name and has_existing_key_name_var:
                args.append(f"-var=existing_ec2_key_pair_name={existing_key_name}")
            if instance_type_override:
                args.append(f"-var=instance_type={instance_type_override}")
            return args

        try:
            args = _build_apply_args(
                selected_instance_type,
                disable_ec2=precheck_disable_ec2,
                preferred_azs_override=selected_az_order,
                existing_key_name=existing_key_name_override,
                force_default_vpc=True,
            )
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
                        "apply_log_tail": _tail(apply_log),
                    },
                }
            combined = str(exc).strip()
            stderr = combined
            stdout = ""

            if "VpcLimitExceeded" in combined:
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

            if "OriginAccessControlAlreadyExists" in combined:
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

            if _is_vcpu_quota_error(combined) and has_ec2_resource and has_instance_type_var:
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
                                force_default_vpc=True,
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
                            force_default_vpc=True,
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
                                force_default_vpc=True,
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

        outputs: dict[str, Any] = {}
        if isinstance(output_payload, dict):
            for key, value in output_payload.items():
                if isinstance(value, dict) and "value" in value:
                    outputs[key] = value.get("value")

        ec2_state_resources: list[str] = []
        if has_ec2_resource and not ec2_fallback_applied:
            _emit_progress(apply_context, "info", "Validating EC2 resources in Terraform state.")
            try:
                state_list_raw = _run_terraform_with_tracking(
                    volume_name,
                    tf_root,
                    ["state", "list"],
                    env,
                    apply_context=apply_context,
                )
                for line in state_list_raw.splitlines():
                    row = line.strip()
                    if "aws_instance." in row:
                        ec2_state_resources.append(row)
            except Exception:
                ec2_state_resources = []
            if not ec2_state_resources:
                return {
                    "success": False,
                    "error": (
                        "Terraform apply finished but no EC2 instance resource was found in state. "
                        "Deployment did not provision EC2."
                    ),
                    "details": {
                        "terraform_root": tf_root,
                        "selected_instance_type": selected_instance_type,
                        "attempted_instance_types": attempted_instance_types,
                        "attempted_preferred_az_orders": attempted_az_orders,
                        "quota_info": quota_info,
                        "init_log_tail": _tail(init_log),
                        "apply_log_tail": _tail(apply_log),
                    },
                }

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

        return {
            "success": True,
            "provider": provider,
            "project_name": project_name,
            "outputs": outputs,
            "cloudfront_url": cloudfront_url,
            "details": {
                "apply_mode": apply_mode,
                "ec2_fallback_applied": ec2_fallback_applied,
                "selected_instance_type": selected_instance_type,
                "attempted_instance_types": attempted_instance_types,
                "attempted_preferred_az_orders": attempted_az_orders,
                "quota_info": quota_info,
                "enforce_free_tier_ec2": enforce_free_tier,
                "allowed_instance_types": allowed_instance_types,
                "ec2_state_resources": ec2_state_resources,
                "terraform_root": tf_root,
                "init_log_tail": _tail(init_log),
                "apply_log_tail": _tail(apply_log),
                "website_bucket_inspection": website_inspection,
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
                "init_log_tail": _tail(init_log),
                "apply_log_tail": _tail(apply_log),
            },
        }
    except Exception as exc:
        _emit_progress(apply_context, "error", f"Terraform runtime apply failed: {exc}")
        return {
            "success": False,
            "error": f"Terraform runtime apply failed: {str(exc)}",
            "details": {
                "init_log_tail": _tail(init_log),
                "apply_log_tail": _tail(apply_log),
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
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
            "aws_region": aws_region,
        },
        apply_context=apply_context,
    )

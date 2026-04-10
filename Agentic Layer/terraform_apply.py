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
import sys
import tarfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
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


def _legacy_runtime_bundle_needs_remediation(files: list[dict[str, Any]]) -> bool:
    versions_provider = False
    providers_provider = False
    has_aws_region_var = False
    has_region_var = False
    has_var_region_reference = False
    single_line_variable_block = re.compile(
        r'variable\s+"[^"]+"\s*\{\s*type\s*=\s*[^{}\n]+,\s*default\s*=\s*[^{}\n]+\s*\}'
    )
    conditional_depends_on = re.compile(r"depends_on\s*=\s*[^\n]*\?")

    for item in files:
        path = _normalize_rel_path(str(item.get("path", ""))).lower()
        if not path.endswith(".tf"):
            continue
        text = _extract_text_payload(item)
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
        if 'variable "desired_log_group_name" {{' in text or 'variable "log_group_override" {{' in text:
            return True
        if single_line_variable_block.search(text):
            return True
        if conditional_depends_on.search(text):
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
        "legacy_iam_name_collision_rewritten": False,
        "legacy_versions_provider_deduped": False,
        "legacy_conditional_depends_on_rewritten": False,
        "legacy_single_line_variable_blocks_rewritten": False,
        "legacy_provider_region_var_rewritten": False,
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
                r'\1name_prefix        = "${var.project_name}-${var.environment}-ec2-role-"',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_instance_profile"\s+"ec2"\s*\{[\s\S]*?^\s*)name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-instance-profile"\s*$',
                r'\1name_prefix = "${var.project_name}-${var.environment}-instance-profile-"',
            ),
            (
                r'(?ms)(resource\s+"aws_iam_role_policy"\s+"app"\s*\{[\s\S]*?^\s*)name\s*=\s*"\$\{var\.project_name\}-\$\{var\.environment\}-app"\s*$',
                r'\1name_prefix = "${var.project_name}-${var.environment}-app-"',
            ),
        )
        for pattern, replacement in iam_replacements:
            rewritten = re.sub(pattern, replacement, updated, flags=re.IGNORECASE)
            if rewritten != updated:
                updated = rewritten
                remediation["legacy_iam_name_collision_rewritten"] = True
        return updated

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
        text = _rewrite_single_line_variable_blocks(text)
        text = _rewrite_conditional_depends_on(text)
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
    if needs_subnet_clone and 'resource "aws_subnet" "main_b"' not in post_patch_combined:
        target_idx: int | None = None
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

            if 'resource "aws_route_table_association" "main"' in post_patch_combined and 'resource "aws_route_table_association" "main_b"' not in post_patch_combined:
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
            remediation["legacy_key_pair_reuse_support_added"] = True
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
            if "existing_ec2_key_pair_name" in body:
                return match.group(0)
            body = body.rstrip() + "\n  existing_ec2_key_pair_name  = var.existing_ec2_key_pair_name\n"
            return f"{match.group(1)}{body}{match.group(3)}"

        updated_main = module_compute_pattern.sub(_inject_compute_arg, root_main_text, count=1)
        if updated_main != root_main_text:
            tf_texts[root_main_idx] = updated_main
            remediation["legacy_key_pair_reuse_support_added"] = True
            changed = True

    compute_variables_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/modules/compute/variables.tf"),
        None,
    )
    if compute_variables_idx is not None:
        compute_variables_text = tf_texts[compute_variables_idx]
        if 'variable "existing_ec2_key_pair_name"' not in compute_variables_text:
            compute_variables_text = (
                compute_variables_text.rstrip()
                + "\n"
                + "variable \"existing_ec2_key_pair_name\" { type = string }\n"
            )
            tf_texts[compute_variables_idx] = compute_variables_text
            remediation["legacy_key_pair_reuse_support_added"] = True
            changed = True

    compute_main_idx = next(
        (idx for idx, path in normalized_paths.items() if path == "terraform/modules/compute/main.tf"),
        None,
    )
    if compute_main_idx is not None:
        compute_main_text = tf_texts[compute_main_idx]
        if 'resource "aws_key_pair" "generated"' in compute_main_text:
            if 'locals {' not in compute_main_text or 'use_existing_key' not in compute_main_text:
                compute_main_text = (
                    "locals {\n"
                    "  use_existing_key = trimspace(var.existing_ec2_key_pair_name) != \"\"\n"
                    "  ec2_key_name     = local.use_existing_key ? trimspace(var.existing_ec2_key_pair_name) : aws_key_pair.generated[0].key_name\n"
                    "}\n\n"
                    + compute_main_text
                )

            compute_main_text = re.sub(
                r'(resource\s+"tls_private_key"\s+"generated"\s*\{[\s\S]*?\n\s*)count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0',
                r'\1count     = var.enabled && !local.use_existing_key ? 1 : 0',
                compute_main_text,
                flags=re.IGNORECASE,
            )
            compute_main_text = re.sub(
                r'(resource\s+"aws_key_pair"\s+"generated"\s*\{[\s\S]*?\n\s*)count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0',
                r'\1count      = var.enabled && !local.use_existing_key ? 1 : 0',
                compute_main_text,
                flags=re.IGNORECASE,
            )
            compute_main_text = compute_main_text.replace(
                'key_name                    = aws_key_pair.generated[0].key_name',
                'key_name                    = local.ec2_key_name',
            )

            if compute_main_text != tf_texts[compute_main_idx]:
                tf_texts[compute_main_idx] = compute_main_text
                remediation["legacy_key_pair_reuse_support_added"] = True
                changed = True

    if not changed:
        return files, {}

    for idx in tf_indexes:
        patched_files[idx] = _set_text_payload(patched_files[idx], tf_texts[idx])

    _emit_progress(
        apply_context,
        "info",
        "Applied runtime compatibility fixes for legacy Terraform bundle (AMI, ALB subnet safety, user_data syntax, bootstrap interpolation quoting, EC2 key-pair reuse support, IAM name collision avoidance, duplicate provider cleanup, conditional depends_on rewrites, and variable block normalization).",
    )
    return patched_files, remediation


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
    aws_region: str,
    project_name: str,
) -> dict[str, str | None] | None:
    if not str(project_name or "").strip():
        return None
    try:
        session = boto3.session.Session(
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
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
        project_name = None
    if _is_unresolved_template_value(environment):
        environment = None

    if re.search(
        r'key_name\s*=\s*"\\?\$\{var\.project_name\}-\\?\$\{var\.environment\}-key"',
        tf_text,
        flags=re.IGNORECASE,
    ):
        if project_name and environment:
            return f"{project_name}-{environment}-key"
        return None

    if re.search(
        r'key_name\s*=\s*"\\?\$\{var\.project_name\}-key"',
        tf_text,
        flags=re.IGNORECASE,
    ):
        if project_name:
            return f"{project_name}-key"
        return None

    return None


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


def _terraform_init_args(backend_region_override: str | None) -> list[str]:
    args = ["init", "-input=false", "-no-color"]
    if str(backend_region_override or "").strip():
        args.append(f"-backend-config=region={str(backend_region_override).strip()}")
    return args


def apply_terraform_bundle(
    files: list[dict[str, Any]],
    project_name: str,
    provider: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_region: str,
    state_bucket: str = "",
    lock_table: str = "",
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
    backend_bootstrap: dict[str, Any] = {}
    backend_region_override: str | None = None
    bundle_remediation: dict[str, Any] = {}

    try:
        if _legacy_runtime_bundle_needs_remediation(files):
            files, bundle_remediation = _remediate_legacy_runtime_bundle(files, apply_context)
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
            init_log = _run_terraform_with_tracking(
                volume_name,
                tf_root,
                _terraform_init_args(backend_region_override),
                env,
                apply_context=apply_context,
            )
        except Exception as init_exc:
            init_error = str(init_exc)
            actual_region_from_error = _extract_actual_bucket_region(init_error)
            needs_retry = _is_missing_remote_state_error(init_error) or _is_backend_region_mismatch_error(init_error)
            if auto_bootstrap_backend and needs_retry:
                backend_bootstrap = _ensure_remote_state_backend(
                    state_bucket=state_bucket_name,
                    lock_table=lock_table_name,
                    aws_access_key_id=aws_access_key_id,
                    aws_secret_access_key=aws_secret_access_key,
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
                    _terraform_init_args(backend_region_override),
                    env,
                    apply_context=apply_context,
                )
            else:
                raise
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
                key_candidate = _discover_existing_ec2_key_pair_name(files, project_name)
                if key_candidate and _ec2_key_pair_exists(ec2, key_candidate):
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

            if "InvalidAMIID.NotFound" in combined:
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

            if "At least two subnets in two different Availability Zones must be specified" in combined:
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
            except Exception as exc:
                ec2_state_list_error = str(exc)
                ec2_state_resources = []
            if not ec2_state_resources and not ec2_output_evidence:
                live_ec2_reconciliation = _lookup_live_ec2_instance_for_project(
                    aws_access_key_id=aws_access_key_id,
                    aws_secret_access_key=aws_secret_access_key,
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
            if not ec2_state_resources and not ec2_output_evidence:
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
                        "ec2_output_evidence": ec2_output_evidence,
                        "ec2_state_list_error": ec2_state_list_error,
                        "output_read_error": output_read_error,
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
                "ec2_output_evidence": ec2_output_evidence,
                "ec2_state_resources": ec2_state_resources,
                "ec2_state_list_error": ec2_state_list_error,
                "output_read_error": output_read_error,
                "live_ec2_reconciliation": live_ec2_reconciliation,
                "terraform_root": tf_root,
                "init_log_tail": _tail(init_log),
                "apply_log_tail": _tail(apply_log),
                "website_bucket_inspection": website_inspection,
                "backend_bootstrap": backend_bootstrap,
                "bundle_remediation": bundle_remediation,
                "existing_ec2_key_pair_name": existing_key_name_override,
                "key_pair_reused": bool(existing_key_name_override),
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

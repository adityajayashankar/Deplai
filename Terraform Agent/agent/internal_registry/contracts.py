"""Contract enforcement / HCL sanitization against the internal registry."""

from __future__ import annotations

import re
from typing import Any

from .catalog import get_contract, get_module


def rewrite_artifacts_iam_policy_count_known_at_plan(text: str) -> tuple[str, bool]:
    """Stop gating aws_iam_role_policy.artifacts count on the instance role name.

    The IAM module uses name_prefix, so aws_iam_role.ec2.name is unknown until
    apply. Terraform rejects unknown values in count/for_each.
    """
    if not text or "instance_role_name" not in text:
        return text, False
    rewritten, n = re.subn(
        r'(?m)^(\s*count\s*=\s*)var\.enabled\s*&&\s*trimspace\(\s*var\.instance_role_name\s*\)\s*!=\s*""\s*\?\s*1\s*:\s*0\s*$',
        r"\1var.enabled ? 1 : 0",
        text,
    )
    return (rewritten, True) if n else (text, False)


def rewrite_ec2_module_count_not_gated_on_key_reuse(text: str) -> tuple[str, bool]:
    """Undo a bad remediator that set module.ec2 count = enabled && !use_existing_key.

    Reusing an existing key pair must not disable the EC2 instance module.
    """
    if not text or 'module "ec2"' not in text:
        return text, False
    rewritten, n = re.subn(
        r'(module\s+"ec2"\s*\{[\s\S]*?count\s*=\s*)var\.enabled\s*&&\s*!local\.use_existing_key\s*\?\s*1\s*:\s*0',
        r'\1var.enabled ? 1 : 0',
        text,
        count=1,
        flags=re.IGNORECASE,
    )
    return (rewritten, True) if n else (text, False)


def rewrite_ec2_module_v5_compat(text: str) -> tuple[str, bool]:
    """Normalize enterprise EC2 module HCL for terraform-aws-modules/ec2-instance v5.x."""
    if not text or 'module "ec2"' not in text:
        return text, False

    parts = re.split(r'(?=module\s+"alb"\s*\{)', text, maxsplit=1)
    head = parts[0]
    tail = parts[1] if len(parts) > 1 else ""
    updated = head
    changed = False

    contract = get_contract("ec2_instance")
    forbidden = [str(item) for item in (contract.get("forbidden_args") or []) if str(item).strip()]
    for arg in forbidden:
        stripped = re.sub(
            rf'(?m)^\s*{re.escape(arg)}\s*=\s*[^\n]*\r?\n',
            "",
            updated,
        )
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


def _strip_forbidden_args_in_module(text: str, module_name: str, forbidden: list[str]) -> tuple[str, bool]:
    if not forbidden or f'module "{module_name}"' not in text:
        return text, False

    pattern = re.compile(
        rf'(module\s+"{re.escape(module_name)}"\s*\{{)([\s\S]*?)(\n\}})',
        flags=re.MULTILINE,
    )
    changed = False

    def _patch(match: re.Match[str]) -> str:
        nonlocal changed
        header, body, closer = match.group(1), match.group(2), match.group(3)
        updated_body = body
        for arg in forbidden:
            new_body = re.sub(
                rf'(?m)^\s*{re.escape(arg)}\s*=\s*[^\n]*\r?\n',
                "",
                updated_body,
            )
            if new_body != updated_body:
                updated_body = new_body
                changed = True
        return f"{header}{updated_body}{closer}"

    # Non-greedy match can fail on nested braces; fall back to EC2/ALB split for ec2.
    if module_name == "ec2":
        rewritten, did = rewrite_ec2_module_v5_compat(text)
        return rewritten, did

    rewritten = pattern.sub(_patch, text, count=1)
    return rewritten, changed


def rewrite_alb_name_for_vpc_uniqueness(text: str) -> tuple[str, bool]:
    """Avoid regional ALB name collisions after partial deploys left an orphan LB."""
    if not text or 'module "alb"' not in text:
        return text, False
    if "md5(var.vpc_id)" in text:
        return text, False
    rewritten = re.sub(
        r'(name\s*=\s*)substr\(\s*"\$\{var\.project_name\}-\$\{var\.environment\}-alb"\s*,\s*0\s*,\s*32\s*\)',
        r'\1substr(replace("${var.project_name}-${var.environment}-${substr(md5(var.vpc_id), 0, 6)}", "_", "-"), 0, 32)',
        text,
        count=1,
    )
    return (rewritten, True) if rewritten != text else (text, False)


def enforce_registry_contracts_on_text(text: str) -> tuple[str, dict[str, Any]]:
    """Apply known contract remediations to a single .tf file body."""
    if not text:
        return text, {}

    remediation: dict[str, Any] = {
        "ec2_module_v5_compat_rewritten": False,
        "alb_name_vpc_unique": False,
        "ec2_count_ungated_from_key_reuse": False,
        "artifacts_policy_count_known_at_plan": False,
        "forbidden_args_stripped": [],
    }
    updated = text

    updated, artifacts_count = rewrite_artifacts_iam_policy_count_known_at_plan(updated)
    if artifacts_count:
        remediation["artifacts_policy_count_known_at_plan"] = True

    updated, ungated = rewrite_ec2_module_count_not_gated_on_key_reuse(updated)
    if ungated:
        remediation["ec2_count_ungated_from_key_reuse"] = True

    if 'module "ec2"' in updated:
        updated, changed = rewrite_ec2_module_v5_compat(updated)
        if changed:
            remediation["ec2_module_v5_compat_rewritten"] = True
            remediation["forbidden_args_stripped"].extend(
                get_contract("ec2_instance").get("forbidden_args") or []
            )

    updated, alb_changed = rewrite_alb_name_for_vpc_uniqueness(updated)
    if alb_changed:
        remediation["alb_name_vpc_unique"] = True

    # Pin source/version drift check is informational; do not auto-rewrite versions here.
    try:
        ec2 = get_module("ec2_instance")
        expected_version = str(ec2.get("version") or "")
        if expected_version and 'module "ec2"' in updated:
            version_match = re.search(
                r'module\s+"ec2"\s*\{[\s\S]*?version\s*=\s*"([^"]+)"',
                updated,
            )
            if version_match and version_match.group(1) != expected_version:
                remediation["ec2_version_drift"] = {
                    "found": version_match.group(1),
                    "expected": expected_version,
                }
    except Exception:
        pass

    return updated, remediation

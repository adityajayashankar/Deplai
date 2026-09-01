"""Database configuration preflight before infrastructure mutation."""

from __future__ import annotations

import re
from typing import Any

from database_env import (
    validate_customer_database_configuration,
    validate_provisioned_rds_preflight,
)


def _terraform_bool_default(terraform_text: str, variable_name: str) -> bool | None:
    match = re.search(
        rf'variable\s+"{re.escape(variable_name)}"\s*\{{(?:(?!\n\}}).)*?\bdefault\s*=\s*(true|false)',
        str(terraform_text or ""),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    return match.group(1).lower() == "true"


def _terraform_provisions_rds(terraform_text: str) -> bool:
    text = str(terraform_text or "")
    for variable_name in ("enable_rds", "enable_postgres"):
        enabled_default = _terraform_bool_default(text, variable_name)
        if enabled_default is not None:
            return enabled_default
    if re.search(r"\benable_rds\s*=\s*true\b", text, flags=re.IGNORECASE):
        return True
    if re.search(r"\benable_postgres\s*=\s*true\b", text, flags=re.IGNORECASE):
        return True
    return bool(re.search(r'resource\s+"aws_db_instance"', text))


def _terraform_bool_or_tfvars(text: str, variable_name: str) -> bool | None:
    default = _terraform_bool_default(text, variable_name)
    if default is not None:
        return default
    if re.search(rf"\b{re.escape(variable_name)}\s*=\s*true\b", text, flags=re.IGNORECASE):
        return True
    if re.search(rf"\b{re.escape(variable_name)}\s*=\s*false\b", text, flags=re.IGNORECASE):
        return False
    return None


def _bootstrap_expects_database(terraform_text: str) -> bool:
    text = str(terraform_text or "")
    enable_rds = _terraform_bool_or_tfvars(text, "enable_rds")
    enable_postgres = _terraform_bool_or_tfvars(text, "enable_postgres")
    has_prisma = _terraform_bool_or_tfvars(text, "has_prisma")
    if enable_rds is True or enable_postgres is True:
        return True
    if enable_rds is False and enable_postgres is False and has_prisma is not True:
        return False
    if has_prisma is True:
        return True
    return bool(
        re.search(r"\bhas_prisma\s*=\s*true\b", text, flags=re.IGNORECASE)
        or re.search(r"prisma\s+(?:migrate|db\s+push)", text, flags=re.IGNORECASE)
    )


def run_database_preflight(
    *,
    terraform_text: str = "",
    database_required: bool = False,
    customer_database_url: str | None = None,
    customer_host: str | None = None,
    customer_port: str | None = None,
    customer_database_name: str | None = None,
    customer_username: str | None = None,
    customer_password: str | None = None,
) -> dict[str, Any]:
    """Static preflight — reject guaranteed-invalid configs before Terraform apply."""
    provisions_rds = _terraform_provisions_rds(terraform_text)
    expects_db = database_required or _bootstrap_expects_database(terraform_text)

    if not expects_db:
        return {"ok": True, "stage": "static_preflight", "skipped": True}

    if provisions_rds:
        return validate_provisioned_rds_preflight(database_required=True)

    return validate_customer_database_configuration(
        database_url=customer_database_url,
        host=customer_host,
        port=customer_port,
        database_name=customer_database_name,
        username=customer_username,
        password=customer_password,
    )

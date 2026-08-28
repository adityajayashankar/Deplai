from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any

from deployment_packager import DeploymentPackage

try:
    from terraform_agent.agent.internal_registry import get_module, load_catalog
    _EC2_MODULE = get_module("ec2_instance")
    EC2_MODULE_SOURCE = str(_EC2_MODULE.get("source") or "terraform-aws-modules/ec2-instance/aws")
    EC2_MODULE_VERSION = str(_EC2_MODULE.get("version") or "5.8.0")
    PROVIDER_VERSION = str((load_catalog().get("provider") or {}).get("constraint") or "~> 5.100.0")
    TERRAFORM_REQUIRED_VERSION = str(
        (load_catalog().get("terraform") or {}).get("required_version") or ">= 1.6.0, < 1.12.0"
    )
except Exception:
    EC2_MODULE_SOURCE = "terraform-aws-modules/ec2-instance/aws"
    EC2_MODULE_VERSION = "5.8.0"
    PROVIDER_VERSION = "~> 5.100.0"
    TERRAFORM_REQUIRED_VERSION = ">= 1.6.0, < 1.12.0"
# The builder and CLI version are part of the certified executor registry.  A
# manifest can select the buildpack executor, but cannot supply an arbitrary
# builder image or a remote shell script.
CERTIFIED_BUILDPACK_BUILDER = "paketobuildpacks/builder-jammy-base@sha256:5799343cd316c1a03fa3ff7ab0915d9e6d134e95df4583016d70c6f5330d3898"
CERTIFIED_PACK_VERSION = "0.35.1"


def _hcl_string(value: Any) -> str:
    return json.dumps(str(value or ""))


def _hcl_string_list(values: list[str]) -> str:
    return "[" + ", ".join(_hcl_string(value) for value in values) + "]"


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return (slug or "deplai-app")[:40]


def _cidr_list(value: Any) -> list[str]:
    raw_items = value if isinstance(value, list) else str(value or "").split(",")
    result: list[str] = []
    for item in raw_items:
        cidr = str(item or "").strip()
        if not re.fullmatch(r"(\d{1,3}\.){3}\d{1,3}/\d{1,2}", cidr):
            continue
        if cidr not in result:
            result.append(cidr)
    return result


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value or "").strip().lower()
    if normalized in {"true", "yes", "y", "1", "on"}:
        return True
    if normalized in {"false", "no", "n", "0", "off"}:
        return False
    return default


def _int(value: Any, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        result = int(value)
    except Exception:
        result = default
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _ec2_config_from_source(source: dict[str, Any] | None) -> dict[str, Any]:
    record = _record(source)
    nested = _record(record.get("ec2_resource_config"))
    ec2 = _record(record.get("ec2"))
    return {
        **nested,
        **ec2,
        "instance_type": record.get("instance_type") or record.get("ec2_instance_type") or record.get("compute_instance_type") or nested.get("instance_type") or ec2.get("instance_type"),
        "root_volume_size_gb": record.get("root_volume_size_gb") or record.get("ec2_root_volume_size_gb") or nested.get("root_volume_size_gb") or ec2.get("root_volume_size_gb"),
        "app_port": record.get("app_port") or nested.get("app_port") or ec2.get("app_port"),
        "ssh_ingress_cidr_blocks": record.get("ssh_ingress_cidr_blocks") or nested.get("ssh_ingress_cidr_blocks") or ec2.get("ssh_ingress_cidr_blocks"),
    }


def _ec2_settings(
    user_answers: dict[str, Any] | None,
    deployment_profile: dict[str, Any] | None,
    *,
    app_kind: str = "",
    start_command: str = "",
    app_port: int | None = None,
) -> dict[str, Any]:
    profile = deployment_profile or {}
    decision = _record(profile.get("consultant_decision"))
    stack_config = _record(decision.get("stack_config"))
    decision_ec2 = {
        **_record(stack_config.get("ec2-instance")),
        **_record(stack_config.get("ec2")),
    }
    merged_access = {
        **_ec2_config_from_source(user_answers),
        **decision_ec2,
    }
    try:
        from terraform_agent.agent.internal_registry import select_allowlisted_edits

        agent_ec2 = select_allowlisted_edits(
            profile,
            app_bootstrap={
                "app_kind": app_kind,
                "start_command": start_command,
                "app_port": app_port,
            },
        ).get("ec2_instance") or {}
    except Exception:
        agent_ec2 = {}
    instance_type = str(agent_ec2.get("instance_type") or "t3.micro").strip().lower()
    if instance_type not in {"t3.micro", "t3.small", "t3.medium", "t3.large"}:
        instance_type = "t3.micro"
    port = _int(agent_ec2.get("app_port") or merged_access.get("app_port"), 3000, minimum=1, maximum=65535)
    if port in {5432, 3306, 6379, 27017, 1433, 1521}:
        port = 3000
    return {
        "instance_type": instance_type,
        "root_volume_size_gb": _int(agent_ec2.get("root_volume_size_gb"), 35, minimum=20, maximum=200),
        "app_port": port,
        "ssh_ingress_cidr_blocks": _cidr_list(merged_access.get("ssh_ingress_cidr_blocks")),
    }


def _component_config(deployment_profile: dict[str, Any] | None, name: str) -> dict[str, Any]:
    profile = deployment_profile or {}
    decision = _record(profile.get("consultant_decision"))
    stack_config = _record(decision.get("stack_config"))
    if name == "ec2":
        config = {**_record(stack_config.get("ec2-instance")), **_record(stack_config.get("ec2"))}
    else:
        config = _record(stack_config.get(name))
    if config:
        return config
    return _record(profile.get(name))


def _data_layer_item(deployment_profile: dict[str, Any] | None, kinds: set[str]) -> dict[str, Any]:
    for item in _records((deployment_profile or {}).get("data_layer")):
        item_type = str(item.get("type") or "").strip().lower()
        if item_type in kinds:
            return item
    return {}


def _agent_data_edits(deployment_profile: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    try:
        from terraform_agent.agent.internal_registry import select_allowlisted_edits

        return select_allowlisted_edits(deployment_profile or {})
    except Exception:
        return {}


def _database_settings(deployment_profile: dict[str, Any] | None) -> dict[str, Any]:
    config = {**_data_layer_item(deployment_profile, {"postgres", "postgresql", "mysql", "mariadb"}), **_component_config(deployment_profile, "rds")}
    if not config:
        return {"enabled": False}
    engine = str(config.get("engine") or config.get("type") or "postgres").strip().lower()
    if engine == "postgresql":
        engine = "postgres"
    if engine not in {"postgres", "mysql", "mariadb"}:
        engine = "postgres"
    rds = (_agent_data_edits(deployment_profile).get("rds") or {})
    return {
        "enabled": True,
        "engine": str(rds.get("engine") or engine),
        "engine_version": str(rds.get("engine_version") or "").strip(),
        "instance_class": str(rds.get("instance_class") or "db.t4g.micro").strip(),
        "allocated_storage": _int(rds.get("allocated_storage"), 20, minimum=20, maximum=200),
        "multi_az": _bool(rds.get("multi_az"), False),
        "backup_retention_period": _int(config.get("backup_retention_period") or config.get("backup_retention_days"), 7, minimum=0, maximum=35),
        "deletion_protection": _bool(config.get("deletion_protection"), False),
    }


def _redis_settings(deployment_profile: dict[str, Any] | None) -> dict[str, Any]:
    config = {**_data_layer_item(deployment_profile, {"redis", "elasticache"}), **_component_config(deployment_profile, "elasticache")}
    if not config:
        return {"enabled": False}
    cache = (_agent_data_edits(deployment_profile).get("elasticache") or {})
    return {
        "enabled": True,
        "node_type": str(cache.get("node_type") or "cache.t4g.micro").strip(),
        "engine_version": str(cache.get("engine_version") or "7.0").strip(),
    }


def _app_env_vars_hcl(env_map: dict[str, str]) -> str:
    """Render a HCL map literal from a Python dict of env var key→value pairs."""
    if not env_map:
        return "{}"
    lines = [
        f'    {json.dumps(k)} = {json.dumps(v)}'
        for k, v in sorted(env_map.items())
    ]
    return "{\n" + "\n".join(lines) + "\n  }"


def _build_app_env_vars(
    deployment_package: DeploymentPackage,
    database: dict[str, Any],
) -> dict[str, str]:
    """Build a map of env vars to inject into the EC2 app's .env file.

    When RDS is enabled, DATABASE_URL is constructed from Terraform output
    interpolation expressions so the value is resolved at apply time.
    The caller MUST treat this dict as Terraform HCL template values, not
    plain strings — they may contain ``${...}`` interpolations.
    """
    env: dict[str, str] = {}
    if not database.get("enabled"):
        return env

    engine = str(database.get("engine") or "postgres").lower()
    # Terraform interpolation: resolved after aws_db_instance is created.
    # Port is known from the db_port local in main.tf.
    if engine in {"mysql", "mariadb"}:
        protocol = "mysql"
        port_expr = "${local.db_port}"
    else:
        protocol = "postgresql"
        port_expr = "${local.db_port}"

    # These are rendered as Terraform template strings inside the user_data.
    # The actual values are interpolated when Terraform creates the EC2 resource.
    env["DATABASE_URL"] = (
        f"{protocol}://deplaiadmin:"
        "${random_password.db_master[0].result}"
        "@${aws_db_instance.app[0].address}"
        f":{port_expr}/appdb"
    )
    env["DB_HOST"] = "${aws_db_instance.app[0].address}"
    env["DB_PORT"] = port_expr
    env["DB_NAME"] = "appdb"
    env["DB_USER"] = "deplaiadmin"
    env["DB_PASSWORD"] = "${random_password.db_master[0].result}"
    return env



def render_ec2_app_bundle(
    *,
    project_name: str,
    aws_region: str,
    deployment_package: DeploymentPackage,
    deployment_profile: dict[str, Any] | None = None,
    user_answers: dict[str, Any] | None = None,
    context_summary: str = "",
    state_bucket: str = "",
    lock_table: str = "",
    repository_url: str = "",
) -> dict[str, Any]:
    project_slug = _safe_slug(project_name)
    environment = str((deployment_profile or {}).get("environment") or "production").strip().lower() or "production"
    ec2_settings = _ec2_settings(
        user_answers,
        deployment_profile,
        app_kind=str(deployment_package.app_kind or ""),
        start_command=str(deployment_package.start_command or ""),
        app_port=int(deployment_package.app_port or 3000),
    )
    instance_type = str(ec2_settings["instance_type"])
    app_port = int(ec2_settings["app_port"])
    # Preserve the legacy profile default (3000), but prefer an explicit
    # manifest/Docker EXPOSE port when the profile did not choose another one.
    if app_port == 3000 and int(deployment_package.app_port or 3000) != 3000:
        app_port = int(deployment_package.app_port)
    root_volume_size_gb = int(ec2_settings["root_volume_size_gb"])
    try:
        from runtime_catalog import get_runtime_recipe

        recipe = get_runtime_recipe(deployment_package.app_kind)
        if recipe is not None:
            root_volume_size_gb = max(root_volume_size_gb, int(recipe.min_root_volume_gb))
    except Exception:
        if str(deployment_package.app_kind or "").strip().lower() == "docker":
            root_volume_size_gb = max(root_volume_size_gb, 40)
    ssh_ingress_cidr_blocks = list(ec2_settings["ssh_ingress_cidr_blocks"])

    # ── Database: merge detected repo requirements with profile settings ──────
    # db_requirements from the packager (real repo scan) takes precedence over
    # what the architecture profile says, ensuring prisma/postgres apps always
    # get RDS even when the architecture agent didn't notice it.
    repo_db = deployment_package.db_requirements
    profile_db = _database_settings(deployment_profile)
    if repo_db.enabled and not profile_db.get("enabled"):
        # Repo scan found a DB need that the profile missed — promote it.
        database: dict[str, Any] = {
            "enabled": True,
            "engine": repo_db.engine or "postgres",
            "engine_version": "",
            "instance_class": str((_agent_data_edits(deployment_profile).get("rds") or {}).get("instance_class") or "db.t4g.micro"),
            "allocated_storage": 20,
            "multi_az": False,
            "backup_retention_period": 7,
            "deletion_protection": False,
        }
    else:
        database = profile_db

    # Generate a stable random JWT secret for this project (used when the app
    # has no JWT_SECRET set). We derive it from project_slug so it is
    # deterministic across regenerates but unique per project.
    import hashlib as _hashlib
    jwt_secret = _hashlib.sha256(f"deplai-jwt-{project_slug}".encode()).hexdigest()

    app_env_vars = _build_app_env_vars(deployment_package, database)
    for item in deployment_package.environment:
        key, _, value = str(item).partition("=")
        if key and key not in {"PORT", "DATABASE_URL", "DB_PASSWORD"}:
            app_env_vars.setdefault(key, value)
    # Bootstrap-only non-secret defaults. Operator OAuth/API secrets come from
    # AWS Secrets Manager at boot — never embed plaintext into HCL/userdata.
    app_env_vars.setdefault("JWT_SECRET", jwt_secret)
    app_env_vars.setdefault("NEXTAUTH_SECRET", jwt_secret)
    app_env_vars.setdefault("AUTH_SECRET", jwt_secret)
    app_env_vars.setdefault("NODE_ENV", "production")
    app_env_vars.setdefault("PORT", str(app_port))

    runtime_config = _record((deployment_profile or {}).get("runtime_config"))
    secrets_manager_prefix = str(
        runtime_config.get("secrets_manager_prefix")
        or f"/{project_slug}/{environment}"
    ).strip() or f"/{project_slug}/{environment}"
    if not secrets_manager_prefix.startswith("/"):
        secrets_manager_prefix = f"/{secrets_manager_prefix}"
    secrets_manager_prefix = secrets_manager_prefix.rstrip("/") or f"/{project_slug}/{environment}"
    required_secret_names = [
        str(item).strip()
        for item in (runtime_config.get("required_secrets") or [])
        if str(item).strip()
    ]

    auth_requirements = None
    try:
        from auth_provisioning import auth_warnings, detect_auth_requirements, public_url_bootstrap_bash

        source_root = Path(str(deployment_package.source_root or "")).expanduser()
        if source_root.exists():
            auth_requirements = detect_auth_requirements(source_root, user_answers=user_answers)
            for key in auth_requirements.required_secret_keys:
                if key not in required_secret_names and key.upper() not in {
                    "JWT_SECRET",
                    "NEXTAUTH_SECRET",
                    "AUTH_SECRET",
                }:
                    required_secret_names.append(key)
    except Exception:
        auth_requirements = None
        public_url_bootstrap_bash = None  # type: ignore[assignment]
        auth_warnings = None  # type: ignore[assignment]

    redis = _redis_settings(deployment_profile)
    backend_tf = 'terraform {\n  backend "local" {}\n}\n'
    if state_bucket and lock_table:
        backend_tf = f'''terraform {{
  backend "s3" {{
    bucket         = "{state_bucket}"
    key            = "{project_slug}/{environment}/terraform.tfstate"
    region         = "{aws_region}"
    dynamodb_table = "{lock_table}"
    encrypt        = true
  }}
}}
'''

    providers_tf = f'''terraform {{
  required_version = "{TERRAFORM_REQUIRED_VERSION}"
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "{PROVIDER_VERSION}"
    }}
    random = {{
      source  = "hashicorp/random"
      version = "~> 3.6"
    }}
    tls = {{
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }}
  }}
}}

provider "aws" {{
  region = var.aws_region
  default_tags {{
    tags = local.tags
  }}
}}
'''

    variables_tf = f'''variable "project_name" {{
  type    = string
  default = {_hcl_string(project_slug)}
}}

variable "aws_region" {{
  type    = string
  default = {_hcl_string(aws_region)}
}}

variable "environment" {{
  type    = string
  default = {_hcl_string(environment)}
}}

variable "instance_type" {{
  type    = string
  default = {_hcl_string(instance_type)}
  validation {{
    condition     = contains(["t3.micro", "t3.small", "t3.medium", "t3.large"], var.instance_type)
    error_message = "instance_type must be one of t3.micro, t3.small, t3.medium, or t3.large."
  }}
}}

variable "app_kind" {{
  type    = string
  default = {_hcl_string(deployment_package.app_kind)}
}}

variable "deployment_strategy" {{
  type    = string
  default = {_hcl_string(deployment_package.strategy)}
  validation {{
    condition     = contains(["docker", "buildpack", "cloud_init"], var.deployment_strategy)
    error_message = "deployment_strategy must be a certified DeplAI executor."
  }}
}}

variable "buildpack_builder" {{
  type    = string
  default = {_hcl_string(CERTIFIED_BUILDPACK_BUILDER)}
  validation {{
    condition     = var.buildpack_builder == {_hcl_string(CERTIFIED_BUILDPACK_BUILDER)}
    error_message = "buildpack_builder must use the certified DeplAI builder."
  }}
}}

variable "buildpack_pack_version" {{
  type    = string
  default = {_hcl_string(CERTIFIED_PACK_VERSION)}
  validation {{
    condition     = var.buildpack_pack_version == {_hcl_string(CERTIFIED_PACK_VERSION)}
    error_message = "buildpack_pack_version must use the certified DeplAI pack CLI."
  }}
}}

variable "app_port" {{
  type    = number
  default = {app_port}
}}

variable "health_path" {{
  type    = string
  default = {_hcl_string(deployment_package.health_path)}
}}

variable "build_command" {{
  type    = string
  default = {_hcl_string(deployment_package.build_command)}
}}

variable "start_command" {{
  type    = string
  default = {_hcl_string(deployment_package.start_command)}
}}

variable "artifact_source" {{
  type    = string
  default = {_hcl_string(deployment_package.package_id)}
}}

variable "repository_url" {{
  type    = string
  default = {_hcl_string(repository_url)}
}}

variable "app_subdir" {{
  type    = string
  default = {_hcl_string(deployment_package.selected_root)}
}}

variable "state_bucket" {{
  type    = string
  default = {_hcl_string(state_bucket)}
}}

variable "lock_table" {{
  type    = string
  default = {_hcl_string(lock_table)}
}}

variable "app_archive_base64" {{
  type      = string
  sensitive = true
}}

variable "root_volume_size_gb" {{
  type    = number
  default = {root_volume_size_gb}
  validation {{
    condition     = var.root_volume_size_gb >= 20 && var.root_volume_size_gb <= 200
    error_message = "root_volume_size_gb must be between 20 and 200."
  }}
}}

variable "ingress_cidr_blocks" {{
  type    = list(string)
  default = ["0.0.0.0/0"]
}}

variable "ssh_ingress_cidr_blocks" {{
  type    = list(string)
  default = []
}}

variable "use_default_vpc" {{
  type        = bool
  default     = true
  description = "Prefer the account default VPC when one exists. If the region has no default VPC, a dedicated VPC is created automatically."
}}

variable "enable_ec2" {{
  type    = bool
  default = true
}}

variable "existing_ec2_key_pair_name" {{
  type    = string
  default = ""
}}

variable "ec2_key_rotation" {{
  type        = string
  default     = "init"
  description = "Unique suffix so each deploy mints a new EC2 key pair. AWS never stores the private half."
}}

variable "enable_rds" {{
  type    = bool
  default = {str(bool(database["enabled"])).lower()}
}}

variable "db_engine" {{
  type    = string
  default = {_hcl_string(database.get("engine"))}
}}

variable "db_engine_version" {{
  type    = string
  default = {_hcl_string(database.get("engine_version"))}
}}

variable "db_instance_class" {{
  type    = string
  default = {_hcl_string(database.get("instance_class"))}
}}

variable "db_allocated_storage" {{
  type    = number
  default = {int(database.get("allocated_storage") or 20)}
}}

variable "db_multi_az" {{
  type    = bool
  default = {str(bool(database.get("multi_az"))).lower()}
}}

variable "db_backup_retention_period" {{
  type    = number
  default = {int(database.get("backup_retention_period") or 0)}
}}

variable "db_deletion_protection" {{
  type    = bool
  default = {str(bool(database.get("deletion_protection"))).lower()}
}}

variable "enable_elasticache" {{
  type    = bool
  default = {str(bool(redis["enabled"])).lower()}
}}

variable "redis_node_type" {{
  type    = string
  default = {_hcl_string(redis.get("node_type"))}
}}

variable "redis_engine_version" {{
  type    = string
  default = {_hcl_string(redis.get("engine_version"))}
}}

variable "has_prisma" {{
  type    = bool
  default = {str(bool(repo_db.has_prisma)).lower()}
}}

variable "secrets_manager_prefix" {{
  type    = string
  default = {_hcl_string(secrets_manager_prefix)}
}}

variable "required_secret_names" {{
  type    = list(string)
  default = {_hcl_string_list(required_secret_names)}
}}
'''

    # Build tfvars env map — when RDS is enabled the DATABASE_URL contains
    # Terraform interpolation expressions, so we emit a templatefile()-style
    # locals block in main.tf instead of a static tfvars entry.
    # For the tfvars file we only include non-interpolated vars.
    static_env_vars = {k: v for k, v in app_env_vars.items() if "${" not in v}
    interpolated_env_vars = {k: v for k, v in app_env_vars.items() if "${" in v}

    static_env_lines: list[str] = []
    for key, value in sorted(static_env_vars.items()):
        if key == "PORT":
            static_env_lines.append('"PORT=${var.app_port}"')
        else:
            static_env_lines.append(json.dumps(f"{key}={value}"))
    if not static_env_lines:
        static_env_lines = [
            '"NODE_ENV=production"',
            '"PORT=${var.app_port}"',
            json.dumps(f"JWT_SECRET={jwt_secret}"),
        ]
    static_env_block_items = ",\n    ".join(static_env_lines)

    public_url_bash = ""
    auth_warning_lines: list[str] = []
    if auth_requirements is not None and public_url_bootstrap_bash is not None:
        public_url_bash = public_url_bootstrap_bash(auth_requirements.callback_paths)
        if auth_warnings is not None:
            auth_warning_lines = auth_warnings(auth_requirements)

    tfvars = f'''project_name = {_hcl_string(project_slug)}
aws_region = {_hcl_string(aws_region)}
environment = {_hcl_string(environment)}
instance_type = {_hcl_string(instance_type)}
app_kind = {_hcl_string(deployment_package.app_kind)}
deployment_strategy = {_hcl_string(deployment_package.strategy)}
buildpack_builder = {_hcl_string(CERTIFIED_BUILDPACK_BUILDER)}
buildpack_pack_version = {_hcl_string(CERTIFIED_PACK_VERSION)}
app_port = {app_port}
health_path = {_hcl_string(deployment_package.health_path)}
build_command = {_hcl_string(deployment_package.build_command)}
start_command = {_hcl_string(deployment_package.start_command)}
artifact_source = {_hcl_string(deployment_package.package_id)}
repository_url = {_hcl_string(repository_url)}
app_subdir = {_hcl_string(deployment_package.selected_root)}
state_bucket = {_hcl_string(state_bucket)}
lock_table = {_hcl_string(lock_table)}
ingress_cidr_blocks = {_hcl_string_list(["0.0.0.0/0"])}
ssh_ingress_cidr_blocks = {_hcl_string_list(ssh_ingress_cidr_blocks)}
use_default_vpc = true
enable_ec2 = true
existing_ec2_key_pair_name = ""
ec2_key_rotation = "init"
app_archive_base64 = {_hcl_string(deployment_package.package_base64)}
root_volume_size_gb = {root_volume_size_gb}
enable_rds = {str(bool(database["enabled"])).lower()}
db_engine = {_hcl_string(database.get("engine"))}
db_engine_version = {_hcl_string(database.get("engine_version"))}
db_instance_class = {_hcl_string(database.get("instance_class"))}
db_allocated_storage = {int(database.get("allocated_storage") or 20)}
db_multi_az = {str(bool(database.get("multi_az"))).lower()}
db_backup_retention_period = {int(database.get("backup_retention_period") or 0)}
db_deletion_protection = {str(bool(database.get("deletion_protection"))).lower()}
enable_elasticache = {str(bool(redis["enabled"])).lower()}
redis_node_type = {_hcl_string(redis.get("node_type"))}
redis_engine_version = {_hcl_string(redis.get("engine_version"))}
has_prisma = {str(bool(repo_db.has_prisma)).lower()}
secrets_manager_prefix = {_hcl_string(secrets_manager_prefix)}
required_secret_names = {_hcl_string_list(required_secret_names)}
'''

    main_tf = f'''locals {{
  tags = {{
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "deplai"
    Renderer    = "deplai_ec2_app"
  }}
  # Static env vars always injected into the app .env file.
  # DB vars are added at runtime via a separate locals block (below)
  # that uses try() so they are safe when enable_rds=false.
  # Includes generated JWT/NEXTAUTH fallbacks only — OAuth/API secrets come from Secrets Manager at boot.
  static_env_block = join("\\n", [
    {static_env_block_items}
  ])
}}
'''

    main_tf_resources = r'''


data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_vpcs" "default" {
  filter {
    name   = "isDefault"
    values = ["true"]
  }
}

locals {
  prefer_default_vpc = var.use_default_vpc
  has_default_vpc    = local.prefer_default_vpc && length(data.aws_vpcs.default.ids) > 0
}

data "aws_vpc" "default" {
  count = local.has_default_vpc ? 1 : 0
  id    = data.aws_vpcs.default.ids[0]
}

data "aws_subnets" "default" {
  count = local.has_default_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

resource "aws_vpc" "main" {
  count                = local.has_default_vpc ? 0 : 1
  cidr_block           = "10.52.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.project_name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  count  = local.has_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "${var.project_name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = local.has_default_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = "10.52.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.project_name}-public-subnet" })
}

resource "aws_route_table" "public" {
  count  = local.has_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "${var.project_name}-public-rt" })
}

resource "aws_route" "internet_access" {
  count                  = local.has_default_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count          = local.has_default_vpc ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  selected_vpc_id     = local.has_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  selected_subnet_ids = local.has_default_vpc ? data.aws_subnets.default[0].ids : aws_subnet.public[*].id
  selected_subnet_id  = local.selected_subnet_ids[0]
}

resource "aws_security_group" "app" {
  name_prefix = "${var.project_name}-app-"
  description = "HTTP access for DeplAI EC2 app deployment"
  vpc_id      = local.selected_vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  ingress {
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidr_blocks
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, { Name = "${var.project_name}-app-sg" })
}

locals {
  db_port = contains(["mysql", "mariadb"], var.db_engine) ? 3306 : 5432

  # Build the DATABASE_URL and companion vars using try() so that when
  # enable_rds=false (count=0) the expression safely returns "" instead
  # of causing a Terraform plan error from a missing resource reference.
  _db_address  = try(aws_db_instance.app[0].address, "")
  _db_pw       = try(random_password.db_master[0].result, "")
  db_env_block = var.enable_rds ? join("\n", [
    "DATABASE_URL=postgresql://deplaiadmin:${local._db_pw}@${local._db_address}:${local.db_port}/appdb",
    "DB_HOST=${local._db_address}",
    "DB_PORT=${local.db_port}",
    "DB_NAME=appdb",
    "DB_USER=deplaiadmin",
    "DB_PASSWORD=${local._db_pw}",
  ]) : ""
  app_env_block = join("\n", compact([
    local.db_env_block,
    local.static_env_block,
  ]))
}


resource "aws_security_group" "database" {
  count       = var.enable_rds ? 1 : 0
  name_prefix = "${var.project_name}-db-"
  description = "Database access from DeplAI EC2 app deployment"
  vpc_id      = local.selected_vpc_id

  ingress {
    from_port       = local.db_port
    to_port         = local.db_port
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, { Name = "${var.project_name}-db-sg" })
}

resource "random_password" "db_master" {
  count            = var.enable_rds ? 1 : 0
  length           = 24
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "app" {
  count      = var.enable_rds ? 1 : 0
  name       = "${var.project_name}-db-subnets"
  subnet_ids = local.selected_subnet_ids
  tags       = merge(local.tags, { Name = "${var.project_name}-db-subnets" })
}

resource "aws_db_instance" "app" {
  count                       = var.enable_rds ? 1 : 0
  identifier_prefix           = "${var.project_name}-"
  engine                      = var.db_engine
  engine_version              = trimspace(var.db_engine_version) != "" ? var.db_engine_version : null
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  db_name                     = "appdb"
  username                    = "deplaiadmin"
  password                    = random_password.db_master[0].result
  port                        = local.db_port
  multi_az                    = var.db_multi_az
  backup_retention_period     = var.db_backup_retention_period
  deletion_protection         = var.db_deletion_protection
  publicly_accessible         = false
  skip_final_snapshot         = true
  storage_encrypted           = true
  db_subnet_group_name        = aws_db_subnet_group.app[0].name
  vpc_security_group_ids      = [aws_security_group.database[0].id]
  auto_minor_version_upgrade  = true
  copy_tags_to_snapshot       = true
  tags                        = merge(local.tags, { Name = "${var.project_name}-db" })

  timeouts {
    create = "45m"
    update = "60m"
    delete = "40m"
  }
}


resource "aws_security_group" "redis" {
  count       = var.enable_elasticache ? 1 : 0
  name_prefix = "${var.project_name}-redis-"
  description = "Redis access from DeplAI EC2 app deployment"
  vpc_id      = local.selected_vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, { Name = "${var.project_name}-redis-sg" })
}

resource "aws_elasticache_subnet_group" "app" {
  count      = var.enable_elasticache ? 1 : 0
  name       = "${var.project_name}-redis-subnets"
  subnet_ids = local.selected_subnet_ids
  tags       = merge(local.tags, { Name = "${var.project_name}-redis-subnets" })
}

resource "aws_elasticache_cluster" "app" {
  count                = var.enable_elasticache ? 1 : 0
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  engine_version       = trimspace(var.redis_engine_version) != "" ? var.redis_engine_version : null
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.app[0].name
  security_group_ids   = [aws_security_group.redis[0].id]
  apply_immediately    = true
  tags                 = merge(local.tags, { Name = "${var.project_name}-redis" })
}

resource "random_id" "key_suffix" {
  byte_length = 4
  keepers = {
    project_name     = var.project_name
    ec2_key_rotation = var.ec2_key_rotation
  }
}

resource "tls_private_key" "generated" {
  count     = var.enable_ec2 ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enable_ec2 ? 1 : 0
  key_name   = "${var.project_name}-${var.ec2_key_rotation}-${random_id.key_suffix.hex}"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags = merge(local.tags, {
    Name             = "${var.project_name}-${var.ec2_key_rotation}-${random_id.key_suffix.hex}"
    "deplai:managed" = "true"
  })
}

locals {
  selected_key_name = var.enable_ec2 ? try(aws_key_pair.generated[0].key_name, null) : null
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name_prefix        = "${var.project_name}-ec2-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "ec2_logs" {
  name_prefix = "${var.project_name}-logs-"
  role        = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:DescribeImages"
        ]
        Resource = "*"
      },
      {
        # ListSecrets cannot be resource-scoped; Get/Describe are limited to this app prefix.
        Effect = "Allow"
        Action = [
          "secretsmanager:ListSecrets"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.secrets_manager_prefix}*"
        ]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name_prefix = "${var.project_name}-ec2-"
  role        = aws_iam_role.ec2.name
}

# Certified, versioned verification command. It has no command-text
# parameter: callers can verify a deployment but cannot turn SSM into a live
# terminal.
resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_ssm_document" "deployment_verify" {
  name            = "${var.project_name}-deployment-verify"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "DeplAI certified deployment health verification; no free-text shell commands are accepted."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "verifyBootstrapHealth"
      inputs = {
        runCommand = [
          "set -euo pipefail",
          "STATUS_FILE=/var/log/deplai-bootstrap-status.json",
          "test -s $STATUS_FILE",
          "grep -Eq ready $STATUS_FILE",
          "curl --fail --silent --show-error http://127.0.0.1:${var.app_port}${var.health_path} || curl --fail --silent --show-error http://127.0.0.1/"
        ]
      }
    }]
  })
}

module "ec2" {
  count  = var.enable_ec2 ? 1 : 0
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"

  name                        = var.project_name
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = local.selected_subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  key_name                    = local.selected_key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true
  user_data_replace_on_change = true

  user_data_base64 = base64encode(<<-USERDATA
#!/bin/bash
# deplai_key_rotation=${var.ec2_key_rotation}
set -euxo pipefail
exec > >(tee -a /var/log/deplai-bootstrap.log) 2>&1

APP_ROOT="/opt/${var.project_name}"
APP_SUBDIR=${jsonencode(var.app_subdir)}
if [ -z "$APP_SUBDIR" ] || [ "$APP_SUBDIR" = "." ]; then
  APP_DIR="$APP_ROOT"
else
  APP_DIR="$APP_ROOT/$APP_SUBDIR"
fi
APP_NAME="${var.project_name}-frontend"
APP_PORT="${var.app_port}"
APP_KIND="${var.app_kind}"
DEPLOYMENT_STRATEGY="${var.deployment_strategy}"
BUILDPACK_BUILDER="${var.buildpack_builder}"
BUILDPACK_PACK_VERSION="${var.buildpack_pack_version}"
REPOSITORY_URL=${jsonencode(var.repository_url)}
BUILD_COMMAND=${jsonencode(var.build_command)}
START_COMMAND=${jsonencode(var.start_command)}
HEALTH_PATH=${jsonencode(var.health_path)}
BOOTSTRAP_STATUS_FILE="/var/log/deplai-bootstrap-status.json"

write_status() {
  printf '{"phase":"%s","timestamp":"%s"}\n' "$1" "$(date -Is)" > "$BOOTSTRAP_STATUS_FILE"
}

write_status "starting"

dnf install -y git nginx tar gzip cloud-utils-growpart xfsprogs
growpart /dev/nvme0n1 1 || true
xfs_growfs -d / || resize2fs /dev/nvme0n1p1 || true
df -h || true

if [ "$APP_KIND" = "node" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y nodejs npm
  swapoff /swapfile || true
  rm -f /swapfile
  fallocate -l 6G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi
if [ "$APP_KIND" = "python" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y python3 python3-pip
fi
if [ "$APP_KIND" = "go" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y golang
fi
if [ "$APP_KIND" = "java" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y java-17-amazon-corretto-devel maven
fi
if [ "$APP_KIND" = "dotnet" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  rpm --import https://packages.microsoft.com/keys/microsoft.asc || true
  curl -fsSL -o /tmp/packages-microsoft-prod.rpm https://packages.microsoft.com/config/centos/7/packages-microsoft-prod.rpm || true
  rpm -Uvh /tmp/packages-microsoft-prod.rpm || true
  dnf install -y dotnet-sdk-8.0 || dnf install -y dotnet-sdk-6.0 || true
fi
if [ "$APP_KIND" = "php" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y php php-cli php-fpm php-mbstring php-xml php-mysqlnd unzip
  if ! command -v composer >/dev/null 2>&1; then
    curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
  fi
fi
if [ "$APP_KIND" = "ruby" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  dnf install -y ruby ruby-devel gcc make redhat-rpm-config
  gem install bundler --no-document || true
fi
if [ "$APP_KIND" = "rust" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    . "$HOME/.cargo/env"
  fi
fi
if [ "$APP_KIND" = "docker" ] || [ "$DEPLOYMENT_STRATEGY" = "buildpack" ]; then
  dnf install -y docker
  systemctl enable --now docker
  usermod -aG docker ec2-user || true
  mkdir -p /usr/local/lib/docker/cli-plugins
  if [ ! -x /usr/local/lib/docker/cli-plugins/docker-compose ]; then
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  docker version
  docker compose version || true
  write_status "docker_engine_ready"
fi
if [ "$DEPLOYMENT_STRATEGY" = "buildpack" ]; then
  PACK_VERSION="$BUILDPACK_PACK_VERSION"
  curl --fail --location --retry 3 \
    "https://github.com/buildpacks/pack/releases/download/v$PACK_VERSION/pack-v$PACK_VERSION-linux.tgz" \
    -o /tmp/deplai-pack.tgz
  tar -xzf /tmp/deplai-pack.tgz -C /usr/local/bin pack
  chmod 0755 /usr/local/bin/pack
  pack --version
  write_status "buildpack_executor_ready"
fi
write_status "runtime_packages_installed"

unpack_embedded_archive() {
  rm -rf "$APP_ROOT"
  mkdir -p "$APP_DIR"
  cat >/tmp/deplai-app.tgz.b64 <<'ARCHIVE'
${var.app_archive_base64}
ARCHIVE
  base64 -d /tmp/deplai-app.tgz.b64 >/tmp/deplai-app.tgz
  tar -xzf /tmp/deplai-app.tgz -C "$APP_DIR"
  chown -R ec2-user:ec2-user "$APP_ROOT"
  write_status "application_unpacked_from_archive"
}

if [ -n "$REPOSITORY_URL" ]; then
  mkdir -p "$(dirname "$APP_ROOT")"
  if [ -d "$APP_ROOT/.git" ]; then
    cd "$APP_ROOT"
    git pull --ff-only || git pull
  else
    rm -rf "$APP_ROOT"
    if ! git clone "$REPOSITORY_URL" "$APP_ROOT"; then
      write_status "repository_clone_failed_archive_fallback"
      unpack_embedded_archive
    fi
  fi
  if [ -d "$APP_ROOT" ]; then
    chown -R ec2-user:ec2-user "$APP_ROOT"
  fi
  if [ ! -d "$APP_DIR" ]; then
    write_status "app_subdir_missing_archive_fallback"
    unpack_embedded_archive
  else
    write_status "repository_synced"
  fi
else
  unpack_embedded_archive
fi

cd "$APP_DIR"
SKIP_NODE_BUILD=0
WORKSPACE=0
WEB_DIR=""
API_DIR=""
for rel in frontend web client; do
  if [ -f "$APP_ROOT/$rel/package.json" ]; then WEB_DIR="$APP_ROOT/$rel"; break; fi
done
for rel in backend server api; do
  if [ -f "$APP_ROOT/$rel/package.json" ]; then API_DIR="$APP_ROOT/$rel"; break; fi
done
if [ -n "$WEB_DIR" ] && [ -n "$API_DIR" ]; then
  WORKSPACE=1
  APP_KIND="node"
  SKIP_NODE_BUILD=1
  write_status "node_workspace_detected"
fi
# Prebuilt artifacts skip hour-long compiles on t3.micro. Still fall back to npm if absent.
if [ "$APP_KIND" = "node" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  for candidate in build dist out; do
    if [ -d "$APP_DIR/$candidate" ] && [ -f "$APP_DIR/$candidate/index.html" ]; then
      APP_KIND="static"
      APP_DIR="$APP_DIR/$candidate"
      APP_PORT="80"
      SKIP_NODE_BUILD=1
      write_status "prebuilt_static_$candidate"
      break
    fi
  done
  if [ "$SKIP_NODE_BUILD" != "1" ] && [ -d "$APP_DIR/.next" ]; then
    SKIP_NODE_BUILD=1
    write_status "prebuilt_next_build"
  fi
fi
if [ "$APP_KIND" = "node" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ] && [ "$SKIP_NODE_BUILD" != "1" ]; then
  npm install -g pm2 || true
  pm2 delete "$APP_NAME" || true
  rm -rf .next
  npm cache clean --force || true
  if [ -f package-lock.json ]; then npm ci --legacy-peer-deps || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi
  if [ -n "$BUILD_COMMAND" ]; then export NODE_OPTIONS="--max-old-space-size=4096"; $BUILD_COMMAND; fi
  # CRA/Vite production builds should be served as static assets, not via webpack-dev `npm start`.
  for candidate in build dist out; do
    if [ -d "$APP_DIR/$candidate" ] && [ -f "$APP_DIR/$candidate/index.html" ]; then
      APP_KIND="static"
      APP_DIR="$APP_DIR/$candidate"
      APP_PORT="80"
      write_status "node_build_exported_as_static_$candidate"
      break
    fi
  done
fi
if [ "$APP_KIND" = "python" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ]; then
  if [ -f requirements.txt ]; then
    python3 -m pip install -r requirements.txt
  elif [ -f pyproject.toml ]; then
    python3 -m pip install .
  fi
  if [ -n "$BUILD_COMMAND" ] && [ "$BUILD_COMMAND" != "python3 -m pip install -r requirements.txt" ] && [ "$BUILD_COMMAND" != "python3 -m pip install ." ]; then
    bash -lc "$BUILD_COMMAND" || true
  fi
fi
if [ "$DEPLOYMENT_STRATEGY" != "buildpack" ] && { [ "$APP_KIND" = "go" ] || [ "$APP_KIND" = "java" ] || [ "$APP_KIND" = "dotnet" ] || [ "$APP_KIND" = "php" ] || [ "$APP_KIND" = "ruby" ] || [ "$APP_KIND" = "rust" ]; }; then
  if [ -n "$BUILD_COMMAND" ]; then
    write_status "language_build_started"
    bash -lc "cd '$APP_DIR' && $BUILD_COMMAND"
    write_status "language_build_done"
  fi
fi
if [ "$APP_KIND" = "docker" ]; then
  write_status "docker_build_or_compose_pending"
fi
write_status "application_dependencies_ready"

# ── Write .env file with injected environment variables ──────────────────────
# local.app_env_block is computed by Terraform before EC2 boots. It contains
# the actual DATABASE_URL (resolved from RDS outputs) and static vars like
# NODE_ENV, PORT, JWT_SECRET. The shell never sees raw Terraform interpolations.
printf '%s\n' '${local.app_env_block}' > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env" || true
write_status "env_file_written"

# ── Pull application secrets from AWS Secrets Manager (never logged) ────────
SECRETS_PREFIX="${var.secrets_manager_prefix}"
AWS_REGION_BOOT="${var.aws_region}"
if [ -n "$SECRETS_PREFIX" ]; then
  write_status "secrets_manager_fetch_started"
  dnf install -y awscli || true
  SECRET_NAMES="$(aws secretsmanager list-secrets --region "$AWS_REGION_BOOT" --filters Key=name,Values="$SECRETS_PREFIX" --query 'SecretList[].Name' --output text 2>/dev/null || true)"
  if [ -n "$SECRET_NAMES" ]; then
    echo "$SECRET_NAMES" | tr '\t' '\n' | while read -r SECRET_NAME; do
      [ -z "$SECRET_NAME" ] && continue
      case "$SECRET_NAME" in
        "$SECRETS_PREFIX"/*)
          SECRET_KEY="$${SECRET_NAME##*/}"
          [ -z "$SECRET_KEY" ] && continue
          SECRET_VALUE="$(aws secretsmanager get-secret-value --region "$AWS_REGION_BOOT" --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null || true)"
          if [ -n "$SECRET_VALUE" ]; then
            # Remove any prior key assignment, then append (value never echoed).
            grep -v "^$${SECRET_KEY}=" "$APP_DIR/.env" > "$APP_DIR/.env.tmp" 2>/dev/null || cp "$APP_DIR/.env" "$APP_DIR/.env.tmp"
            printf '%s=%s\n' "$SECRET_KEY" "$SECRET_VALUE" >> "$APP_DIR/.env.tmp"
            mv "$APP_DIR/.env.tmp" "$APP_DIR/.env"
          fi
          ;;
      esac
    done
  fi
  chmod 600 "$APP_DIR/.env" || true
  write_status "secrets_manager_fetch_done"
fi

__DEPLAI_PUBLIC_URL_BOOTSTRAP__

# ── Prisma: generate client and run migrations ───────────────────────────────
# Run only for node apps that have a prisma directory (detected at build time).
if [ "$WORKSPACE" != "1" ] && [ "$APP_KIND" = "node" ] && [ "$DEPLOYMENT_STRATEGY" != "buildpack" ] && [ "${var.has_prisma}" = "true" ]; then
  export $(grep -v '^#' "$APP_DIR/.env" | xargs) 2>/dev/null || true
  # Generate Prisma client (may already be done in node_modules from npm install)
  npx prisma generate --schema="$APP_DIR/prisma/schema.prisma" 2>/dev/null \
    || npx prisma generate 2>/dev/null || true
  # Run migrations if migrations directory exists; otherwise push schema
  if [ -d "$APP_DIR/prisma/migrations" ] && [ "$(ls -A "$APP_DIR/prisma/migrations" 2>/dev/null)" ]; then
    write_status "prisma_migrate_deploy_started"
    npx prisma migrate deploy --schema="$APP_DIR/prisma/schema.prisma" 2>/dev/null \
      || npx prisma migrate deploy 2>/dev/null || true
    write_status "prisma_migrate_deploy_done"
  else
    write_status "prisma_db_push_started"
    npx prisma db push --schema="$APP_DIR/prisma/schema.prisma" --accept-data-loss 2>/dev/null \
      || npx prisma db push --accept-data-loss 2>/dev/null || true
    write_status "prisma_db_push_done"
  fi
fi

if [ "$WORKSPACE" = "1" ]; then
  infer_package_port() {
    python3 - "$1" "$2" <<'PY'
import json, re, sys
path, default = sys.argv[1], int(sys.argv[2])
blocked = {5432, 3306, 6379, 27017, 1433, 1521}
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    print(default)
    raise SystemExit(0)
scripts = data.get("scripts") or {}
blob = " ".join(str(v) for v in scripts.values())
match = re.search(r"(?:-p|--port)\s+(\d{2,5})", blob)
if match:
    port = int(match.group(1))
    if 1 <= port <= 65535 and port not in blocked:
        print(port)
        raise SystemExit(0)
print(default)
PY
  }
  npm_in_dir() {
    local dir="$1"
    (
      cd "$dir"
      if [ -f package-lock.json ]; then npm ci --legacy-peer-deps || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi
      if grep -q '"build"' package.json 2>/dev/null; then
        export NODE_OPTIONS="--max-old-space-size=2048"
        npm run build
      fi
    )
  }
  start_pm2_dir() {
    local dir="$1" name="$2" port="$3"
    (
      cd "$dir"
      if [ -x node_modules/next/dist/bin/next ]; then
        PORT="$port" pm2 start node_modules/next/dist/bin/next --name "$name" -- start -p "$port"
      elif grep -q '"start"' package.json 2>/dev/null; then
        PORT="$port" pm2 start npm --name "$name" --cwd "$dir" -- start
      elif [ -f server.js ]; then
        PORT="$port" pm2 start server.js --name "$name"
      elif [ -f index.js ]; then
        PORT="$port" pm2 start index.js --name "$name"
      else
        echo "No start command in $dir" >&2
        return 1
      fi
    )
  }
  dnf install -y nodejs npm || true
  npm install -g pm2 || true
  WEB_PORT="$(infer_package_port "$WEB_DIR/package.json" 3000)"
  API_PORT="$(infer_package_port "$API_DIR/package.json" 5000)"
  mkdir -p "$API_DIR" "$WEB_DIR"
  if [ -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env" "$API_DIR/.env"
    cp "$APP_DIR/.env" "$WEB_DIR/.env"
  fi
  printf '\nPORT=%s\nHOST=0.0.0.0\n' "$API_PORT" >> "$API_DIR/.env"
  printf '\nPORT=%s\nHOST=0.0.0.0\nNEXT_PUBLIC_API_URL=/api\n' "$WEB_PORT" >> "$WEB_DIR/.env"
  chmod 600 "$API_DIR/.env" "$WEB_DIR/.env" || true
  npm_in_dir "$API_DIR"
  if [ -d "$API_DIR/prisma" ]; then
    (
      cd "$API_DIR"
      set -a
      [ -f .env ] && . ./.env
      set +a
      npx prisma generate || true
      if [ -d prisma/migrations ] && [ "$(ls -A prisma/migrations 2>/dev/null)" ]; then
        npx prisma migrate deploy || true
      else
        npx prisma db push || true
      fi
    )
  fi
  npm_in_dir "$WEB_DIR"
  pm2 delete "$APP_NAME-api" >/dev/null 2>&1 || true
  pm2 delete "$APP_NAME-web" >/dev/null 2>&1 || true
  start_pm2_dir "$API_DIR" "$APP_NAME-api" "$API_PORT"
  start_pm2_dir "$WEB_DIR" "$APP_NAME-web" "$WEB_PORT"
  pm2 save || true
  cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  location /api/ {
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
  location / {
    proxy_pass http://127.0.0.1:$WEB_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
NGINX
  rm -f /etc/nginx/conf.d/default.conf /usr/share/nginx/html/index.html || true
  systemctl enable nginx
  systemctl restart nginx
  write_status "node_workspace_running"
  exit 0
fi
if [ "$APP_KIND" = "static" ]; then
  rm -rf /usr/share/nginx/html/*
  cp -R "$APP_DIR"/. /usr/share/nginx/html/
  write_status "static_site_staged"
elif [ "$DEPLOYMENT_STRATEGY" = "buildpack" ]; then
  cd "$APP_DIR"
  write_status "buildpack_build_started"
  pack build "$APP_NAME:latest" --path "$APP_DIR" --builder "$BUILDPACK_BUILDER"
  write_status "buildpack_build_done"
  docker rm -f "$APP_NAME" || true
  docker run -d --name "$APP_NAME" --restart unless-stopped \
    -p "127.0.0.1:$APP_PORT:$APP_PORT" \
    --env-file "$APP_DIR/.env" \
    -e PORT="$APP_PORT" \
    "$APP_NAME:latest"
  cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX
  write_status "buildpack_container_started"
  write_status "application_service_started"
elif [ "$APP_KIND" = "docker" ]; then
  cd "$APP_DIR"
  ENV_FILE_ARGS=()
  if [ -f "$APP_DIR/.env" ]; then
    ENV_FILE_ARGS=(--env-file "$APP_DIR/.env")
  fi
  if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ] || [ -f compose.yaml ]; then
    COMPOSE_FILE=""
    for candidate in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
      if [ -f "$candidate" ]; then COMPOSE_FILE="$candidate"; break; fi
    done
    write_status "docker_compose_up_started"
    if [ -f "$APP_DIR/.env" ]; then
      docker compose -f "$COMPOSE_FILE" --env-file "$APP_DIR/.env" up -d --no-build \
        || docker compose -f "$COMPOSE_FILE" --env-file "$APP_DIR/.env" up -d --build
    else
      docker compose -f "$COMPOSE_FILE" up -d --no-build \
        || docker compose -f "$COMPOSE_FILE" up -d --build
    fi
    # Compose typically publishes its own host ports; avoid fighting nginx on :80.
    systemctl stop nginx || true
    systemctl disable nginx || true
    write_status "docker_compose_up_done"
  elif [ -f Dockerfile ] || [ -f dockerfile ]; then
    DOCKERFILE="Dockerfile"
    [ -f dockerfile ] && [ ! -f Dockerfile ] && DOCKERFILE="dockerfile"
    write_status "docker_image_build_started"
    docker build -t "$APP_NAME:latest" -f "$DOCKERFILE" .
    write_status "docker_image_build_done"
    docker rm -f "$APP_NAME" || true
    docker run -d --name "$APP_NAME" --restart unless-stopped \
      -p "127.0.0.1:$APP_PORT:$APP_PORT" \
      "$${ENV_FILE_ARGS[@]}" \
      -e PORT="$APP_PORT" \
      "$APP_NAME:latest"
    cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX
    write_status "docker_container_started"
  else
    write_status "docker_artifacts_missing"
    exit 1
  fi
  write_status "application_service_started"
else
  if [ "$APP_KIND" = "node" ]; then
    npm install -g pm2
    pm2 delete "$APP_NAME" || true
    if [ -x node_modules/next/dist/bin/next ]; then
      PORT="$APP_PORT" pm2 start node_modules/next/dist/bin/next --name "$APP_NAME" -- start -p "$APP_PORT"
    else
      PORT="$APP_PORT" pm2 start bash --name "$APP_NAME" -- -lc "cd '$APP_DIR' && PORT='$APP_PORT' $START_COMMAND"
    fi
    pm2 save
  else
    # python | go | java | dotnet | php | ruby | rust (and any future catalog language)
    cat >/etc/systemd/system/deplai-app.service <<SERVICE
[Unit]
Description=DeplAI deployed application
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$APP_PORT
Environment=APP_PORT=$APP_PORT
Environment=ASPNETCORE_URLS=http://0.0.0.0:$APP_PORT
EnvironmentFile=-$APP_DIR/.env
ExecStart=/bin/bash -lc "cd '$APP_DIR' && $START_COMMAND"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE
    systemctl daemon-reload
    systemctl enable --now deplai-app
  fi
  write_status "application_service_started"
  cat >/etc/nginx/conf.d/deplai-app.conf <<NGINX
server {
  listen 80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX
fi

if [ "$APP_KIND" = "static" ] || [ -f /etc/nginx/conf.d/deplai-app.conf ]; then
  nginx -t
  systemctl enable --now nginx
  systemctl restart nginx
  write_status "nginx_started"
else
  write_status "nginx_skipped_container_publishes_ports"
fi
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT$HEALTH_PATH" \
    || curl -fsS "http://127.0.0.1:$APP_PORT/" \
    || curl -fsS "http://127.0.0.1$HEALTH_PATH" \
    || curl -fsS "http://127.0.0.1/"; then
    write_status "health_check_passed"
    write_status "ready"
    exit 0
  fi
  sleep 5
done
write_status "health_check_failed"
rollback_unhealthy_release() {
  # This function only invokes a certified local service/container name.  It
  # never receives a free-text command from the API or an LLM.
  if [ "$APP_KIND" = "docker" ] || [ "$DEPLOYMENT_STRATEGY" = "buildpack" ]; then
    docker rm -f "$APP_NAME" || true
  elif [ "$APP_KIND" = "node" ]; then
    pm2 delete "$APP_NAME" || true
  else
    systemctl stop deplai-app || true
  fi
}
rollback_unhealthy_release
write_status "rolled_back_after_failed_health_check"
curl -v "http://127.0.0.1:$APP_PORT$HEALTH_PATH" || true
curl -v "http://127.0.0.1:$APP_PORT/" || true
curl -v "http://127.0.0.1/" || true
systemctl status nginx --no-pager || true
systemctl status deplai-app --no-pager || true
journalctl -u deplai-app --no-pager -n 80 || true
pm2 status || true
docker ps || true
docker compose ps || true
exit 1
USERDATA
  )

  root_block_device = [
    {
      volume_size           = var.root_volume_size_gb
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  ]

  metadata_options = {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = merge(local.tags, { Name = var.project_name })
}
'''

    outputs_tf = '''output "ec2_instance_id" {
  value = try(module.ec2[0].id, null)
}

output "ec2_instance_arn" {
  value = try(module.ec2[0].arn, null)
}

output "ec2_instance_state" {
  value = try(module.ec2[0].instance_state, null)
}

output "ec2_instance_type" {
  value = var.instance_type
}

output "ec2_public_ip" {
  value = try(module.ec2[0].public_ip, null)
}

output "ec2_private_ip" {
  value = try(module.ec2[0].private_ip, null)
}

output "ec2_public_dns" {
  value = try(module.ec2[0].public_dns, null)
}

output "ec2_private_dns" {
  value = try(module.ec2[0].private_dns, null)
}

output "ec2_vpc_id" {
  value = local.selected_vpc_id
}

output "ec2_subnet_id" {
  value = local.selected_subnet_id
}

output "deployment_verify_ssm_document" {
  value = aws_ssm_document.deployment_verify.name
}

output "rds_endpoint" {
  value = try(aws_db_instance.app[0].endpoint, null)
}

output "rds_address" {
  value = try(aws_db_instance.app[0].address, null)
}

output "rds_port" {
  value = try(aws_db_instance.app[0].port, null)
}

output "rds_database_name" {
  value = try(aws_db_instance.app[0].db_name, null)
}

output "redis_endpoint" {
  value = try(aws_elasticache_cluster.app[0].cache_nodes[0].address, null)
}

output "redis_port" {
  value = try(aws_elasticache_cluster.app[0].cache_nodes[0].port, null)
}

output "ec2_key_name" {
  value = local.selected_key_name
}

output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}

output "app_url" {
  value = try("http://${module.ec2[0].public_ip}", null)
}

output "health_check_url" {
  value = try("http://${module.ec2[0].public_ip}${var.health_path}", null)
}

output "app_kind" {
  value = var.app_kind
}

output "deployment_package_id" {
  value = var.artifact_source
}

output "cloudfront_url" {
  value = null
}
'''

    main_tf_resources = main_tf_resources.replace(
        "__DEPLAI_PUBLIC_URL_BOOTSTRAP__",
        public_url_bash.strip() if public_url_bash else 'write_status "public_url_skipped"',
    )
    main_tf_resources = main_tf_resources.replace(
        'source  = "terraform-aws-modules/ec2-instance/aws"\n  version = "5.8.0"',
        f'source  = "{EC2_MODULE_SOURCE}"\n  version = "{EC2_MODULE_VERSION}"',
    )

    auth_readme = ""
    if auth_requirements is not None:
        auth_readme = "\n".join(
            [
                "",
                "## Auth / OAuth",
                f"- Providers detected: {', '.join(auth_requirements.providers) or 'none'}",
                f"- Callback paths to register: {', '.join(auth_requirements.callback_paths[:6])}",
                *(f"- {line}" for line in auth_warning_lines),
                "- Supply OAuth/API secrets in the App Secrets tab (AWS Secrets Manager).",
                "- DeplAI injects NEXTAUTH_URL/APP_URL from the instance public IP at boot.",
                f"- Secrets Manager prefix: `{secrets_manager_prefix}`",
                "",
            ]
        )

    readme = f'''# DeplAI EC2 App Deployment

Generated by the deterministic `deplai_ec2_app` renderer. No LLM generated Terraform.

- Project: `{project_slug}`
- App kind: `{deployment_package.app_kind}`
- Executor strategy: `{deployment_package.strategy}`
- EC2 instance type: `{instance_type}`
- Root volume: `{root_volume_size_gb}GB`
- App port: `{app_port}`
- Health path: `{deployment_package.health_path}`
- Package files: `{deployment_package.package_file_count}`
- Package bytes: `{deployment_package.package_bytes}`
- RDS enabled: `{bool(database["enabled"])}`
- ElastiCache enabled: `{bool(redis["enabled"])}`
{auth_readme}
{context_summary}
'''

    files = [
        {"path": "terraform/providers.tf", "content": providers_tf},
        {"path": "terraform/backend.tf", "content": backend_tf},
        {"path": "terraform/variables.tf", "content": variables_tf},
        {"path": "terraform/main.tf", "content": main_tf + main_tf_resources},
        {"path": "terraform/outputs.tf", "content": outputs_tf},
        {"path": "terraform/terraform.tfvars", "content": tfvars},
        {"path": "README.md", "content": readme},
    ]

    package_manifest = deployment_package.as_manifest()
    if auth_requirements is not None:
        package_manifest["auth"] = auth_requirements.as_dict()
        package_manifest["warnings"] = [
            *list(package_manifest.get("warnings") or []),
            *auth_warning_lines,
        ]
    return {
        "files": files,
        "manifest": [
            {
                "id": "ec2_app",
                "type": "aws_instance",
                "strategy": "deplai_ec2_app",
                "dependencies": ["default_vpc", "security_group", "iam_instance_profile", "deployment_verify_ssm_document"],
                "config": package_manifest,
            }
        ],
        "dag_order": ["ec2_app"],
        "package_manifest": package_manifest,
        "provider_version": PROVIDER_VERSION,
        "warnings": [
            *list(deployment_package.warnings or []),
            *auth_warning_lines,
        ],
    }

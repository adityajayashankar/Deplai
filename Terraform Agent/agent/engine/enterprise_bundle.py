from __future__ import annotations

import base64
import json
import re
from typing import Any

from ..internal_registry import get_module, load_catalog, render_snippet, select_allowlisted_edits
from .runtime import DEFAULT_PROVIDER_CONSTRAINT, slugify


def _provider_expr(provider_version: str) -> str:
    version = str(provider_version or "").strip()
    if not version:
        catalog = load_catalog()
        version = str((catalog.get("provider") or {}).get("constraint") or DEFAULT_PROVIDER_CONSTRAINT).strip()
    # Never emit an AWS 6.x pin for the enterprise/registry stack — EC2 5.8.x + ALB 9.x break on it.
    if re.search(r"(~>\s*|>=\s*|=)\s*6(\.|$)", version) or re.match(r"6\.", version):
        catalog = load_catalog()
        version = str((catalog.get("provider") or {}).get("constraint") or DEFAULT_PROVIDER_CONSTRAINT).strip()
    version = version or DEFAULT_PROVIDER_CONSTRAINT
    return f"={version}" if version[:1].isdigit() else version


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def _coerce_positive_int(value: Any, default: int, *, allow_zero: bool = False) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    if number < 0 or (number == 0 and not allow_zero):
        return default
    return number


def _canonical_environment(value: str) -> str:
    compact = str(value or "").strip().lower()
    if compact == "production":
        return "prod"
    if compact == "development":
        return "dev"
    return compact or "dev"


def _canonical_compute_strategy(value: str) -> str:
    compact = str(value or "").strip().lower()
    if compact == "ec2-instance":
        return "ec2"
    if compact in {"cloudfront", "s3cloudfront"}:
        return "s3_cloudfront"
    return compact or "ec2"


def _as_record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _truthy_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off", ""}:
        return False
    return bool(value)


def profile_wants_alb(payload: dict[str, Any]) -> bool:
    """True when the approved profile/decision requires an Application Load Balancer."""
    if _truthy_flag(payload.get("need_alb")):
        return True
    networking = _as_record(payload.get("networking"))
    load_balancer = _as_record(networking.get("load_balancer"))
    if load_balancer:
        if "enabled" in load_balancer:
            return _truthy_flag(load_balancer.get("enabled"))
        return True
    decision = _as_record(payload.get("consultant_decision"))
    if _truthy_flag(decision.get("need_alb")):
        return True
    components = [
        str(item or "").strip().lower()
        for item in (decision.get("components") or [])
        if str(item or "").strip()
    ]
    if any(token in components for token in ("alb", "load_balancer", "application_load_balancer")):
        return True
    stack = _as_record(decision.get("stack_config"))
    alb_cfg = _as_record(stack.get("alb"))
    return bool(alb_cfg) and _truthy_flag(alb_cfg.get("enabled", True))


def profile_wants_eip(payload: dict[str, Any]) -> bool:
    """True when the approved profile/decision requires an Elastic IP."""
    if _truthy_flag(payload.get("need_eip")):
        return True
    networking = _as_record(payload.get("networking"))
    elastic_ip = _as_record(networking.get("elastic_ip"))
    if elastic_ip:
        if "enabled" in elastic_ip:
            return _truthy_flag(elastic_ip.get("enabled"))
        return True
    decision = _as_record(payload.get("consultant_decision"))
    if _truthy_flag(decision.get("need_eip")):
        return True
    components = [
        str(item or "").strip().lower()
        for item in (decision.get("components") or [])
        if str(item or "").strip()
    ]
    if any(token in components for token in ("eip", "elastic_ip", "elasticip")):
        return True
    stack = _as_record(decision.get("stack_config"))
    eip_cfg = _as_record(stack.get("eip"))
    return bool(eip_cfg) and _truthy_flag(eip_cfg.get("enabled", True))


def assert_endpoint_decision_renderable(payload: dict[str, Any]) -> None:
    """Refuse silent EC2-only downgrade when ALB/EIP were requested for an incompatible strategy."""
    wants_alb = profile_wants_alb(payload)
    wants_eip = profile_wants_eip(payload)
    if not wants_alb and not wants_eip:
        return
    strategy = _canonical_compute_strategy(
        str((_as_record(payload.get("compute")).get("strategy") or "ec2"))
    )
    if strategy == "s3_cloudfront":
        requested = ", ".join(
            part for part, enabled in (("ALB", wants_alb), ("EIP", wants_eip)) if enabled
        )
        raise ValueError(
            f"Consultant decision requests {requested} but compute.strategy is s3_cloudfront. "
            "Refusing silent EC2-only downgrade; set compute.strategy to ec2 (or ecs_fargate)."
        )
    if strategy == "ec2" and wants_alb:
        networking = _as_record(payload.get("networking"))
        public_cidrs = networking.get("public_subnet_cidrs")
        if isinstance(public_cidrs, list) and len(public_cidrs) == 1:
            raise ValueError(
                "ALB was requested (need_alb) but networking.public_subnet_cidrs only lists one "
                "subnet. Provide at least two public subnets in different AZs."
            )


_CURRENT_POSTGRES_VERSION = "15.17"
_POSTGRES_CURRENT_BY_MAJOR = {
    "13": "13.18",
    "14": "14.15",
    "15": _CURRENT_POSTGRES_VERSION,
    "16": "16.13",
    "17": "17.4",
}
_POSTGRES_SENTINELS = {"", "latest", "lts", "stable", "current", "alpine"}
_RETIRED_POSTGRES_VERSIONS = {
    **{f"13.{patch}": "13.18" for patch in range(1, 18)},
    **{f"14.{patch}": "14.15" for patch in range(1, 15)},
    **{f"15.{patch}": _CURRENT_POSTGRES_VERSION for patch in range(1, 17)},
    **{f"16.{patch}": "16.13" for patch in range(1, 13)},
}


def _supported_engine_version(engine: str, version: str) -> str:
    """Map Docker tags and retired RDS minors onto a CreateDBInstance-valid version."""
    engine_key = str(engine or "").strip().lower()
    raw = str(version or "").strip()
    token = raw.lower().split("-")[0].split("_")[0]
    if engine_key in {"mysql", "mariadb"}:
        if token in _POSTGRES_SENTINELS or not token or not token[0].isdigit():
            return "8.0" if engine_key == "mysql" else "10.11"
        return raw or ("8.0" if engine_key == "mysql" else "10.11")
    if token in _POSTGRES_SENTINELS or not token or not token[0].isdigit():
        return _CURRENT_POSTGRES_VERSION
    if token in _POSTGRES_CURRENT_BY_MAJOR:
        return _POSTGRES_CURRENT_BY_MAJOR[token]
    mapped = _RETIRED_POSTGRES_VERSIONS.get(token) or _RETIRED_POSTGRES_VERSIONS.get(raw)
    if mapped:
        return mapped
    major = token.split(".")[0]
    return _POSTGRES_CURRENT_BY_MAJOR.get(major, _CURRENT_POSTGRES_VERSION)


def build_enterprise_profile_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
    app_bootstrap: dict[str, Any] | None = None,
) -> tuple[dict[str, str], list[str]]:
    assert_endpoint_decision_renderable(payload)
    project_name = str(payload.get("project_name") or "deplai-project").strip() or "deplai-project"
    workspace = str(payload.get("workspace") or slugify(project_name)).strip() or slugify(project_name)
    environment = _canonical_environment(str(payload.get("environment") or "dev"))
    project_slug = slugify(project_name, "deplai-project")[:40]
    compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
    networking = payload.get("networking") if isinstance(payload.get("networking"), dict) else {}
    runtime_config = payload.get("runtime_config") if isinstance(runtime_config := payload.get("runtime_config"), dict) else {}
    data_layer = [item for item in payload.get("data_layer") or [] if isinstance(item, dict)]
    strategy = _canonical_compute_strategy(str(compute.get("strategy") or "ec2"))
    enable_alb = strategy == "ec2" and profile_wants_alb(payload)
    enable_eip = strategy == "ec2" and profile_wants_eip(payload)
    alb_module = get_module("alb")
    alb_module_source = str(alb_module.get("source") or "terraform-aws-modules/alb/aws")
    alb_module_version = str(alb_module.get("version") or "9.17.0")
    vpc_module = get_module("vpc")
    vpc_module_source = str(vpc_module.get("source") or "terraform-aws-modules/vpc/aws")
    vpc_module_version = str(vpc_module.get("version") or "5.21.0")
    ec2_module = get_module("ec2_instance")
    ec2_module_source = str(ec2_module.get("source") or "terraform-aws-modules/ec2-instance/aws")
    ec2_module_version = str(ec2_module.get("version") or "5.8.0")
    app_service = next((item for item in compute.get("services") or [] if isinstance(item, dict) and str(item.get("process_type") or "") == "web"), {})
    secrets_prefix = str(runtime_config.get("secrets_manager_prefix") or f"/{project_slug}/{environment}").strip() or f"/{project_slug}/{environment}"
    required_secrets = [str(item).strip() for item in runtime_config.get("required_secrets") or [] if str(item).strip()]
    has_postgres = any(str(item.get("type") or "") == "postgresql" for item in data_layer)
    has_redis = any(str(item.get("type") or "") == "redis" for item in data_layer)
    postgres_item = next((item for item in data_layer if str(item.get("type") or "") == "postgresql"), {})
    postgres_engine = str(postgres_item.get("engine") or "postgres").strip().lower() or "postgres"
    if postgres_engine not in {"postgres", "mysql", "mariadb"}:
        postgres_engine = "postgres"
    bootstrap = app_bootstrap if isinstance(app_bootstrap, dict) else {}
    repository_url = str(bootstrap.get("repository_url") or "").strip()
    app_kind = str(bootstrap.get("app_kind") or "").strip().lower()
    if not app_kind:
        app_kind = "node" if repository_url else "static"
    build_command = str(bootstrap.get("build_command") or "").strip()
    start_command = str(bootstrap.get("start_command") or "").strip()
    app_subdir = str(bootstrap.get("app_subdir") or ".").strip() or "."
    agent_edits = select_allowlisted_edits(payload, app_bootstrap=bootstrap)
    ec2_edits = agent_edits.get("ec2_instance") or {}
    rds_edits = agent_edits.get("rds") or {}
    cache_edits = agent_edits.get("elasticache") or {}
    alb_edits = agent_edits.get("alb") or {}
    instance_type = str(ec2_edits.get("instance_type") or "t3.micro").strip() or "t3.micro"
    if instance_type not in {"t3.micro", "t3.small", "t3.medium"}:
        instance_type = "t3.micro"
    app_port = int(ec2_edits.get("app_port") or app_service.get("port") or 3000)
    if app_port in {5432, 3306, 6379, 27017, 1433, 1521} or not (1 <= app_port <= 65535):
        app_port = 3000
    root_volume_size_gb = _coerce_positive_int(ec2_edits.get("root_volume_size_gb"), 8)
    redis_node_type = str(cache_edits.get("node_type") or "cache.t4g.micro").strip() or "cache.t4g.micro"
    redis_engine_version = str(cache_edits.get("engine_version") or "7.0").strip() or "7.0"
    if rds_edits.get("engine"):
        postgres_engine = str(rds_edits.get("engine")).strip().lower() or postgres_engine
        if postgres_engine not in {"postgres", "mysql", "mariadb"}:
            postgres_engine = "postgres"
    _default_db_version = {"postgres": _CURRENT_POSTGRES_VERSION, "mysql": "8.0", "mariadb": "10.11"}[postgres_engine]
    postgres_engine_version = _supported_engine_version(
        postgres_engine,
        str(rds_edits.get("engine_version") or _default_db_version).strip() or _default_db_version,
    )
    postgres_instance_class = str(rds_edits.get("instance_class") or "db.t4g.micro").strip() or "db.t4g.micro"
    postgres_storage = _coerce_positive_int(rds_edits.get("allocated_storage"), 20)
    postgres_multi_az = bool(rds_edits.get("multi_az"))
    postgres_backup = _coerce_positive_int(postgres_item.get("backup_retention_days"), 7, allow_zero=True)
    region = str(aws_region or "eu-north-1").strip() or "eu-north-1"
    provider_constraint = _provider_expr(provider_version)
    encoded_index = base64.b64encode((website_index_html or "").encode("utf-8")).decode("ascii")
    static_site = payload.get("static_site") if isinstance(payload.get("static_site"), dict) else {}
    cf_price_class = str(static_site.get("price_class") or "PriceClass_100").strip() or "PriceClass_100"
    if cf_price_class not in {"PriceClass_100", "PriceClass_200", "PriceClass_All"}:
        cf_price_class = "PriceClass_100"
    spa_fallback = bool(static_site.get("spa_fallback"))
    use_registry_slice = strategy == "ec2"
    terraform_required = str(
        (load_catalog().get("terraform") or {}).get("required_version") or ">= 1.6.0, < 1.12.0"
    ).strip() or ">= 1.6.0, < 1.12.0"

    versions_tf = f"""terraform {{
  required_version = "{terraform_required}"
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "{provider_constraint}"
    }}
    random = {{
      source  = "hashicorp/random"
      version = "~> 3.6.0"
    }}
    tls = {{
      source  = "hashicorp/tls"
      version = "~> 4.0.0"
    }}
  }}
}}
"""

    providers_tf = """provider "aws" {
  region = var.aws_region
  default_tags { tags = local.common_tags }
}
"""

    backend_tf = (
        f"""terraform {{
  backend "s3" {{
    bucket         = "{state_bucket}"
    key            = "{workspace}/${{var.environment}}/terraform.tfstate"
    region         = "{region}"
    dynamodb_table = "{lock_table}"
    encrypt        = true
  }}
}}
"""
        if str(state_bucket or "").strip() and str(lock_table or "").strip()
        else """terraform {
  backend "local" {}
}
"""
    )

    locals_tf = f"""locals {{
  common_tags = {{
    environment = var.environment
    team        = var.team
    cost_center = var.cost_center
    managed_by  = "terraform"
  }}

  enable_compute     = startswith(var.compute_strategy, "ec2")
  enable_static_site = var.compute_strategy == "s3_cloudfront"
  enable_postgres    = var.enable_postgres
  enable_redis       = var.enable_redis
  enable_alb         = var.enable_alb
  enable_eip         = var.enable_eip
}}
"""

    variables_tf = f"""variable "project_name" {{
  type    = string
  default = "{project_slug}"
  validation {{
    condition     = can(regex("^[a-z0-9-]+$", var.project_name))
    error_message = "project_name must use lowercase letters, numbers, and dashes."
  }}
}}

variable "environment" {{
  type    = string
  default = "{environment}"
  validation {{
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }}
}}

variable "aws_region" {{
  type    = string
  default = "{region}"
}}

variable "region" {{
  type    = string
  default = "{region}"
}}

variable "team" {{
  type    = string
  default = "platform-engineering"
}}

variable "cost_center" {{
  type    = string
  default = "engineering"
}}

variable "compute_strategy" {{
  type    = string
  default = "{strategy}"
  validation {{
    condition     = contains(["ec2", "s3_cloudfront"], var.compute_strategy)
    error_message = "compute_strategy must be ec2 or s3_cloudfront in the enterprise deterministic renderer."
  }}
}}

variable "vpc_cidr" {{
  type    = string
  default = "10.42.0.0/16"
  validation {{
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid CIDR block."
  }}
}}

variable "public_subnet_cidrs" {{
  type    = list(string)
  default = ["10.42.1.0/24", "10.42.2.0/24"]
}}

variable "private_subnet_cidrs" {{
  type    = list(string)
  default = ["10.42.11.0/24", "10.42.12.0/24"]
}}

variable "use_existing_vpc" {{
  type    = bool
  default = {str(str(networking.get("vpc") or "new") == "existing").lower()}
}}

variable "use_default_vpc" {{
  type    = bool
  default = false
}}

variable "instance_type" {{
  type    = string
  default = "{instance_type}"
  validation {{
    condition     = contains(["t3.micro", "t3.small", "t3.medium"], var.instance_type)
    error_message = "instance_type must be one of the approved low-cost defaults."
  }}
}}

variable "app_port" {{
  type    = number
  default = {app_port}
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

variable "repository_url" {{
  type    = string
  default = {_json(repository_url)}
}}

variable "app_kind" {{
  type    = string
  default = {_json(app_kind)}
}}

variable "build_command" {{
  type    = string
  default = {_json(build_command)}
}}

variable "start_command" {{
  type    = string
  default = {_json(start_command)}
}}

variable "app_subdir" {{
  type    = string
  default = {_json(app_subdir)}
}}

variable "app_archive_base64" {{
  type      = string
  default   = ""
  sensitive = true
}}

variable "deployment_package_id" {{
  type    = string
  default = {_json(str(bootstrap.get("package_id") or ""))}
}}

variable "bootstrap_index_html_base64" {{
  type      = string
  default   = "{encoded_index}"
  sensitive = true
}}

variable "required_secret_names" {{
  type    = list(string)
  default = {_json(required_secrets)}
}}

variable "secrets_manager_prefix" {{
  type    = string
  default = "{secrets_prefix}"
}}

variable "enable_postgres" {{
  type    = bool
  default = {str(has_postgres).lower()}
}}

variable "enable_redis" {{
  type    = bool
  default = {str(has_redis).lower()}
}}

variable "enable_alb" {{
  type    = bool
  default = {str(enable_alb).lower()}
}}

variable "enable_eip" {{
  type    = bool
  default = {str(enable_eip).lower()}
}}

variable "redis_node_type" {{
  type    = string
  default = "{redis_node_type}"
}}

variable "redis_engine_version" {{
  type    = string
  default = "{redis_engine_version}"
}}

variable "postgres_engine" {{
  type    = string
  default = "{postgres_engine}"
  validation {{
    condition     = contains(["postgres", "mysql", "mariadb"], var.postgres_engine)
    error_message = "postgres_engine must be postgres, mysql, or mariadb."
  }}
}}

variable "postgres_engine_version" {{
  type    = string
  default = "{postgres_engine_version}"
}}

variable "postgres_instance_class" {{
  type    = string
  default = "{postgres_instance_class}"
}}

variable "postgres_allocated_storage" {{
  type    = number
  default = {postgres_storage}
}}

variable "postgres_multi_az" {{
  type    = bool
  default = {str(postgres_multi_az).lower()}
}}

variable "postgres_backup_retention" {{
  type    = number
  default = {postgres_backup}
}}
"""

    data_tf = """data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
"""

    secrets_tf = """locals {
  # App secrets are optional. Runtime fetch happens at boot when values exist.
  # Do not look them up at plan/apply — missing keys must not fail Terraform.
  ssm_parameter_names = {
    for name in var.required_secret_names :
    name => "${var.secrets_manager_prefix}/${name}"
  }
}
"""

    if strategy == "s3_cloudfront":
        main_tf = f"""module "storage" {{
  source                      = "./modules/storage"
  enabled                     = true
  project_name                = var.project_name
  environment                 = var.environment
  bootstrap_index_html_base64 = var.bootstrap_index_html_base64
  cloudfront_price_class      = "{cf_price_class}"
  enable_spa_fallback         = {str(spa_fallback).lower()}
  common_tags                 = local.common_tags
}}
"""
        outputs_tf = """output "cloudfront_url" {
  value = module.storage.cloudfront_url
}

output "cloudfront_domain_name" {
  value = module.storage.cloudfront_domain_name
}

output "website_bucket_name" {
  value = module.storage.website_bucket_name
}

output "alb_dns_name" {
  value = null
}

output "rds_endpoint" {
  value = null
}

output "redis_endpoint" {
  value = null
}
"""
    else:
        main_tf = f"""module "networking" {{
  source               = "./modules/networking"
  project_name         = var.project_name
  environment          = var.environment
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  use_existing_vpc     = var.use_existing_vpc || var.use_default_vpc
  enable_nat_gateway   = {"true" if (enable_alb and (has_postgres or has_redis)) else "false"}
  use_registry_vpc     = {"true" if use_registry_slice else "false"}
  common_tags          = local.common_tags
}}

module "iam" {{
  source        = "./modules/iam"
  project_name  = var.project_name
  environment   = var.environment
  region        = var.aws_region
  secret_prefix = var.secrets_manager_prefix
  common_tags   = local.common_tags
}}

module "data" {{
  source                     = "./modules/data"
  enable_postgres            = local.enable_postgres
  enable_redis               = local.enable_redis
  redis_node_type            = var.redis_node_type
  redis_engine_version       = var.redis_engine_version
  postgres_engine            = var.postgres_engine
  postgres_engine_version    = var.postgres_engine_version
  postgres_instance_class    = var.postgres_instance_class
  postgres_allocated_storage = var.postgres_allocated_storage
  postgres_multi_az          = var.postgres_multi_az
  postgres_backup_retention  = var.postgres_backup_retention
  vpc_id                     = module.networking.vpc_id
  subnet_ids                 = module.networking.private_subnet_ids
  allowed_cidrs              = [var.vpc_cidr]
  common_tags                = local.common_tags
}}

module "compute" {{
  source                      = "./modules/compute"
  enabled                     = local.enable_compute
  project_name                = var.project_name
  environment                 = var.environment
  vpc_id                      = module.networking.vpc_id
  subnet_id                   = module.networking.public_subnet_ids[0]
  public_subnet_ids           = module.networking.public_subnet_ids
  ami_id                      = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  app_port                    = var.app_port
  enable_alb                  = local.enable_alb
  enable_eip                  = local.enable_eip
  bootstrap_index_html_base64 = var.bootstrap_index_html_base64
  instance_profile_name       = module.iam.instance_profile_name
  instance_role_name          = module.iam.instance_role_name
  existing_ec2_key_pair_name  = ""
  ec2_key_rotation            = var.ec2_key_rotation
  repository_url              = var.repository_url
  app_kind                    = var.app_kind
  build_command               = var.build_command
  start_command               = var.start_command
  app_subdir                  = var.app_subdir
  app_archive_base64          = var.app_archive_base64
  database_secret_arn         = try(module.data.rds_secret_arn, "")
  database_endpoint           = try(module.data.rds_endpoint, "")
  common_tags                 = local.common_tags
  depends_on                  = [module.data]
}}
"""
        alb_dns_output = (
            'output "alb_dns_name" {\n  value = module.compute.alb_dns_name\n}'
            if enable_alb
            else 'output "alb_dns_name" {\n  value = null\n}'
        )
        outputs_tf = f"""output "cloudfront_url" {{
  value = null
}}

output "cloudfront_domain_name" {{
  value = null
}}

output "website_bucket_name" {{
  value = null
}}

{alb_dns_output}

output "elastic_ip" {{
  value = module.compute.elastic_ip
}}

output "app_url" {{
  value = module.compute.app_url
}}

output "rds_endpoint" {{
  value = module.data.rds_endpoint
}}

output "rds_secret_arn" {{
  value     = module.data.rds_secret_arn
  sensitive = true
}}

output "redis_endpoint" {{
  value = module.data.redis_endpoint
}}

output "ec2_instance_id" {{
  value = module.compute.ec2_instance_id
}}

output "instance_id" {{
  value = module.compute.ec2_instance_id
}}

output "ec2_instance_arn" {{
  value = module.compute.ec2_instance_arn
}}

output "ec2_instance_state" {{
  value = module.compute.ec2_instance_state
}}

output "ec2_instance_type" {{
  value = module.compute.ec2_instance_type
}}

output "ec2_public_ip" {{
  value = module.compute.ec2_public_ip
}}

output "ec2_private_ip" {{
  value = module.compute.ec2_private_ip
}}

output "ec2_public_dns" {{
  value = module.compute.ec2_public_dns
}}

output "ec2_private_dns" {{
  value = module.compute.ec2_private_dns
}}

output "ec2_vpc_id" {{
  value = module.networking.vpc_id
}}

output "vpc_id" {{
  value = module.networking.vpc_id
}}

output "ec2_subnet_id" {{
  value = module.compute.ec2_subnet_id
}}

output "public_subnet_ids" {{
  value = module.networking.public_subnet_ids
}}

output "private_subnet_ids" {{
  value = module.networking.private_subnet_ids
}}

output "ec2_key_name" {{
  value = module.compute.ec2_key_name
}}

output "generated_ec2_private_key_pem" {{
  value     = module.compute.generated_ec2_private_key_pem
  sensitive = true
}}
"""

    networking_main = f"""data "aws_availability_zones" "available" {{
  state = "available"
}}

data "aws_vpcs" "default" {{
  filter {{
    name   = "isDefault"
    values = ["true"]
  }}
}}

locals {{
  deplai_prefer_default_vpc = var.use_existing_vpc
  has_default_vpc           = local.deplai_prefer_default_vpc && length(data.aws_vpcs.default.ids) > 0
}}

data "aws_vpc" "default" {{
  count = local.has_default_vpc ? 1 : 0
  id    = data.aws_vpcs.default.ids[0]
}}

data "aws_subnets" "default" {{
  count = local.has_default_vpc ? 1 : 0
  filter {{
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }}
}}

module "vpc" {{
  count   = local.has_default_vpc || !var.use_registry_vpc ? 0 : 1
  source  = "{vpc_module_source}"
  version = "{vpc_module_version}"

  name = "${{var.project_name}}-${{var.environment}}"
  cidr = var.vpc_cidr

  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnets  = var.public_subnet_cidrs
  private_subnets = var.private_subnet_cidrs

  enable_nat_gateway = var.enable_nat_gateway
  single_nat_gateway = true
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = var.common_tags
}}

resource "aws_vpc" "main" {{
  count                = local.has_default_vpc || var.use_registry_vpc ? 0 : 1
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.common_tags, {{ Name = "${{var.project_name}}-${{var.environment}}-vpc" }})
}}

resource "aws_internet_gateway" "main" {{
  count  = local.has_default_vpc || var.use_registry_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(var.common_tags, {{ Name = "${{var.project_name}}-${{var.environment}}-igw" }})
}}

resource "aws_subnet" "public" {{
  count                   = local.has_default_vpc || var.use_registry_vpc ? 0 : 2
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(var.common_tags, {{ Name = "${{var.project_name}}-${{var.environment}}-public-${{count.index + 1}}" }})
}}

resource "aws_subnet" "private" {{
  count             = local.has_default_vpc || var.use_registry_vpc ? 0 : 2
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(var.common_tags, {{ Name = "${{var.project_name}}-${{var.environment}}-private-${{count.index + 1}}" }})
}}

resource "aws_route_table" "public" {{
  count  = local.has_default_vpc || var.use_registry_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(var.common_tags, {{ Name = "${{var.project_name}}-${{var.environment}}-public-rt" }})
}}

resource "aws_route" "public_internet" {{
  count                  = local.has_default_vpc || var.use_registry_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}}

resource "aws_route_table_association" "public" {{
  count          = local.has_default_vpc || var.use_registry_vpc ? 0 : length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}}

locals {{
  vpc_id = (
    local.has_default_vpc ? data.aws_vpc.default[0].id :
    var.use_registry_vpc ? module.vpc[0].vpc_id :
    aws_vpc.main[0].id
  )
  public_subnet_ids = (
    local.has_default_vpc ? slice(data.aws_subnets.default[0].ids, 0, min(length(data.aws_subnets.default[0].ids), 2)) :
    var.use_registry_vpc ? module.vpc[0].public_subnets :
    [for subnet in aws_subnet.public : subnet.id]
  )
  private_subnet_ids = (
    local.has_default_vpc ? local.public_subnet_ids :
    var.use_registry_vpc ? module.vpc[0].private_subnets :
    [for subnet in aws_subnet.private : subnet.id]
  )
}}
"""

    networking_variables = """variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_cidrs" { type = list(string) }
variable "private_subnet_cidrs" { type = list(string) }
variable "use_existing_vpc" { type = bool }
variable "use_registry_vpc" {
  type    = bool
  default = false
}
variable "enable_nat_gateway" {
  type    = bool
  default = false
}
variable "common_tags" { type = map(string) }
"""

    networking_outputs = """output "vpc_id" { value = local.vpc_id }
output "public_subnet_ids" { value = local.public_subnet_ids }
output "private_subnet_ids" { value = local.private_subnet_ids }
"""

    iam_main = """data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

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
  name_prefix        = substr("${var.project_name}-${var.environment}-ec2-role-", 0, 38)
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = var.common_tags
}

resource "aws_iam_role_policy" "app" {
  name_prefix = substr("${var.project_name}-${var.environment}-app-", 0, 38)
  role        = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
        "secretsmanager:GetSecretValue", "kms:Decrypt",
        "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:DescribeImages"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name_prefix = substr("${var.project_name}-${var.environment}-instance-profile-", 0, 38)
  role        = aws_iam_role.ec2.name
}
"""

    iam_variables = """variable "project_name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "secret_prefix" { type = string }
variable "common_tags" { type = map(string) }
"""

    iam_outputs = """output "instance_profile_name" { value = aws_iam_instance_profile.ec2.name }
output "instance_role_name" { value = aws_iam_role.ec2.name }
"""

    database_main = """locals {
  sql_port = contains(["mysql", "mariadb"], var.postgres_engine) ? 3306 : 5432
  # Docker tags such as "latest" are not RDS engine versions. Coalesce here so a
  # leftover tfvars/default cannot reach CreateDBInstance.
  postgres_engine_sentinels = ["", "latest", "lts", "stable", "current", "alpine"]
  postgres_engine_version = (
    contains(local.postgres_engine_sentinels, lower(trimspace(var.postgres_engine_version)))
    ? (contains(["mysql"], var.postgres_engine) ? "8.0" : contains(["mariadb"], var.postgres_engine) ? "10.11" : "15.17")
    : var.postgres_engine_version
  )
  redis_engine_sentinels = ["", "latest", "lts", "stable", "current"]
  redis_engine_version = (
    contains(local.redis_engine_sentinels, lower(trimspace(var.redis_engine_version)))
    ? "7.0"
    : var.redis_engine_version
  )
}

resource "aws_security_group" "database" {
  count       = var.enable_postgres || var.enable_redis ? 1 : 0
  name_prefix = "database-"
  description = "Database access"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

  ingress {
    from_port   = local.sql_port
    to_port     = local.sql_port
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "postgres" {
  count      = var.enable_postgres ? 1 : 0
  name       = "postgres-${substr(md5(join(",", var.subnet_ids)), 0, 8)}"
  subnet_ids = var.subnet_ids
}

resource "aws_db_instance" "postgres" {
  count                       = var.enable_postgres ? 1 : 0
  identifier                  = "${var.postgres_engine}-${substr(md5(join(",", var.subnet_ids)), 0, 8)}"
  engine                      = var.postgres_engine
  engine_version              = local.postgres_engine_version
  instance_class              = var.postgres_instance_class
  allocated_storage           = var.postgres_allocated_storage
  multi_az                    = var.postgres_multi_az
  backup_retention_period     = var.postgres_backup_retention
  db_subnet_group_name        = aws_db_subnet_group.postgres[0].name
  vpc_security_group_ids      = [aws_security_group.database[0].id]
  publicly_accessible         = false
  skip_final_snapshot         = true
  manage_master_user_password = true
  storage_encrypted           = true
  username                    = "appadmin"
  db_name                     = "appdb"
  tags                        = var.common_tags

  timeouts {
    create = "45m"
    update = "60m"
    delete = "40m"
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  count      = var.enable_redis ? 1 : 0
  name       = "redis-${substr(md5(join(",", var.subnet_ids)), 0, 8)}"
  subnet_ids = var.subnet_ids
  tags       = var.common_tags
}

resource "aws_elasticache_cluster" "redis" {
  count                = var.enable_redis ? 1 : 0
  cluster_id           = "redis-${substr(md5(join(",", var.subnet_ids)), 0, 8)}"
  engine               = "redis"
  engine_version       = local.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.redis[0].name
  security_group_ids   = [aws_security_group.database[0].id]
  tags                 = var.common_tags
}
"""

    database_variables = """variable "enable_postgres" { type = bool }
variable "enable_redis" { type = bool }
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}
variable "redis_engine_version" {
  type    = string
  default = "7.0"
}
variable "postgres_engine" {
  type    = string
  default = "postgres"
}
variable "postgres_engine_version" {
  type    = string
  default = "15.17"
}
variable "postgres_instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "postgres_allocated_storage" {
  type    = number
  default = 20
}
variable "postgres_multi_az" {
  type    = bool
  default = false
}
variable "postgres_backup_retention" {
  type    = number
  default = 7
}
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_cidrs" { type = list(string) }
variable "common_tags" { type = map(string) }
"""

    database_outputs = """output "rds_endpoint" { value = try(aws_db_instance.postgres[0].address, null) }
output "rds_port" { value = try(aws_db_instance.postgres[0].port, null) }
output "rds_secret_arn" { value = try(aws_db_instance.postgres[0].master_user_secret[0].secret_arn, null) }
output "redis_endpoint" { value = try(aws_elasticache_cluster.redis[0].cache_nodes[0].address, null) }
output "redis_port" { value = try(aws_elasticache_cluster.redis[0].cache_nodes[0].port, null) }
"""

    storage_main = """resource "random_id" "bucket_suffix" {
  count       = var.enabled ? 1 : 0
  byte_length = 4
}

resource "aws_s3_bucket" "website" {
  count  = var.enabled ? 1 : 0
  bucket = "${var.project_name}-${var.environment}-site-${random_id.bucket_suffix[0].hex}"
  tags   = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-site" })
}

resource "aws_s3_bucket_public_access_block" "website" {
  count                   = var.enabled ? 1 : 0
  bucket                  = aws_s3_bucket.website[0].id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_object" "index" {
  count         = var.enabled ? 1 : 0
  bucket        = aws_s3_bucket.website[0].id
  key           = "index.html"
  content       = base64decode(var.bootstrap_index_html_base64)
  content_type  = "text/html"
}

resource "aws_s3_bucket_policy" "website" {
  count  = var.enabled ? 1 : 0
  bucket = aws_s3_bucket.website[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.website[0].arn}/*"]
    }]
  })
}

resource "aws_cloudfront_distribution" "website" {
  count               = var.enabled ? 1 : 0
  enabled             = true
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class
  origin {
    domain_name = aws_s3_bucket.website[0].bucket_regional_domain_name
    origin_id   = "site-origin"
  }
  default_cache_behavior {
    target_origin_id       = "site-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }

  dynamic "custom_error_response" {
    for_each = var.enable_spa_fallback ? [403, 404] : []
    content {
      error_code         = custom_error_response.value
      response_code      = 200
      response_page_path = "/index.html"
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
"""

    storage_variables = """variable "enabled" { type = bool }
variable "project_name" { type = string }
variable "environment" { type = string }
variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}
variable "cloudfront_price_class" {
  type    = string
  default = "PriceClass_100"
}
variable "enable_spa_fallback" {
  type    = bool
  default = false
}
variable "common_tags" { type = map(string) }
"""

    storage_outputs = """output "cloudfront_url" {
  value = try("https://${aws_cloudfront_distribution.website[0].domain_name}", null)
}

output "cloudfront_domain_name" {
  value = try(aws_cloudfront_distribution.website[0].domain_name, null)
}

output "website_bucket_name" {
  value = try(aws_s3_bucket.website[0].id, null)
}
"""

    if use_registry_slice:
        alb_app_ingress = (
            """  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb[0].id]
  }

  ingress {
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb[0].id]
  }"""
            if enable_alb
            else """  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }"""
        )
        compute_main = f"""locals {{
  use_existing_key = false
  ec2_key_name     = try(aws_key_pair.generated[0].key_name, null)
  alb_dns          = var.enable_alb && length(module.alb) > 0 ? module.alb[0].dns_name : null
  eip_public_ip    = var.enable_eip && length(aws_eip.app) > 0 ? aws_eip.app[0].public_ip : null
  ec2_public_ip    = try(module.ec2[0].public_ip, null)
  app_host         = coalesce(local.alb_dns, local.eip_public_ip, local.ec2_public_ip)
}}

resource "aws_security_group" "alb" {{
  count       = var.enabled && var.enable_alb ? 1 : 0
  name_prefix = "${{var.project_name}}-${{var.environment}}-alb-"
  description = "ALB ingress"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

  ingress {{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "aws_security_group" "app" {{
  count       = var.enabled ? 1 : 0
  name_prefix = "${{var.project_name}}-${{var.environment}}-app-"
  description = "Application traffic"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

{alb_app_ingress}

  ingress {{
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "tls_private_key" "generated" {{
  count     = var.enabled ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}}

resource "aws_key_pair" "generated" {{
  count      = var.enabled ? 1 : 0
  key_name   = "${{var.project_name}}-${{var.environment}}-${{var.ec2_key_rotation}}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags = merge(var.common_tags, {{
    Name             = "${{var.project_name}}-${{var.environment}}-${{var.ec2_key_rotation}}-key"
    "deplai:managed" = "true"
  }})
}}
"""
        artifacts_hcl = """
resource "aws_s3_bucket" "artifacts" {
  count         = var.enabled ? 1 : 0
  bucket_prefix = substr(replace("${var.project_name}-${var.environment}-art-", "_", "-"), 0, 37)
  force_destroy = true
  tags          = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-artifacts" })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  count                   = var.enabled ? 1 : 0
  bucket                  = aws_s3_bucket.artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  count  = var.enabled ? 1 : 0
  bucket = aws_s3_bucket.artifacts[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "app" {
  count  = var.enabled && fileexists("${path.root}/artifacts/app.tgz") ? 1 : 0
  bucket = one(aws_s3_bucket.artifacts[*].id)
  key    = "app.tgz"
  source = "${path.root}/artifacts/app.tgz"
  etag   = fileexists("${path.root}/artifacts/app.tgz") ? filemd5("${path.root}/artifacts/app.tgz") : ""
}

resource "aws_iam_role_policy" "artifacts" {
  # Role name comes from aws_iam_role with name_prefix, so it is unknown until
  # apply. Terraform forbids unknown values in count; the IAM module always
  # creates the instance role when compute is enabled.
  count       = var.enabled ? 1 : 0
  name_prefix = substr("${var.project_name}-${var.environment}-artifacts-", 0, 38)
  role        = var.instance_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.artifacts[*].arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = [for bucket in aws_s3_bucket.artifacts : "${bucket.arn}/*"]
      }
    ]
  })
}
"""
        # Compose EC2 / EIP / ALB from internal registry golden snippets.
        # Catalog pins stay fixed; only allowlisted edits come from the agent selector.
        ec2_snippet = render_snippet("ec2_instance", ec2_edits)
        eip_snippet = render_snippet("eip")
        alb_snippet = render_snippet("alb", alb_edits or {"health_path": "/"})
        compute_main = (
            compute_main
            + artifacts_hcl
            + "\n"
            + ec2_snippet
            + "\n\n"
            + eip_snippet
            + "\n\n"
            + alb_snippet
            + "\n"
        )
        compute_outputs = """output "ec2_instance_id" { value = try(module.ec2[0].id, null) }
output "ec2_instance_arn" { value = try(module.ec2[0].arn, null) }
output "ec2_instance_state" { value = try(module.ec2[0].instance_state, null) }
output "ec2_instance_type" { value = try(module.ec2[0].instance_type, null) }
output "ec2_public_ip" { value = coalesce(local.eip_public_ip, local.ec2_public_ip) }
output "ec2_private_ip" { value = try(module.ec2[0].private_ip, null) }
output "ec2_public_dns" { value = try(module.ec2[0].public_dns, null) }
output "ec2_private_dns" { value = try(module.ec2[0].private_dns, null) }
output "ec2_subnet_id" { value = try(module.ec2[0].subnet_id, null) }
output "ec2_key_name" { value = local.ec2_key_name }
output "alb_dns_name" { value = local.alb_dns }
output "elastic_ip" { value = local.eip_public_ip }
output "app_url" {
  value = local.app_host != null ? "http://${local.app_host}" : null
}
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
"""
    else:
        compute_main = """locals {
  use_existing_key = false
  ec2_key_name     = try(aws_key_pair.generated[0].key_name, null)
  alb_dns          = null
  eip_public_ip    = null
  ec2_public_ip    = try(aws_instance.app[0].public_ip, null)
  app_host         = local.ec2_public_ip
}

resource "aws_security_group" "app" {
  count       = var.enabled ? 1 : 0
  name_prefix = "${var.project_name}-${var.environment}-app-"
  description = "Application traffic"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "tls_private_key" "generated" {
  count     = var.enabled ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enabled ? 1 : 0
  key_name   = "${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags = merge(var.common_tags, {
    Name             = "${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key"
    "deplai:managed" = "true"
  })
}

resource "aws_instance" "app" {
  count                       = var.enabled ? 1 : 0
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.app[0].id]
  iam_instance_profile        = var.instance_profile_name
  key_name                    = local.ec2_key_name
  associate_public_ip_address = true
  user_data_replace_on_change = true
  tags                        = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-app" })

  metadata_options { http_tokens = "required" }

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = """ + str(root_volume_size_gb) + """
  }

  user_data = join("\\n", [
    "#!/bin/bash",
    "# deplai_key_rotation=${var.ec2_key_rotation}",
    "set -euxo pipefail",
    "dnf install -y nginx docker",
    "systemctl enable --now docker || true",
    "systemctl enable --now amazon-ssm-agent || true",
    "mkdir -p /usr/share/nginx/html",
    "cat <<'HTML' > /usr/share/nginx/html/index.html",
    "${base64decode(var.bootstrap_index_html_base64)}",
    "HTML",
    "systemctl enable nginx",
    "systemctl restart nginx"
  ])
}
"""
        compute_outputs = """output "ec2_instance_id" { value = try(aws_instance.app[0].id, null) }
output "ec2_instance_arn" { value = try(aws_instance.app[0].arn, null) }
output "ec2_instance_state" { value = try(aws_instance.app[0].instance_state, null) }
output "ec2_instance_type" { value = try(aws_instance.app[0].instance_type, null) }
output "ec2_public_ip" { value = try(aws_instance.app[0].public_ip, null) }
output "ec2_private_ip" { value = try(aws_instance.app[0].private_ip, null) }
output "ec2_public_dns" { value = try(aws_instance.app[0].public_dns, null) }
output "ec2_private_dns" { value = try(aws_instance.app[0].private_dns, null) }
output "ec2_subnet_id" { value = try(aws_instance.app[0].subnet_id, null) }
output "ec2_key_name" { value = local.ec2_key_name }
output "alb_dns_name" { value = null }
output "elastic_ip" { value = null }
output "app_url" {
  value = local.app_host != null ? "http://${local.app_host}" : null
}
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
"""

    compute_variables = """variable "enabled" { type = bool }
variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "public_subnet_ids" {
  type    = list(string)
  default = []
}
variable "ami_id" { type = string }
variable "instance_type" { type = string }
variable "app_port" { type = number }
variable "enable_alb" {
  type    = bool
  default = false
}
variable "enable_eip" {
  type    = bool
  default = false
}
variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}
variable "instance_profile_name" { type = string }
variable "instance_role_name" {
  type    = string
  default = ""
}
variable "existing_ec2_key_pair_name" {
  type    = string
  default = ""
}
variable "ec2_key_rotation" { type = string }
variable "repository_url" {
  type    = string
  default = ""
}
variable "app_kind" {
  type    = string
  default = "static"
}
variable "build_command" {
  type    = string
  default = ""
}
variable "start_command" {
  type    = string
  default = ""
}
variable "app_subdir" {
  type    = string
  default = "."
}
variable "app_archive_base64" {
  type      = string
  default   = ""
  sensitive = true
}
variable "database_secret_arn" {
  type    = string
  default = ""
}
variable "database_endpoint" {
  type    = string
  default = ""
}
variable "common_tags" { type = map(string) }
"""

    files = {
        "terraform/versions.tf": versions_tf,
        "terraform/providers.tf": providers_tf,
        "terraform/backend.tf": backend_tf,
        "terraform/locals.tf": locals_tf,
        "terraform/variables.tf": variables_tf,
        "terraform/data.tf": data_tf,
        "terraform/secrets.tf": secrets_tf,
        "terraform/main.tf": main_tf,
        "terraform/outputs.tf": outputs_tf,
        "terraform/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "{environment}"\naws_region = "{region}"\nregion = "{region}"\ncompute_strategy = "{strategy}"\ninstance_type = {_json(instance_type)}\napp_port = {app_port}\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "{secrets_prefix}"\nrepository_url = {_json(repository_url)}\napp_kind = {_json(app_kind)}\nbuild_command = {_json(build_command)}\nstart_command = {_json(start_command)}\napp_subdir = {_json(app_subdir)}\npostgres_engine_version = {_json(postgres_engine_version)}\nredis_engine_version = {_json(redis_engine_version)}\ndeployment_package_id = {_json(str(bootstrap.get("package_id") or ""))}\n',
        "terraform/artifacts/.gitkeep": "",
        "terraform/envs/dev/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "dev"\naws_region = "{region}"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/dev"\n',
        "terraform/envs/staging/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "staging"\naws_region = "{region}"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/staging"\n',
        "terraform/envs/prod/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "prod"\naws_region = "{region}"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/prod"\n',
        "terraform/backend-configs/dev.hcl": f'bucket = "{project_slug}-tfstate-dev"\nkey = "dev/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-dev"\nencrypt = true\n',
        "terraform/backend-configs/staging.hcl": f'bucket = "{project_slug}-tfstate-staging"\nkey = "staging/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-staging"\nencrypt = true\n',
        "terraform/backend-configs/prod.hcl": f'bucket = "{project_slug}-tfstate-prod"\nkey = "prod/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-prod"\nencrypt = true\n',
        "terraform/.terraform.lock.hcl": (
            "# Placeholder — replace with a real lock from `terraform providers lock` / `terraform init`\n"
            "# after testing. Production should commit hashes for hashicorp/aws at the catalog tested_version\n"
            "# (currently 5.100.0) and avoid -upgrade floating past the ~> 5.100.0 constraint.\n"
        ),
        "terraform/moved.tf": "# Add moved blocks here when promoting resources into modules.\n",
        "terraform/.tflint.hcl": 'plugin "aws" { enabled = true version = "0.29.0" source = "github.com/terraform-linters/tflint-ruleset-aws" }\n',
        "terraform/policies/sentinel/enforce-tags.sentinel": 'import "tfplan/v2" as tfplan\nmain = rule { true }\n',
        "terraform/policies/sentinel/restrict-regions.sentinel": 'import "tfplan/v2" as tfplan\nmain = rule { true }\n',
        "terraform/policies/sentinel/no-public-resources.sentinel": 'import "tfplan/v2" as tfplan\nmain = rule { true }\n',
        "terraform/policies/opa/no-public-s3.rego": 'package terraform.security\ndeny[msg] { false }\n',
        "terraform/policies/opa/require-encryption.rego": 'package terraform.security\ndeny[msg] { false }\n',
        "terraform/policies/opa/allowed-instance-types.rego": 'package terraform.security\ndeny[msg] { false }\n',
        "terraform/terragrunt.hcl": f'remote_state {{ backend = "s3" config = {{ bucket = "{project_slug}-tfstate-${{basename(get_terragrunt_dir())}}" key = "${{path_relative_to_include()}}/terraform.tfstate" region = "{region}" dynamodb_table = "{project_slug}-terraform-lock-${{basename(get_terragrunt_dir())}}" encrypt = true }} }}\n',
        "terraform/accounts/dev/terragrunt.hcl": 'include "root" { path = find_in_parent_folders("terragrunt.hcl") }\nterraform { source = "../../" }\n',
        "terraform/accounts/staging/terragrunt.hcl": 'include "root" { path = find_in_parent_folders("terragrunt.hcl") }\nterraform { source = "../../" }\n',
        "terraform/accounts/prod/terragrunt.hcl": 'include "root" { path = find_in_parent_folders("terragrunt.hcl") }\nterraform { source = "../../" }\n',
        "terraform/modules/networking/main.tf": networking_main,
        "terraform/modules/networking/variables.tf": networking_variables,
        "terraform/modules/networking/outputs.tf": networking_outputs,
        "terraform/modules/iam/main.tf": iam_main,
        "terraform/modules/iam/variables.tf": iam_variables,
        "terraform/modules/iam/outputs.tf": iam_outputs,
        "terraform/modules/compute/main.tf": compute_main,
        "terraform/modules/compute/variables.tf": compute_variables,
        "terraform/modules/compute/outputs.tf": compute_outputs,
        ".github/workflows/drift-detect.yml": "name: drift-detect\non:\n  schedule:\n    - cron: '0 8 * * 1-5'\n  workflow_dispatch:\njobs:\n  drift:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: hashicorp/setup-terraform@v3\n      - run: terraform -chdir=terraform init -backend-config=terraform/backend-configs/prod.hcl\n      - run: terraform -chdir=terraform plan -var-file=envs/prod/terraform.tfvars -detailed-exitcode\n",
        "CODEOWNERS": "/terraform/modules/iam/ @senior-infra-team\n/terraform/envs/prod/ @senior-infra-team\n/terraform/accounts/prod/ @senior-infra-team\n",
        "README.md": f"# Enterprise Terraform Bundle - {project_name}\n\nGenerated from the deployment profile.\n\n{context_summary or 'No additional operator context provided.'}\n",
    }

    if strategy == "s3_cloudfront":
        files["terraform/modules/storage/main.tf"] = storage_main
        files["terraform/modules/storage/variables.tf"] = storage_variables
        files["terraform/modules/storage/outputs.tf"] = storage_outputs
    else:
        files["terraform/modules/networking/main.tf"] = networking_main
        files["terraform/modules/networking/variables.tf"] = networking_variables
        files["terraform/modules/networking/outputs.tf"] = networking_outputs
        files["terraform/modules/iam/main.tf"] = iam_main
        files["terraform/modules/iam/variables.tf"] = iam_variables
        files["terraform/modules/iam/outputs.tf"] = iam_outputs
        files["terraform/modules/data/main.tf"] = database_main
        files["terraform/modules/data/variables.tf"] = database_variables
        files["terraform/modules/data/outputs.tf"] = database_outputs

    warnings = [
        "Generated enterprise Terraform scaffolding with version pinning, locals, env-separated tfvars, backend configs, modules, policy stubs, drift detection, and Terragrunt scaffolding.",
        "The committed .terraform.lock.hcl is a placeholder; refresh provider hashes in CI before production rollout.",
    ]
    if not state_bucket or not lock_table:
        warnings.append("backend.tf uses the local backend because remote state bucket/lock table values were not supplied.")
    if strategy == "s3_cloudfront":
        warnings.append("Static-site strategy disables compute resources and serves the bootstrap HTML through the storage module.")
    if enable_alb:
        warnings.append(
            f"ALB enabled via pinned registry module {alb_module_source}@{alb_module_version}; alb_dns_name/app_url prefer the load balancer DNS."
        )
    if enable_eip:
        warnings.append("Elastic IP enabled (aws_eip); elastic_ip/app_url fall back to the EIP when ALB is absent.")
    if use_registry_slice:
        warnings.append(
            f"EC2+ALB/EIP vertical slice composes pinned registry modules "
            f"(vpc {vpc_module_version}, ec2-instance {ec2_module_version}, alb {alb_module_version})."
        )
        warnings.append(
            "App delivery is S3 artifact pull plus a thin start script. Terraform does not git-clone "
            "or compile the app on the instance; connect with SSM Session Manager, not SSH."
        )
    return files, warnings

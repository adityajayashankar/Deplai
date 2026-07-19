from __future__ import annotations

import json
import re
import secrets
from typing import Any

from deployment_packager import DeploymentPackage


PROVIDER_VERSION = "~> 5.54"


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
) -> dict[str, Any]:
    allowed = {"t3.micro", "t3.small", "t3.medium", "t3.large"}
    profile = deployment_profile or {}
    decision = _record(profile.get("consultant_decision"))
    stack_config = _record(decision.get("stack_config"))
    decision_ec2 = {
        **_record(stack_config.get("ec2-instance")),
        **_record(stack_config.get("ec2")),
    }
    merged = {
        "instance_type": "t3.micro",
        "root_volume_size_gb": 35,
        "app_port": 3000,
        "ssh_ingress_cidr_blocks": [],
        **_ec2_config_from_source(user_answers),
        **decision_ec2,
    }
    instance_type = str(merged.get("instance_type") or "").strip().lower()
    if instance_type not in allowed:
        instance_type = "t3.micro"
    return {
        "instance_type": instance_type,
        "root_volume_size_gb": _int(merged.get("root_volume_size_gb"), 35, minimum=20, maximum=200),
        "app_port": _int(merged.get("app_port"), 3000, minimum=1, maximum=65535),
        "ssh_ingress_cidr_blocks": _cidr_list(merged.get("ssh_ingress_cidr_blocks")),
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


def _database_settings(deployment_profile: dict[str, Any] | None) -> dict[str, Any]:
    config = {**_data_layer_item(deployment_profile, {"postgres", "postgresql", "mysql", "mariadb"}), **_component_config(deployment_profile, "rds")}
    if not config:
        return {"enabled": False}
    engine = str(config.get("engine") or config.get("type") or "postgres").strip().lower()
    if engine == "postgresql":
        engine = "postgres"
    if engine not in {"postgres", "mysql", "mariadb"}:
        engine = "postgres"
    return {
        "enabled": True,
        "engine": engine,
        "engine_version": str(config.get("engine_version") or "").strip(),
        "instance_class": str(config.get("instance_class") or "db.t3.micro").strip(),
        "allocated_storage": _int(config.get("storage_gb"), 20, minimum=20, maximum=200),
        "multi_az": _bool(config.get("multi_az"), False),
        "backup_retention_period": _int(config.get("backup_retention_period") or config.get("backup_retention_days"), 7, minimum=0, maximum=35),
        "deletion_protection": _bool(config.get("deletion_protection"), False),
    }


def _redis_settings(deployment_profile: dict[str, Any] | None) -> dict[str, Any]:
    config = {**_data_layer_item(deployment_profile, {"redis", "elasticache"}), **_component_config(deployment_profile, "elasticache")}
    if not config:
        return {"enabled": False}
    return {
        "enabled": True,
        "node_type": str(config.get("node_type") or "cache.t4g.micro").strip(),
        "engine_version": str(config.get("engine_version") or "").strip(),
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
    ec2_settings = _ec2_settings(user_answers, deployment_profile)
    instance_type = str(ec2_settings["instance_type"])
    app_port = int(ec2_settings["app_port"])
    root_volume_size_gb = int(ec2_settings["root_volume_size_gb"])
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
            "instance_class": "db.t3.micro",
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
    # Always inject a JWT_SECRET so auth frameworks don't crash even when there
    # is no user-supplied secret.
    app_env_vars.setdefault("JWT_SECRET", jwt_secret)
    app_env_vars.setdefault("NODE_ENV", "production")
    app_env_vars.setdefault("PORT", str(app_port))

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
  required_version = ">= 1.5.0"
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
  type    = bool
  default = true
}}

variable "enable_ec2" {{
  type    = bool
  default = true
}}

variable "existing_ec2_key_pair_name" {{
  type    = string
  default = ""
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
'''

    # Build tfvars env map — when RDS is enabled the DATABASE_URL contains
    # Terraform interpolation expressions, so we emit a templatefile()-style
    # locals block in main.tf instead of a static tfvars entry.
    # For the tfvars file we only include non-interpolated vars.
    static_env_vars = {k: v for k, v in app_env_vars.items() if "${" not in v}
    interpolated_env_vars = {k: v for k, v in app_env_vars.items() if "${" in v}

    tfvars = f'''project_name = {_hcl_string(project_slug)}
aws_region = {_hcl_string(aws_region)}
environment = {_hcl_string(environment)}
instance_type = {_hcl_string(instance_type)}
app_kind = {_hcl_string(deployment_package.app_kind)}
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
  static_env_block = join("\\n", [
    "NODE_ENV=production",
    "PORT=${{var.app_port}}",
    "JWT_SECRET={jwt_secret}",
  ])
}}
'''

    main_tf_resources = r'''


data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_vpc" "default" {
  count   = var.use_default_vpc ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.use_default_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

resource "aws_vpc" "main" {
  count                = var.use_default_vpc ? 0 : 1
  cidr_block           = "10.52.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.project_name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "${var.project_name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.use_default_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = "10.52.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, { Name = "${var.project_name}-public-subnet" })
}

resource "aws_route_table" "public" {
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, { Name = "${var.project_name}-public-rt" })
}

resource "aws_route" "internet_access" {
  count                  = var.use_default_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count          = var.use_default_vpc ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  selected_vpc_id     = var.use_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  selected_subnet_ids = var.use_default_vpc ? data.aws_subnets.default[0].ids : aws_subnet.public[*].id
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
    project_name = var.project_name
  }
}

resource "tls_private_key" "generated" {
  count     = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  key_name   = "${var.project_name}-${random_id.key_suffix.hex}"
  public_key = tls_private_key.generated[0].public_key_openssh
  tags       = local.tags
}

locals {
  selected_key_name = !var.enable_ec2 ? null : (
    trimspace(var.existing_ec2_key_pair_name) != ""
    ? trimspace(var.existing_ec2_key_pair_name)
    : try(aws_key_pair.generated[0].key_name, null)
  )
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
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name_prefix = "${var.project_name}-ec2-"
  role        = aws_iam_role.ec2.name
}

resource "aws_instance" "app" {
  count                       = var.enable_ec2 ? 1 : 0
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = local.selected_subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  key_name                    = local.selected_key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true

  user_data_base64 = base64encode(<<-USERDATA
#!/bin/bash
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
REPOSITORY_URL=${jsonencode(var.repository_url)}
BUILD_COMMAND=${jsonencode(var.build_command)}
START_COMMAND=${jsonencode(var.start_command)}
HEALTH_PATH=${jsonencode(var.health_path)}
BOOTSTRAP_STATUS_FILE="/var/log/deplai-bootstrap-status.json"

write_status() {
  printf '{"phase":"%s","timestamp":"%s"}\n' "$1" "$(date -Is)" > "$BOOTSTRAP_STATUS_FILE"
}

write_status "starting"

dnf update -y
dnf install -y git nginx tar gzip cloud-utils-growpart xfsprogs
growpart /dev/nvme0n1 1 || true
xfs_growfs -d / || resize2fs /dev/nvme0n1p1 || true
df -h || true

if [ "$APP_KIND" = "node" ]; then
  dnf install -y nodejs npm
  swapoff /swapfile || true
  rm -f /swapfile
  fallocate -l 6G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi
if [ "$APP_KIND" = "python" ]; then
  dnf install -y python3 python3-pip
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
if [ "$APP_KIND" = "node" ]; then
  npm install -g pm2 || true
  pm2 delete "$APP_NAME" || true
  rm -rf .next
  npm cache clean --force || true
  if [ -f package-lock.json ]; then npm ci --legacy-peer-deps || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi
  if [ -n "$BUILD_COMMAND" ]; then export NODE_OPTIONS="--max-old-space-size=4096"; $BUILD_COMMAND; fi
fi
if [ "$APP_KIND" = "python" ] && [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt
fi
write_status "application_dependencies_ready"

# ── Write .env file with injected environment variables ──────────────────────
# local.app_env_block is computed by Terraform before EC2 boots. It contains
# the actual DATABASE_URL (resolved from RDS outputs) and static vars like
# NODE_ENV, PORT, JWT_SECRET. The shell never sees raw ${...} expressions.
printf '%s\n' '${local.app_env_block}' > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env" || true
write_status "env_file_written"

# ── Prisma: generate client and run migrations ───────────────────────────────
# Run only for node apps that have a prisma directory (detected at build time).
if [ "$APP_KIND" = "node" ] && [ "${var.has_prisma}" = "true" ]; then
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

if [ "$APP_KIND" = "static" ]; then
  rm -rf /usr/share/nginx/html/*
  cp -R "$APP_DIR"/. /usr/share/nginx/html/
  write_status "static_site_staged"
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
    cat >/etc/systemd/system/deplai-app.service <<SERVICE
[Unit]
Description=DeplAI deployed application
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$APP_PORT
ExecStart=/bin/bash -lc "$START_COMMAND"
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

nginx -t
systemctl enable --now nginx
systemctl restart nginx
write_status "nginx_started"
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT$HEALTH_PATH" || curl -fsS "http://127.0.0.1:$APP_PORT/"; then
    write_status "ready"
    exit 0
  fi
  sleep 5
done
write_status "health_check_failed"
curl -v "http://127.0.0.1:$APP_PORT$HEALTH_PATH" || true
curl -v "http://127.0.0.1:$APP_PORT/" || true
curl -v "http://127.0.0.1/" || true
systemctl status nginx --no-pager || true
systemctl status deplai-app --no-pager || true
journalctl -u deplai-app --no-pager -n 80 || true
pm2 status || true
exit 1
USERDATA
  )

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = merge(local.tags, { Name = var.project_name })
}
'''

    outputs_tf = '''output "ec2_instance_id" {
  value = try(aws_instance.app[0].id, null)
}

output "ec2_instance_arn" {
  value = try(aws_instance.app[0].arn, null)
}

output "ec2_instance_state" {
  value = try(aws_instance.app[0].instance_state, null)
}

output "ec2_instance_type" {
  value = var.instance_type
}

output "ec2_public_ip" {
  value = try(aws_instance.app[0].public_ip, null)
}

output "ec2_private_ip" {
  value = try(aws_instance.app[0].private_ip, null)
}

output "ec2_public_dns" {
  value = try(aws_instance.app[0].public_dns, null)
}

output "ec2_private_dns" {
  value = try(aws_instance.app[0].private_dns, null)
}

output "ec2_vpc_id" {
  value = local.selected_vpc_id
}

output "ec2_subnet_id" {
  value = local.selected_subnet_id
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
  value = try("http://${aws_instance.app[0].public_ip}", null)
}

output "health_check_url" {
  value = try("http://${aws_instance.app[0].public_ip}${var.health_path}", null)
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

    readme = f'''# DeplAI EC2 App Deployment

Generated by the deterministic `deplai_ec2_app` renderer. No LLM generated Terraform.

- Project: `{project_slug}`
- App kind: `{deployment_package.app_kind}`
- EC2 instance type: `{instance_type}`
- Root volume: `{root_volume_size_gb}GB`
- App port: `{app_port}`
- Health path: `{deployment_package.health_path}`
- Package files: `{deployment_package.package_file_count}`
- Package bytes: `{deployment_package.package_bytes}`
- RDS enabled: `{bool(database["enabled"])}`
- ElastiCache enabled: `{bool(redis["enabled"])}`

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
    return {
        "files": files,
        "manifest": [
            {
                "id": "ec2_app",
                "type": "aws_instance",
                "strategy": "deplai_ec2_app",
                "dependencies": ["default_vpc", "security_group", "iam_instance_profile"],
                "config": package_manifest,
            }
        ],
        "dag_order": ["ec2_app"],
        "package_manifest": package_manifest,
        "provider_version": PROVIDER_VERSION,
    }

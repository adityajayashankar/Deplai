from __future__ import annotations

import json
import re
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


def _instance_type(user_answers: dict[str, Any] | None, deployment_profile: dict[str, Any] | None) -> str:
    allowed = {"t3.micro", "t3.small", "t3.medium", "t3.large"}
    for source in (user_answers or {}, deployment_profile or {}):
        for key, value in source.items():
            if "instance" not in str(key).lower():
                continue
            candidate = str(value or "").strip().lower()
            if candidate in allowed:
                return candidate
    return "t3.micro"


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


def _component_config(deployment_profile: dict[str, Any] | None, name: str) -> dict[str, Any]:
    profile = deployment_profile or {}
    decision = _record(profile.get("consultant_decision"))
    stack_config = _record(decision.get("stack_config"))
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
) -> dict[str, Any]:
    project_slug = _safe_slug(project_name)
    environment = str((deployment_profile or {}).get("environment") or "production").strip().lower() or "production"
    instance_type = _instance_type(user_answers, deployment_profile)
    database = _database_settings(deployment_profile)
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
  default = {deployment_package.app_port}
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
'''

    tfvars = f'''project_name = {_hcl_string(project_slug)}
aws_region = {_hcl_string(aws_region)}
environment = {_hcl_string(environment)}
instance_type = {_hcl_string(instance_type)}
app_kind = {_hcl_string(deployment_package.app_kind)}
app_port = {deployment_package.app_port}
health_path = {_hcl_string(deployment_package.health_path)}
build_command = {_hcl_string(deployment_package.build_command)}
start_command = {_hcl_string(deployment_package.start_command)}
artifact_source = {_hcl_string(deployment_package.package_id)}
state_bucket = {_hcl_string(state_bucket)}
lock_table = {_hcl_string(lock_table)}
ingress_cidr_blocks = {_hcl_string_list(["0.0.0.0/0"])}
ssh_ingress_cidr_blocks = []
use_default_vpc = true
enable_ec2 = true
existing_ec2_key_pair_name = ""
app_archive_base64 = {_hcl_string(deployment_package.package_base64)}
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
'''

    main_tf = r'''locals {
  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "deplai"
    Renderer    = "deplai_ec2_app"
  }
}

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

APP_DIR="/opt/deplai-app"
APP_PORT="${var.app_port}"
APP_KIND="${var.app_kind}"
BUILD_COMMAND=${jsonencode(var.build_command)}
START_COMMAND=${jsonencode(var.start_command)}
HEALTH_PATH=${jsonencode(var.health_path)}

dnf update -y
dnf install -y nginx tar gzip
if [ "$APP_KIND" = "node" ]; then
  dnf install -y nodejs npm
fi
if [ "$APP_KIND" = "python" ]; then
  dnf install -y python3 python3-pip
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cat >/tmp/deplai-app.tgz.b64 <<'ARCHIVE'
${var.app_archive_base64}
ARCHIVE
base64 -d /tmp/deplai-app.tgz.b64 >/tmp/deplai-app.tgz
tar -xzf /tmp/deplai-app.tgz -C "$APP_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

cd "$APP_DIR"
if [ "$APP_KIND" = "node" ]; then
  if [ -f package-lock.json ]; then npm ci --omit=dev || npm install --omit=dev; else npm install --omit=dev; fi
  if [ -n "$BUILD_COMMAND" ]; then su -s /bin/bash ec2-user -c "cd $APP_DIR && $BUILD_COMMAND"; fi
fi
if [ "$APP_KIND" = "python" ] && [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt
fi

if [ "$APP_KIND" = "static" ]; then
  rm -rf /usr/share/nginx/html/*
  cp -R "$APP_DIR"/. /usr/share/nginx/html/
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
User=ec2-user

[Install]
WantedBy=multi-user.target
SERVICE
  systemctl daemon-reload
  systemctl enable --now deplai-app
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

systemctl enable --now nginx
systemctl restart nginx
curl -fsS "http://127.0.0.1$HEALTH_PATH" || curl -fsS "http://127.0.0.1/"
USERDATA
  )

  root_block_device {
    volume_size           = 12
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
- App port: `{deployment_package.app_port}`
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
        {"path": "terraform/main.tf", "content": main_tf},
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

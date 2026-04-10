from __future__ import annotations

import base64
import json
from typing import Any

from .runtime import DEFAULT_PROVIDER_CONSTRAINT, slugify


def _provider_expr(provider_version: str) -> str:
    version = str(provider_version or DEFAULT_PROVIDER_CONSTRAINT).strip() or DEFAULT_PROVIDER_CONSTRAINT
    return f"={version}" if version[:1].isdigit() else version


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def build_enterprise_profile_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
) -> tuple[dict[str, str], list[str]]:
    project_name = str(payload.get("project_name") or "deplai-project").strip() or "deplai-project"
    workspace = str(payload.get("workspace") or slugify(project_name)).strip() or slugify(project_name)
    environment = str(payload.get("environment") or "dev").strip() or "dev"
    project_slug = slugify(project_name, "deplai-project")[:40]
    compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
    networking = payload.get("networking") if isinstance(payload.get("networking"), dict) else {}
    runtime_config = payload.get("runtime_config") if isinstance(runtime_config := payload.get("runtime_config"), dict) else {}
    data_layer = [item for item in payload.get("data_layer") or [] if isinstance(item, dict)]
    strategy = str(compute.get("strategy") or "ec2").strip() or "ec2"
    app_service = next((item for item in compute.get("services") or [] if isinstance(item, dict) and str(item.get("process_type") or "") == "web"), {})
    app_port = int(app_service.get("port") or 3000)
    secrets_prefix = str(runtime_config.get("secrets_manager_prefix") or f"/{project_slug}/{environment}").strip() or f"/{project_slug}/{environment}"
    required_secrets = [str(item).strip() for item in runtime_config.get("required_secrets") or [] if str(item).strip()]
    has_postgres = any(str(item.get("type") or "") == "postgresql" for item in data_layer)
    has_redis = any(str(item.get("type") or "") == "redis" for item in data_layer)
    region = str(aws_region or "eu-north-1").strip() or "eu-north-1"
    provider_constraint = _provider_expr(provider_version)
    encoded_index = base64.b64encode((website_index_html or "").encode("utf-8")).decode("ascii")

    versions_tf = f"""terraform {{
  required_version = ">= 1.6.0"
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "{provider_constraint}"
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
"""

    providers_tf = """provider "aws" {
  region = var.region
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

  enable_compute     = var.compute_strategy == "ec2"
  enable_static_site = var.compute_strategy == "s3_cloudfront"
  enable_postgres    = var.enable_postgres
  enable_redis       = var.enable_redis
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
  default = "t3.micro"
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
  ssm_parameter_names = {
    for name in var.required_secret_names :
    name => "${var.secrets_manager_prefix}/${name}"
  }
}

data "aws_ssm_parameter" "managed" {
  for_each        = local.ssm_parameter_names
  name            = each.value
  with_decryption = true
}
"""

    if strategy == "s3_cloudfront":
        main_tf = """module "storage" {
  source                      = "./modules/storage"
  enabled                     = true
  project_name                = var.project_name
  environment                 = var.environment
  bootstrap_index_html_base64 = var.bootstrap_index_html_base64
  common_tags                 = local.common_tags
}
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
        main_tf = """module "networking" {
  source               = "./modules/networking"
  project_name         = var.project_name
  environment          = var.environment
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  use_existing_vpc     = var.use_existing_vpc || var.use_default_vpc
  common_tags          = local.common_tags
}

module "iam" {
  source        = "./modules/iam"
  project_name  = var.project_name
  environment   = var.environment
  region        = var.region
  secret_prefix = var.secrets_manager_prefix
  common_tags   = local.common_tags
}

module "data" {
  source          = "./modules/data"
  enable_postgres = local.enable_postgres
  enable_redis    = local.enable_redis
  vpc_id          = module.networking.vpc_id
  subnet_ids      = module.networking.private_subnet_ids
  allowed_cidrs   = [var.vpc_cidr]
  common_tags     = local.common_tags
}

module "compute" {
  source                      = "./modules/compute"
  enabled                     = local.enable_compute
  project_name                = var.project_name
  environment                 = var.environment
  vpc_id                      = module.networking.vpc_id
  subnet_id                   = module.networking.public_subnet_ids[0]
  ami_id                      = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  app_port                    = var.app_port
  bootstrap_index_html_base64 = var.bootstrap_index_html_base64
  instance_profile_name       = module.iam.instance_profile_name
  existing_ec2_key_pair_name  = var.existing_ec2_key_pair_name
  common_tags                 = local.common_tags
}
"""
        outputs_tf = """output "cloudfront_url" {
  value = null
}

output "cloudfront_domain_name" {
  value = null
}

output "website_bucket_name" {
  value = null
}

output "alb_dns_name" {
  value = null
}

output "rds_endpoint" {
  value = module.data.rds_endpoint
}

output "redis_endpoint" {
  value = module.data.redis_endpoint
}

output "ec2_instance_id" {
  value = module.compute.ec2_instance_id
}

output "ec2_instance_arn" {
  value = module.compute.ec2_instance_arn
}

output "ec2_instance_state" {
  value = module.compute.ec2_instance_state
}

output "ec2_instance_type" {
  value = module.compute.ec2_instance_type
}

output "ec2_public_ip" {
  value = module.compute.ec2_public_ip
}

output "ec2_private_ip" {
  value = module.compute.ec2_private_ip
}

output "ec2_public_dns" {
  value = module.compute.ec2_public_dns
}

output "ec2_private_dns" {
  value = module.compute.ec2_private_dns
}

output "ec2_vpc_id" {
  value = module.networking.vpc_id
}

output "ec2_subnet_id" {
  value = module.compute.ec2_subnet_id
}

output "ec2_key_name" {
  value = module.compute.ec2_key_name
}

output "generated_ec2_private_key_pem" {
  value     = module.compute.generated_ec2_private_key_pem
  sensitive = true
}
"""

    networking_main = """data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_vpc" "default" {
  count   = var.use_existing_vpc ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.use_existing_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

resource "aws_vpc" "main" {
  count                = var.use_existing_vpc ? 0 : 1
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-vpc" })
}

resource "aws_internet_gateway" "main" {
  count  = var.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.use_existing_vpc ? 0 : 2
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-public-${count.index + 1}" })
}

resource "aws_subnet" "private" {
  count             = var.use_existing_vpc ? 0 : 2
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-private-${count.index + 1}" })
}

resource "aws_route_table" "public" {
  count  = var.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-public-rt" })
}

resource "aws_route" "public_internet" {
  count                  = var.use_existing_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count          = var.use_existing_vpc ? 0 : length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  vpc_id            = var.use_existing_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  public_subnet_ids = var.use_existing_vpc ? slice(data.aws_subnets.default[0].ids, 0, min(length(data.aws_subnets.default[0].ids), 2)) : [for subnet in aws_subnet.public : subnet.id]
  private_subnet_ids = var.use_existing_vpc ? local.public_subnet_ids : [for subnet in aws_subnet.private : subnet.id]
}
"""

    networking_variables = """variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_cidrs" { type = list(string) }
variable "private_subnet_cidrs" { type = list(string) }
variable "use_existing_vpc" { type = bool }
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
  name_prefix        = "${var.project_name}-${var.environment}-ec2-role-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = var.common_tags
}

resource "aws_iam_role_policy" "app" {
  name_prefix = "${var.project_name}-${var.environment}-app-"
  role        = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "secretsmanager:GetSecretValue", "kms:Decrypt"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name_prefix = "${var.project_name}-${var.environment}-instance-profile-"
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
"""

    database_main = """resource "aws_security_group" "database" {
  count       = var.enable_postgres || var.enable_redis ? 1 : 0
  name_prefix = "database-"
  description = "Database access"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

  ingress {
    from_port   = 5432
    to_port     = 5432
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
  identifier                  = "postgres-${substr(md5(join(",", var.subnet_ids)), 0, 8)}"
  engine                      = "postgres"
  engine_version              = "15.5"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  db_subnet_group_name        = aws_db_subnet_group.postgres[0].name
  vpc_security_group_ids      = [aws_security_group.database[0].id]
  publicly_accessible         = false
  skip_final_snapshot         = true
  manage_master_user_password = true
  storage_encrypted           = true
  username                    = "appadmin"
  db_name                     = "appdb"
  tags                        = var.common_tags
}
"""

    database_variables = """variable "enable_postgres" { type = bool }
variable "enable_redis" { type = bool }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_cidrs" { type = list(string) }
variable "common_tags" { type = map(string) }
"""

    database_outputs = """output "rds_endpoint" { value = try(aws_db_instance.postgres[0].address, null) }
output "redis_endpoint" { value = null }
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

    compute_main = """locals {
  use_existing_key = trimspace(var.existing_ec2_key_pair_name) != ""
  ec2_key_name     = local.use_existing_key ? trimspace(var.existing_ec2_key_pair_name) : aws_key_pair.generated[0].key_name
}

resource "aws_security_group" "app" {
  count       = var.enabled ? 1 : 0
  name_prefix = "${var.project_name}-${var.environment}-app-"
  description = "Application traffic"
  vpc_id      = var.vpc_id
  tags        = var.common_tags

  ingress {
    from_port   = var.app_port
    to_port     = var.app_port
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
  count     = var.enabled && !local.use_existing_key ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enabled && !local.use_existing_key ? 1 : 0
  key_name   = "${var.project_name}-${var.environment}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
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
  tags                        = merge(var.common_tags, { Name = "${var.project_name}-${var.environment}-app" })

  metadata_options { http_tokens = "required" }

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 8
  }

  user_data = join("\\n", [
    "#!/bin/bash",
    "set -euxo pipefail",
    "dnf install -y nginx",
    "mkdir -p /usr/share/nginx/html",
    "cat <<'HTML' > /usr/share/nginx/html/index.html",
    "${base64decode(var.bootstrap_index_html_base64)}",
    "HTML",
    "systemctl enable nginx",
    "systemctl restart nginx"
  ])
}
"""

    compute_variables = """variable "enabled" { type = bool }
variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "ami_id" { type = string }
variable "instance_type" { type = string }
variable "app_port" { type = number }
variable "bootstrap_index_html_base64" {
  type      = string
  sensitive = true
}
variable "instance_profile_name" { type = string }
variable "existing_ec2_key_pair_name" { type = string }
variable "common_tags" { type = map(string) }
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
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
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
        "terraform/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "{environment}"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "{secrets_prefix}"\n',
        "terraform/envs/dev/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "dev"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/dev"\n',
        "terraform/envs/staging/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "staging"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/staging"\n',
        "terraform/envs/prod/terraform.tfvars": f'project_name = "{project_slug}"\nenvironment = "prod"\nregion = "{region}"\ncompute_strategy = "{strategy}"\nteam = "platform-engineering"\ncost_center = "engineering"\nsecrets_manager_prefix = "/{project_slug}/prod"\n',
        "terraform/backend-configs/dev.hcl": f'bucket = "{project_slug}-tfstate-dev"\nkey = "dev/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-dev"\nencrypt = true\n',
        "terraform/backend-configs/staging.hcl": f'bucket = "{project_slug}-tfstate-staging"\nkey = "staging/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-staging"\nencrypt = true\n',
        "terraform/backend-configs/prod.hcl": f'bucket = "{project_slug}-tfstate-prod"\nkey = "prod/terraform.tfstate"\nregion = "{region}"\ndynamodb_table = "{project_slug}-terraform-lock-prod"\nencrypt = true\n',
        "terraform/.terraform.lock.hcl": "# Reviewed lock-file placeholder. Refresh with terraform init in CI.\n",
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
    return files, warnings

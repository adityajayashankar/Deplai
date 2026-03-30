from __future__ import annotations

import re
from typing import Any


def generate_terraform(infra_plan: dict[str, Any]) -> dict[str, str]:
    services = infra_plan.get("services", ["api"])
    service_names = ", ".join(services)
    db_class = "db.t3.medium"

    files: dict[str, str] = {}
    files["terraform/providers.tf"] = '''terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
'''

    files["terraform/backend.tf"] = '''terraform {
  backend "s3" {
    bucket         = var.tf_state_bucket
    key            = "platform/terraform.tfstate"
    region         = var.aws_region
    dynamodb_table = var.tf_lock_table
    encrypt        = true
  }
}
'''

    files["terraform/variables.tf"] = '''variable "aws_region" {
  type        = string
  description = "AWS region for deployment"
}

variable "environment" {
  type        = string
  description = "Deployment environment name"
}

variable "tf_state_bucket" {
  type        = string
  description = "S3 bucket for remote terraform state"
}

variable "tf_lock_table" {
  type        = string
  description = "DynamoDB table for terraform state locking"
}

variable "vpc_cidr" {
  type        = string
  default     = "10.20.0.0/16"
}

variable "db_username" {
  type        = string
  description = "Database master username"
}

variable "db_password_ssm_parameter" {
  type        = string
  description = "SSM parameter name containing database password"
}
'''

    files["terraform/outputs.tf"] = '''output "vpc_id" {
  value = module.vpc.vpc_id
}

output "api_service_name" {
  value = module.compute.api_service_name
}

output "worker_service_name" {
  value = module.compute.worker_service_name
}

output "database_endpoint" {
  value = module.database.db_endpoint
}

output "redis_endpoint" {
  value = module.cache.redis_endpoint
}
'''

    files["terraform/main.tf"] = f'''# Services detected from repository: {service_names}
module "vpc" {{
  source      = "./modules/vpc"
  vpc_cidr    = var.vpc_cidr
  environment = var.environment
}}

module "database" {{
  source                    = "./modules/database"
  vpc_id                    = module.vpc.vpc_id
  private_subnet_ids        = module.vpc.private_subnet_ids
  db_username               = var.db_username
  db_password_ssm_parameter = var.db_password_ssm_parameter
  environment               = var.environment
}}

module "cache" {{
  source             = "./modules/cache"
  private_subnet_ids = module.vpc.private_subnet_ids
  vpc_id             = module.vpc.vpc_id
  environment        = var.environment
}}

module "compute" {{
  source             = "./modules/compute"
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  db_endpoint        = module.database.db_endpoint
  redis_endpoint     = module.cache.redis_endpoint
  environment        = var.environment
}}
'''

    files["terraform/modules/vpc/main.tf"] = '''resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.environment}-vpc"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 1)
  availability_zone = "${data.aws_region.current.name}a"
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 2)
  availability_zone = "${data.aws_region.current.name}b"
}

data "aws_region" "current" {}
'''

    files["terraform/modules/vpc/variables.tf"] = '''variable "vpc_cidr" {
  type = string
}

variable "environment" {
  type = string
}
'''

    files["terraform/modules/vpc/outputs.tf"] = '''output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}
'''

    files["terraform/modules/compute/main.tf"] = '''# Cost note: ECS Fargate service and NAT/data transfer can exceed ~$150/mo under steady load.
resource "aws_ecs_cluster" "this" {
  name = "${var.environment}-cluster"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  container_definitions    = jsonencode([])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  container_definitions    = jsonencode([])
}

resource "aws_ecs_service" "api" {
  name            = "${var.environment}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}

resource "aws_ecs_service" "worker" {
  name            = "${var.environment}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}
'''

    files["terraform/modules/compute/variables.tf"] = '''variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "db_endpoint" {
  type = string
}

variable "redis_endpoint" {
  type = string
}

variable "environment" {
  type = string
}
'''

    files["terraform/modules/compute/outputs.tf"] = '''output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}
'''

    files["terraform/modules/database/main.tf"] = f'''# Cost note: RDS {db_class} is typically around ~$180/mo with storage and backup in production.
resource "aws_db_subnet_group" "this" {{
  name       = "${{var.environment}}-db-subnet"
  subnet_ids = var.private_subnet_ids
}}

resource "aws_db_instance" "this" {{
  identifier             = "${{var.environment}}-postgres"
  engine                 = "postgres"
  instance_class         = "{db_class}"
  allocated_storage      = 50
  username               = var.db_username
  password               = data.aws_ssm_parameter.db_password.value
  db_subnet_group_name   = aws_db_subnet_group.this.name
  skip_final_snapshot    = true
  publicly_accessible    = false
}}

data "aws_ssm_parameter" "db_password" {{
  name            = var.db_password_ssm_parameter
  with_decryption = true
}}
'''

    files["terraform/modules/database/variables.tf"] = '''variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "db_username" {
  type = string
}

variable "db_password_ssm_parameter" {
  type = string
}

variable "environment" {
  type = string
}
'''

    files["terraform/modules/database/outputs.tf"] = '''output "db_endpoint" {
  value = aws_db_instance.this.address
}
'''

    files["terraform/modules/cache/main.tf"] = '''resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.environment}-redis-subnet"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_cluster" "this" {
  cluster_id           = "${var.environment}-redis"
  engine               = "redis"
  node_type            = "cache.t4g.small"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.this.name
}
'''

    files["terraform/modules/cache/variables.tf"] = '''variable "private_subnet_ids" {
  type = list(string)
}

variable "vpc_id" {
  type = string
}

variable "environment" {
  type = string
}
'''

    files["terraform/modules/cache/outputs.tf"] = '''output "redis_endpoint" {
  value = aws_elasticache_cluster.this.cache_nodes[0].address
}
'''

    files["terraform/environments/dev/main.tf"] = '''module "stack" {
  source                  = "../../"
  aws_region              = "us-east-1"
  environment             = "dev"
  tf_state_bucket         = "replace-dev-state-bucket"
  tf_lock_table           = "replace-dev-lock-table"
  vpc_cidr                = "10.30.0.0/16"
  db_username             = "app_admin"
  db_password_ssm_parameter = "/deplai/dev/db/password"
}
'''

    files["terraform/environments/prod/main.tf"] = '''module "stack" {
  source                  = "../../"
  aws_region              = "us-east-1"
  environment             = "prod"
  tf_state_bucket         = "replace-prod-state-bucket"
  tf_lock_table           = "replace-prod-lock-table"
  vpc_cidr                = "10.40.0.0/16"
  db_username             = "app_admin"
  db_password_ssm_parameter = "/deplai/prod/db/password"
}
'''

    return files


def validate_terraform(terraform_files: dict[str, str]) -> tuple[bool, list[str]]:
    errors: list[str] = []

    full_text = "\n".join(terraform_files.values())

    # 1. var references must be declared in terraform/variables.tf
    var_refs = set(re.findall(r"\bvar\.([A-Za-z0-9_]+)\b", full_text))
    var_decl_file = terraform_files.get("terraform/variables.tf", "")
    declared = set(re.findall(r'variable\s+"([A-Za-z0-9_]+)"', var_decl_file))
    missing = sorted(name for name in var_refs if name not in declared)
    if missing:
        errors.append(f"Missing variable declarations in terraform/variables.tf: {', '.join(missing)}")

    # 2. no 0.0.0.0/0 ingress
    if re.search(r"0\.0\.0\.0/0", full_text):
        errors.append("Security risk: found 0.0.0.0/0 in ingress-related configuration.")

    # 3. no plaintext password assignment
    if re.search(r'password\s*=\s*"[^$][^"]*"', full_text, flags=re.IGNORECASE):
        errors.append("Security risk: plaintext password detected. Use Secrets Manager or SSM Parameter Store.")

    # 4. backend.tf exists and has bucket + dynamodb_table
    backend = terraform_files.get("terraform/backend.tf")
    if not backend:
        errors.append("Missing terraform/backend.tf")
    else:
        if "bucket" not in backend or "dynamodb_table" not in backend:
            errors.append("terraform/backend.tf must include both bucket and dynamodb_table.")

    # 5. providers.tf has aws provider and required_version
    providers = terraform_files.get("terraform/providers.tf")
    if not providers:
        errors.append("Missing terraform/providers.tf")
    else:
        if "required_version" not in providers:
            errors.append("terraform/providers.tf must set required_version.")
        if "provider \"aws\"" not in providers:
            errors.append("terraform/providers.tf must declare provider \"aws\".")

    # 6. each module dir has main.tf, variables.tf, outputs.tf
    required_suffixes = {"main.tf", "variables.tf", "outputs.tf"}
    module_files = [p for p in terraform_files.keys() if p.startswith("terraform/modules/")]
    module_dirs = set()
    for path in module_files:
        parts = path.split("/")
        if len(parts) >= 4:
            module_dirs.add("/".join(parts[:3]))

    for module_dir in sorted(module_dirs):
        have = {p.split("/")[-1] for p in module_files if p.startswith(module_dir + "/")}
        miss = sorted(required_suffixes - have)
        if miss:
            errors.append(f"{module_dir} is missing: {', '.join(miss)}")

    return len(errors) == 0, errors

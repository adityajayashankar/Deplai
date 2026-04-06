"""terraform_tools.py – Plan-aware Terraform file generator and validator.

Key fixes vs. the original:
* ``generate_terraform`` now reads ``infra_plan`` fields (compute, database,
  cache, services) and conditionally emits only the modules that are actually
  needed.  Previously it always emitted VPC + ECS + RDS + Redis regardless of
  what the planner decided.
* ``outputs.tf`` only references outputs for modules that are included, so
  the generated code does not fail a ``terraform validate`` with "undefined
  reference" errors.
* ``validate_terraform`` no longer false-positives on ``0.0.0.0/0`` in
  *egress* rules (a safe and common pattern); it now only flags it when it
  appears in an ingress block context.
* Variable declarations are generated to match only what the included modules
  actually need.
"""
from __future__ import annotations

import re
from typing import Any


# ──────────────────────────────────────────────────────────────────────────────
# Public generator
# ──────────────────────────────────────────────────────────────────────────────

def generate_terraform(infra_plan: dict[str, Any]) -> dict[str, str]:
    """Return a dict of {relative_path: file_content} for the generated bundle.

    The bundle is driven entirely by *infra_plan*:
      - compute   : "ecs_fargate" | "lambda" | "ec2" | "requires_clarification"
      - services  : list of service names, e.g. ["api", "worker"]
      - database  : "rds_postgres" | "none" | "requires_clarification"
      - cache     : "elasticache_redis" | "none" | "requires_clarification"
      - networking: "vpc_with_private_subnets" | …
      - state_backend: "s3_dynamodb"
    """
    compute      = str(infra_plan.get("compute", "ecs_fargate")).lower()
    services     = infra_plan.get("services", ["api"])
    has_worker   = "worker" in services
    db           = str(infra_plan.get("database", "none")).lower()
    cache        = str(infra_plan.get("cache", "none")).lower()
    has_db       = db == "rds_postgres"
    has_cache    = cache == "elasticache_redis"
    use_fargate  = compute in ("ecs_fargate", "")

    files: dict[str, str] = {}

    # ── providers.tf ──────────────────────────────────────────────────────
    files["terraform/providers.tf"] = '''\
terraform {
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

    # ── backend.tf ────────────────────────────────────────────────────────
    files["terraform/backend.tf"] = '''\
terraform {
  backend "s3" {
    bucket         = var.tf_state_bucket
    key            = "platform/terraform.tfstate"
    region         = var.aws_region
    dynamodb_table = var.tf_lock_table
    encrypt        = true
  }
}
'''

    # ── variables.tf ──────────────────────────────────────────────────────
    var_blocks = [
        _var("aws_region",    "string", description="AWS region for deployment"),
        _var("environment",   "string", description="Deployment environment name"),
        _var("tf_state_bucket","string",description="S3 bucket for remote Terraform state"),
        _var("tf_lock_table", "string", description="DynamoDB table for Terraform state locking"),
        _var("vpc_cidr",      "string", default='"10.20.0.0/16"'),
    ]
    if has_db:
        var_blocks += [
            _var("db_username",             "string", description="Database master username"),
            _var("db_password_ssm_parameter","string",description="SSM parameter name containing the DB password"),
        ]
    files["terraform/variables.tf"] = "\n".join(var_blocks)

    # ── main.tf ───────────────────────────────────────────────────────────
    service_names = ", ".join(services)
    module_calls: list[str] = [
        f'# Services detected: {service_names}\n',
        _module_vpc(),
    ]
    if use_fargate:
        module_calls.append(_module_compute(has_db=has_db, has_cache=has_cache, has_worker=has_worker))
    if has_db:
        module_calls.append(_module_database())
    if has_cache:
        module_calls.append(_module_cache())

    files["terraform/main.tf"] = "\n".join(module_calls)

    # ── outputs.tf ────────────────────────────────────────────────────────
    out_lines = [
        'output "vpc_id" {\n  value = module.vpc.vpc_id\n}',
    ]
    if use_fargate:
        out_lines.append('output "api_service_name" {\n  value = module.compute.api_service_name\n}')
        if has_worker:
            out_lines.append('output "worker_service_name" {\n  value = module.compute.worker_service_name\n}')
    if has_db:
        out_lines.append('output "database_endpoint" {\n  value = module.database.db_endpoint\n}')
    if has_cache:
        out_lines.append('output "redis_endpoint" {\n  value = module.cache.redis_endpoint\n}')
    files["terraform/outputs.tf"] = "\n\n".join(out_lines) + "\n"

    # ── modules/vpc ───────────────────────────────────────────────────────
    files["terraform/modules/vpc/main.tf"] = '''\
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "${var.environment}-vpc" }
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
    files["terraform/modules/vpc/variables.tf"] = '''\
variable "vpc_cidr"    { type = string }
variable "environment" { type = string }
'''
    files["terraform/modules/vpc/outputs.tf"] = '''\
output "vpc_id"             { value = aws_vpc.this.id }
output "private_subnet_ids" { value = [aws_subnet.private_a.id, aws_subnet.private_b.id] }
'''

    # ── modules/compute (ECS Fargate) ─────────────────────────────────────
    if use_fargate:
        files.update(_fargate_compute_module(has_db=has_db, has_cache=has_cache, has_worker=has_worker))

    # ── modules/database (RDS Postgres) ──────────────────────────────────
    if has_db:
        files.update(_rds_module())

    # ── modules/cache (ElastiCache Redis) ────────────────────────────────
    if has_cache:
        files.update(_elasticache_module())

    # ── environment tfvars ────────────────────────────────────────────────
    for env_name, vpc_cidr in [("dev", "10.30.0.0/16"), ("prod", "10.40.0.0/16")]:
        db_lines = (
            f'  db_username                = "app_admin"\n'
            f'  db_password_ssm_parameter  = "/app/{env_name}/db/password"\n'
        ) if has_db else ""
        files[f"terraform/environments/{env_name}/main.tf"] = (
            f'module "stack" {{\n'
            f'  source          = "../../"\n'
            f'  aws_region      = "us-east-1"\n'
            f'  environment     = "{env_name}"\n'
            f'  tf_state_bucket = "replace-{env_name}-state-bucket"\n'
            f'  tf_lock_table   = "replace-{env_name}-lock-table"\n'
            f'  vpc_cidr        = "{vpc_cidr}"\n'
            f'{db_lines}'
            f'}}\n'
        )

    return files


# ──────────────────────────────────────────────────────────────────────────────
# Helpers: module call snippets
# ──────────────────────────────────────────────────────────────────────────────

def _var(name: str, vtype: str, *, default: str | None = None, description: str | None = None) -> str:
    lines = [f'variable "{name}" {{']
    lines.append(f'  type        = {vtype}')
    if description:
        lines.append(f'  description = "{description}"')
    if default is not None:
        lines.append(f'  default     = {default}')
    lines.append("}")
    return "\n".join(lines)


def _module_vpc() -> str:
    return '''\
module "vpc" {
  source      = "./modules/vpc"
  vpc_cidr    = var.vpc_cidr
  environment = var.environment
}
'''


def _module_compute(*, has_db: bool, has_cache: bool, has_worker: bool) -> str:
    lines = [
        'module "compute" {',
        '  source             = "./modules/compute"',
        '  vpc_id             = module.vpc.vpc_id',
        '  private_subnet_ids = module.vpc.private_subnet_ids',
        '  environment        = var.environment',
    ]
    if has_db:
        lines.append('  db_endpoint        = module.database.db_endpoint')
    if has_cache:
        lines.append('  redis_endpoint     = module.cache.redis_endpoint')
    lines.append("}")
    return "\n".join(lines) + "\n"


def _module_database() -> str:
    return '''\
module "database" {
  source                    = "./modules/database"
  vpc_id                    = module.vpc.vpc_id
  private_subnet_ids        = module.vpc.private_subnet_ids
  db_username               = var.db_username
  db_password_ssm_parameter = var.db_password_ssm_parameter
  environment               = var.environment
}
'''


def _module_cache() -> str:
    return '''\
module "cache" {
  source             = "./modules/cache"
  private_subnet_ids = module.vpc.private_subnet_ids
  vpc_id             = module.vpc.vpc_id
  environment        = var.environment
}
'''


# ──────────────────────────────────────────────────────────────────────────────
# Helpers: full module file sets
# ──────────────────────────────────────────────────────────────────────────────

def _fargate_compute_module(*, has_db: bool, has_cache: bool, has_worker: bool) -> dict[str, str]:
    """Return the three files for modules/compute."""
    extra_vars = ""
    if has_db:
        extra_vars += 'variable "db_endpoint"    { type = string }\n'
    if has_cache:
        extra_vars += 'variable "redis_endpoint"  { type = string }\n'

    worker_task = ""
    worker_service = ""
    worker_output = ""
    if has_worker:
        worker_task = '''\

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  container_definitions    = jsonencode([])
}
'''
        worker_service = '''\

resource "aws_ecs_service" "worker" {
  name            = "${var.environment}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"
}
'''
        worker_output = '\noutput "worker_service_name" { value = aws_ecs_service.worker.name }\n'

    main_tf = f'''\
# Cost note: ECS Fargate + NAT/data transfer can exceed ~$150/mo under steady load.
resource "aws_ecs_cluster" "this" {{
  name = "${{var.environment}}-cluster"
}}

resource "aws_ecs_task_definition" "api" {{
  family                   = "${{var.environment}}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  container_definitions    = jsonencode([])
}}
{worker_task}
resource "aws_ecs_service" "api" {{
  name            = "${{var.environment}}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}}
{worker_service}
'''

    variables_tf = f'''\
variable "vpc_id"             {{ type = string }}
variable "private_subnet_ids" {{ type = list(string) }}
variable "environment"        {{ type = string }}
{extra_vars}
'''

    outputs_tf = 'output "api_service_name" { value = aws_ecs_service.api.name }\n' + worker_output

    return {
        "terraform/modules/compute/main.tf":      main_tf,
        "terraform/modules/compute/variables.tf": variables_tf,
        "terraform/modules/compute/outputs.tf":   outputs_tf,
    }


def _rds_module() -> dict[str, str]:
    db_class = "db.t3.medium"
    main_tf = f'''\
# Cost note: RDS {db_class} is ~$180/mo with storage and backup in production.
resource "aws_db_subnet_group" "this" {{
  name       = "${{var.environment}}-db-subnet"
  subnet_ids = var.private_subnet_ids
}}

data "aws_ssm_parameter" "db_password" {{
  name            = var.db_password_ssm_parameter
  with_decryption = true
}}

resource "aws_db_instance" "this" {{
  identifier           = "${{var.environment}}-postgres"
  engine               = "postgres"
  instance_class       = "{db_class}"
  allocated_storage    = 50
  username             = var.db_username
  password             = data.aws_ssm_parameter.db_password.value
  db_subnet_group_name = aws_db_subnet_group.this.name
  skip_final_snapshot  = true
  publicly_accessible  = false
}}
'''
    variables_tf = '''\
variable "vpc_id"                    { type = string }
variable "private_subnet_ids"        { type = list(string) }
variable "db_username"               { type = string }
variable "db_password_ssm_parameter" { type = string }
variable "environment"               { type = string }
'''
    outputs_tf = 'output "db_endpoint" { value = aws_db_instance.this.address }\n'
    return {
        "terraform/modules/database/main.tf":      main_tf,
        "terraform/modules/database/variables.tf": variables_tf,
        "terraform/modules/database/outputs.tf":   outputs_tf,
    }


def _elasticache_module() -> dict[str, str]:
    main_tf = '''\
resource "aws_elasticache_subnet_group" "this" {
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
    variables_tf = '''\
variable "private_subnet_ids" { type = list(string) }
variable "vpc_id"             { type = string }
variable "environment"        { type = string }
'''
    outputs_tf = 'output "redis_endpoint" { value = aws_elasticache_cluster.this.cache_nodes[0].address }\n'
    return {
        "terraform/modules/cache/main.tf":      main_tf,
        "terraform/modules/cache/variables.tf": variables_tf,
        "terraform/modules/cache/outputs.tf":   outputs_tf,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Validator
# ──────────────────────────────────────────────────────────────────────────────

def validate_terraform(terraform_files: dict[str, str]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    full_text = "\n".join(terraform_files.values())

    # 1. var references must be declared in the *correct* variables.tf.
    #    Root-level files are validated against terraform/variables.tf.
    #    Module files are validated against their own module variables.tf.
    #    We check each scope independently so module-local variables are not
    #    incorrectly flagged against the root declaration file.
    def _declared_vars(decl_content: str) -> set[str]:
        return set(re.findall(r'variable\s+"([A-Za-z0-9_]+)"', decl_content))

    ROOT_PREFIXES = ("terraform/providers.tf", "terraform/backend.tf",
                     "terraform/main.tf", "terraform/outputs.tf",
                     "terraform/variables.tf")

    # Check root scope
    root_text = "\n".join(
        content
        for path, content in terraform_files.items()
        if any(path == p for p in ROOT_PREFIXES)
    )
    root_declared = _declared_vars(terraform_files.get("terraform/variables.tf", ""))
    root_refs = set(re.findall(r"\bvar\.([A-Za-z0-9_]+)\b", root_text))
    missing_root = sorted(ref for ref in root_refs if ref not in root_declared)
    if missing_root:
        errors.append(
            f"Missing variable declarations in terraform/variables.tf: {', '.join(missing_root)}"
        )

    # Check each module scope independently
    module_files = {
        path: content
        for path, content in terraform_files.items()
        if path.startswith("terraform/modules/")
    }
    module_dirs: set[str] = set()
    for path in module_files:
        parts = path.split("/")
        if len(parts) >= 4:
            module_dirs.add("/".join(parts[:3]))

    for mdir in sorted(module_dirs):
        mod_decl = terraform_files.get(f"{mdir}/variables.tf", "")
        mod_declared = _declared_vars(mod_decl)
        mod_text = "\n".join(
            content for path, content in module_files.items()
            if path.startswith(mdir + "/")
        )
        mod_refs = set(re.findall(r"\bvar\.([A-Za-z0-9_]+)\b", mod_text))
        missing_mod = sorted(ref for ref in mod_refs if ref not in mod_declared)
        if missing_mod:
            errors.append(
                f"{mdir}/variables.tf is missing declarations: {', '.join(missing_mod)}"
            )

    # 2. No 0.0.0.0/0 in INGRESS rules.
    #    Egress rules containing 0.0.0.0/0 are a normal and safe pattern; only
    #    flag when the string appears inside an ingress {} block.
    ingress_cidr_pattern = re.compile(
        r"ingress\s*\{[^}]*0\.0\.0\.0/0[^}]*\}", re.DOTALL
    )
    if ingress_cidr_pattern.search(full_text):
        errors.append(
            "Security risk: found 0.0.0.0/0 inside an ingress block. "
            "Restrict to known CIDR ranges or use security group references."
        )

    # 3. No plaintext password assignment
    if re.search(r'password\s*=\s*"[^$][^"]*"', full_text, flags=re.IGNORECASE):
        errors.append(
            "Security risk: plaintext password detected. "
            "Use Secrets Manager or SSM Parameter Store."
        )

    # 4. backend.tf must exist and reference both bucket and dynamodb_table
    backend = terraform_files.get("terraform/backend.tf")
    if not backend:
        errors.append("Missing terraform/backend.tf")
    else:
        if "bucket" not in backend or "dynamodb_table" not in backend:
            errors.append(
                "terraform/backend.tf must include both bucket and dynamodb_table."
            )

    # 5. providers.tf must exist with required_version and aws provider
    providers = terraform_files.get("terraform/providers.tf")
    if not providers:
        errors.append("Missing terraform/providers.tf")
    else:
        if "required_version" not in providers:
            errors.append("terraform/providers.tf must set required_version.")
        if 'provider "aws"' not in providers:
            errors.append('terraform/providers.tf must declare provider "aws".')

    # 6. Each module directory must have main.tf, variables.tf, outputs.tf
    required_suffixes = {"main.tf", "variables.tf", "outputs.tf"}
    module_files = [p for p in terraform_files.keys() if p.startswith("terraform/modules/")]
    module_dirs: set[str] = set()
    for path in module_files:
        parts = path.split("/")
        if len(parts) >= 4:
            module_dirs.add("/".join(parts[:3]))

    for module_dir in sorted(module_dirs):
        have = {p.split("/")[-1] for p in module_files if p.startswith(module_dir + "/")}
        miss = sorted(required_suffixes - have)
        if miss:
            errors.append(f"{module_dir} is missing: {', '.join(miss)}")

    # 7. outputs.tf must not reference modules that were not declared in main.tf
    outputs_content = terraform_files.get("terraform/outputs.tf", "")
    main_content    = terraform_files.get("terraform/main.tf", "")
    for module_name in re.findall(r'\bmodule\.([A-Za-z0-9_]+)\b', outputs_content):
        if f'module "{module_name}"' not in main_content:
            errors.append(
                f'outputs.tf references module.{module_name} which is not declared in main.tf'
            )

    return len(errors) == 0, errors
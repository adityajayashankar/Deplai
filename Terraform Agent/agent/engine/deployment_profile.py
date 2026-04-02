from __future__ import annotations

import json
from typing import Any

from .bundle import build_manifest_bundle
from .runtime import DEFAULT_PROVIDER_CONSTRAINT, slugify


def is_deployment_profile_payload(payload: dict[str, Any] | None) -> bool:
    return isinstance(payload, dict) and str(payload.get("document_kind") or "").strip().lower() == "deployment_profile"


def validate_deployment_profile_payload(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not is_deployment_profile_payload(payload):
        return ["document_kind must be deployment_profile"]
    if not str(payload.get("workspace") or "").strip():
        errors.append("workspace is required")
    if not str(payload.get("project_name") or "").strip():
        errors.append("project_name is required")
    compute = payload.get("compute")
    if not isinstance(compute, dict):
        errors.append("compute is required")
    else:
        if not str(compute.get("strategy") or "").strip():
            errors.append("compute.strategy is required")
        if not isinstance(compute.get("services") or [], list):
            errors.append("compute.services must be an array")
    networking = payload.get("networking")
    if not isinstance(networking, dict):
        errors.append("networking is required")
    return errors


def build_profile_manifest(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
    services = compute.get("services") if isinstance(compute.get("services"), list) else []
    strategy = str(compute.get("strategy") or "")
    manifest: list[dict[str, Any]] = []

    if strategy == "s3_cloudfront":
        manifest.extend(
            [
                {"id": "website_bucket", "type": "aws_s3_bucket", "strategy": "hcl", "dependencies": [], "config": {}, "doc_url": None, "knowledge_key": None},
                {"id": "cdn", "type": "aws_cloudfront_distribution", "strategy": "hcl", "dependencies": ["website_bucket"], "config": {}, "doc_url": None, "knowledge_key": None},
            ]
        )
        return manifest, ["website_bucket", "cdn"]

    if strategy == "ecs_fargate":
        manifest.append({"id": "ecs_cluster", "type": "aws_ecs_cluster", "strategy": "hcl", "dependencies": [], "config": {}, "doc_url": None, "knowledge_key": None})
        if isinstance(payload.get("networking"), dict) and (payload["networking"].get("load_balancer") or {}):
            manifest.append({"id": "alb", "type": "aws_lb", "strategy": "hcl", "dependencies": [], "config": {}, "doc_url": None, "knowledge_key": None})
        for service in services:
            if not isinstance(service, dict):
                continue
            service_id = str(service.get("id") or "service")
            deps = ["ecs_cluster"]
            if str(service.get("process_type") or "") == "web":
                deps.append("alb")
            manifest.append({"id": service_id, "type": "aws_ecs_service", "strategy": "hcl", "dependencies": [dep for dep in deps if dep], "config": service, "doc_url": None, "knowledge_key": None})
    for item in payload.get("data_layer") or []:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or item.get("type") or "data")
        if item.get("type") == "postgresql":
            manifest.append({"id": item_id, "type": "aws_db_instance", "strategy": "hcl", "dependencies": [], "config": item, "doc_url": None, "knowledge_key": None})
        elif item.get("type") == "redis":
            manifest.append({"id": item_id, "type": "aws_elasticache_cluster", "strategy": "hcl", "dependencies": [], "config": item, "doc_url": None, "knowledge_key": None})
    dag_order = [component["id"] for component in manifest]
    return manifest, dag_order


def _tf_backend(provider_version: str, state_bucket: str, lock_table: str, workspace: str, aws_region: str) -> tuple[str, str]:
    provider_expr = provider_version or DEFAULT_PROVIDER_CONSTRAINT
    if provider_expr and provider_expr[0].isdigit():
        provider_expr = f"={provider_expr}"
    providers_tf = f"""terraform {{
  required_version = ">= 1.5.0"
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "{provider_expr}"
    }}
  }}
}}

provider "aws" {{
  region = var.aws_region
}}
"""
    backend_tf = ""
    if str(state_bucket or "").strip() and str(lock_table or "").strip():
        backend_tf = f"""terraform {{
  backend "s3" {{
    bucket         = "{state_bucket}"
    key            = "{workspace}/terraform.tfstate"
    region         = "{aws_region}"
    dynamodb_table = "{lock_table}"
    encrypt        = true
  }}
}}
"""
    return providers_tf, backend_tf


def _json_default(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def _static_site_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
) -> tuple[dict[str, str], list[str]]:
    project_name = str(payload.get("project_name") or "deplai-project")
    workspace = str(payload.get("workspace") or slugify(project_name))
    project_slug = slugify(project_name, "deplai-project")[:40]
    providers_tf, backend_tf = _tf_backend(provider_version, state_bucket, lock_table, workspace, aws_region)
    variables_tf = f"""variable "project_name" {{
  type    = string
  default = "{project_slug}"
}}

variable "aws_region" {{
  type    = string
  default = "{aws_region}"
}}

variable "bootstrap_index_html" {{
  type      = string
  default   = {json.dumps(website_index_html)}
  sensitive = true
}}
"""
    main_tf = """resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "website" {
  bucket        = "${var.project_name}-site-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "website" {
  bucket = aws_s3_bucket.website.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.website.id
  key          = "index.html"
  content      = var.bootstrap_index_html
  content_type = "text/html"
  depends_on   = [aws_s3_bucket_ownership_controls.website, aws_s3_bucket_public_access_block.website]
}

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${var.project_name}-oac-${random_id.bucket_suffix.hex}"
  description                       = "OAC for static site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "website" {
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "site-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  default_cache_behavior {
    target_origin_id       = "site-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action = ["s3:GetObject"]
      Resource = ["${aws_s3_bucket.website.arn}/*"]
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.website.arn }
      }
    }]
  })
}
"""
    outputs_tf = """output "cloudfront_url" { value = "https://${aws_cloudfront_distribution.website.domain_name}" }
output "website_bucket_name" { value = aws_s3_bucket.website.id }
output "alb_dns_name" { value = null }
output "rds_endpoint" { value = null }
output "redis_endpoint" { value = null }
"""
    files = {
        "terraform/providers.tf": providers_tf,
        "terraform/main.tf": main_tf,
        "terraform/variables.tf": variables_tf,
        "terraform/terraform.tfvars": f'project_name = "{project_slug}"\naws_region = "{aws_region}"\n',
        "terraform/outputs.tf": outputs_tf,
        "README.md": f"# IaC Bundle - {project_name}\n\nGenerated from deployment_profile.\n\n{context_summary}\n",
    }
    if backend_tf:
        files["terraform/backend.tf"] = backend_tf
    return files, []


def _ecs_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
) -> tuple[dict[str, str], list[str]]:
    project_name = str(payload.get("project_name") or "deplai-project")
    workspace = str(payload.get("workspace") or slugify(project_name))
    project_slug = slugify(project_name, "deplai-project")[:40]
    providers_tf, backend_tf = _tf_backend(provider_version, state_bucket, lock_table, workspace, aws_region)
    compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
    services = [service for service in compute.get("services") or [] if isinstance(service, dict)]
    networking = payload.get("networking") if isinstance(payload.get("networking"), dict) else {}
    data_layer = [item for item in payload.get("data_layer") or [] if isinstance(item, dict)]
    runtime_config = payload.get("runtime_config") if isinstance(payload.get("runtime_config"), dict) else {}
    build_pipeline = payload.get("build_pipeline") if isinstance(payload.get("build_pipeline"), dict) else {}

    app_service = next((service for service in services if str(service.get("process_type") or "") == "web"), services[0] if services else {})
    worker_service = next((service for service in services if str(service.get("process_type") or "") == "worker"), None)
    app_port = int(app_service.get("port") or 3000)
    app_cpu = int(app_service.get("cpu") or 512)
    app_memory = int(app_service.get("memory") or 1024)
    worker_cpu = int((worker_service or {}).get("cpu") or 256)
    worker_memory = int((worker_service or {}).get("memory") or 512)
    app_desired = int(app_service.get("desired_count") or 1)
    worker_desired = int((worker_service or {}).get("desired_count") or 1)
    alb_public = bool(((networking.get("load_balancer") or {}) if isinstance(networking.get("load_balancer"), dict) else {}).get("public", True))
    use_existing_vpc = str(networking.get("vpc") or "new") == "existing"
    create_nat = bool(networking.get("nat_gateway"))

    postgres = next((item for item in data_layer if item.get("type") == "postgresql"), None)
    redis = next((item for item in data_layer if item.get("type") == "redis"), None)
    ecr_repo = str(build_pipeline.get("ecr_repository") or project_slug)
    secrets_prefix = str(runtime_config.get("secrets_manager_prefix") or f"/{project_slug}/production")
    log_group = str(((payload.get("operational") or {}) if isinstance(payload.get("operational"), dict) else {}).get("log_group") or f"/deplai/{project_slug}")
    log_retention = int((((payload.get("operational") or {}) if isinstance(payload.get("operational"), dict) else {}).get("log_retention_days") or 30))
    required_secrets = [str(item) for item in runtime_config.get("required_secrets") or []]

    variables_tf = f"""variable "project_name" {{
  type    = string
  default = "{project_slug}"
}}

variable "aws_region" {{
  type    = string
  default = "{aws_region}"
}}

variable "use_existing_vpc" {{
  type    = bool
  default = {str(use_existing_vpc).lower()}
}}

variable "create_nat_gateway" {{
  type    = bool
  default = {str(create_nat).lower()}
}}

variable "app_image" {{
  type    = string
  default = "public.ecr.aws/docker/library/nginx:stable"
}}

variable "worker_image" {{
  type    = string
  default = "public.ecr.aws/docker/library/busybox:stable"
}}

variable "app_port" {{
  type    = number
  default = {app_port}
}}
"""

    locals_block = f"""locals {{
  tags = {{
    Project   = var.project_name
    ManagedBy = "deplai"
  }}
  required_secret_names = {json.dumps([f"{secrets_prefix}/{item}" for item in required_secrets])}
}}
"""

    networking_tf = f"""
data "aws_availability_zones" "available" {{
  state = "available"
}}

data "aws_vpc" "default" {{
  count   = var.use_existing_vpc ? 1 : 0
  default = true
}}

data "aws_subnets" "default" {{
  count = var.use_existing_vpc ? 1 : 0
  filter {{
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }}
}}

resource "aws_vpc" "main" {{
  count                = var.use_existing_vpc ? 0 : 1
  cidr_block           = "10.60.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, {{ Name = "${{var.project_name}}-vpc" }})
}}

resource "aws_internet_gateway" "main" {{
  count  = var.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, {{ Name = "${{var.project_name}}-igw" }})
}}

resource "aws_subnet" "public_a" {{
  count                   = var.use_existing_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = "10.60.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, {{ Name = "${{var.project_name}}-public-a" }})
}}

resource "aws_subnet" "public_b" {{
  count                   = var.use_existing_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = "10.60.2.0/24"
  availability_zone       = data.aws_availability_zones.available.names[length(data.aws_availability_zones.available.names) > 1 ? 1 : 0]
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, {{ Name = "${{var.project_name}}-public-b" }})
}}

resource "aws_subnet" "private_a" {{
  count             = var.use_existing_vpc ? 0 : 1
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = "10.60.11.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = merge(local.tags, {{ Name = "${{var.project_name}}-private-a" }})
}}

resource "aws_subnet" "private_b" {{
  count             = var.use_existing_vpc ? 0 : 1
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = "10.60.12.0/24"
  availability_zone = data.aws_availability_zones.available.names[length(data.aws_availability_zones.available.names) > 1 ? 1 : 0]
  tags              = merge(local.tags, {{ Name = "${{var.project_name}}-private-b" }})
}}

resource "aws_route_table" "public" {{
  count  = var.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, {{ Name = "${{var.project_name}}-public-rt" }})
}}

resource "aws_route" "public_internet" {{
  count                  = var.use_existing_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}}

resource "aws_route_table_association" "public_a" {{
  count          = var.use_existing_vpc ? 0 : 1
  subnet_id      = aws_subnet.public_a[0].id
  route_table_id = aws_route_table.public[0].id
}}

resource "aws_route_table_association" "public_b" {{
  count          = var.use_existing_vpc ? 0 : 1
  subnet_id      = aws_subnet.public_b[0].id
  route_table_id = aws_route_table.public[0].id
}}

resource "aws_eip" "nat" {{
  count  = var.use_existing_vpc || !var.create_nat_gateway ? 0 : 1
  domain = "vpc"
}}

resource "aws_nat_gateway" "main" {{
  count         = var.use_existing_vpc || !var.create_nat_gateway ? 0 : 1
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public_a[0].id
  tags          = merge(local.tags, {{ Name = "${{var.project_name}}-nat" }})
}}

resource "aws_route_table" "private" {{
  count  = var.use_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, {{ Name = "${{var.project_name}}-private-rt" }})
}}

resource "aws_route" "private_nat" {{
  count                  = var.use_existing_vpc || !var.create_nat_gateway ? 0 : 1
  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}}

resource "aws_route_table_association" "private_a" {{
  count          = var.use_existing_vpc ? 0 : 1
  subnet_id      = aws_subnet.private_a[0].id
  route_table_id = var.create_nat_gateway ? aws_route_table.private[0].id : aws_route_table.public[0].id
}}

resource "aws_route_table_association" "private_b" {{
  count          = var.use_existing_vpc ? 0 : 1
  subnet_id      = aws_subnet.private_b[0].id
  route_table_id = var.create_nat_gateway ? aws_route_table.private[0].id : aws_route_table.public[0].id
}}

locals {{
  vpc_id = var.use_existing_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  public_subnet_ids = var.use_existing_vpc ? slice(data.aws_subnets.default[0].ids, 0, min(2, length(data.aws_subnets.default[0].ids))) : [aws_subnet.public_a[0].id, aws_subnet.public_b[0].id]
  private_subnet_ids = var.use_existing_vpc ? local.public_subnet_ids : [aws_subnet.private_a[0].id, aws_subnet.private_b[0].id]
}}

resource "aws_security_group" "alb" {{
  name_prefix = "${{var.project_name}}-alb-"
  vpc_id      = local.vpc_id

  ingress {{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = {json.dumps(["0.0.0.0/0"] if alb_public else ["10.0.0.0/8"])}
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "aws_security_group" "app" {{
  name_prefix = "${{var.project_name}}-app-"
  vpc_id      = local.vpc_id

  ingress {{
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}
"""

    rds_tf = ""
    if postgres:
        rds_class = str(postgres.get("instance_class") or "db.t3.small")
        rds_version = str(postgres.get("engine_version") or "15.4")
        rds_storage = int(postgres.get("storage_gb") or 20)
        rds_backup = int(postgres.get("backup_retention_days") or 7)
        rds_multi_az = str(bool(postgres.get("multi_az"))).lower()
        rds_tf = f"""
resource "aws_security_group" "db" {{
  name_prefix = "${{var.project_name}}-db-"
  vpc_id      = local.vpc_id

  ingress {{
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "aws_db_subnet_group" "main" {{
  name       = "${{var.project_name}}-db-subnets"
  subnet_ids = local.private_subnet_ids
}}

resource "aws_db_instance" "main" {{
  identifier              = "${{var.project_name}}-postgres"
  engine                  = "postgres"
  engine_version          = "{rds_version}"
  instance_class          = "{rds_class}"
  allocated_storage       = {rds_storage}
  storage_type            = "gp3"
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  username                = "deplai"
  password                = "ChangeMe123!"
  skip_final_snapshot     = true
  publicly_accessible     = false
  backup_retention_period = {rds_backup}
  multi_az                = {rds_multi_az}
}}
"""

    redis_tf = ""
    if redis:
        redis_node_type = str(redis.get("node_type") or "cache.t3.small")
        redis_tf = f"""
resource "aws_security_group" "cache" {{
  name_prefix = "${{var.project_name}}-cache-"
  vpc_id      = local.vpc_id

  ingress {{
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "aws_elasticache_subnet_group" "main" {{
  name       = "${{var.project_name}}-cache-subnets"
  subnet_ids = local.private_subnet_ids
}}

resource "aws_elasticache_cluster" "main" {{
  cluster_id           = "${{var.project_name}}-redis"
  engine               = "redis"
  node_type            = "{redis_node_type}"
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.cache.id]
}}
"""

    worker_task = ""
    worker_service_tf = ""
    if worker_service:
        worker_task = f"""
resource "aws_ecs_task_definition" "worker" {{
  family                   = "${{var.project_name}}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "{worker_cpu}"
  memory                   = "{worker_memory}"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{{
    name      = "worker"
    image     = var.worker_image
    essential = true
    command   = ["sh", "-c", "sleep 3600"]
    logConfiguration = {{
      logDriver = "awslogs"
      options = {{
        awslogs-group         = aws_cloudwatch_log_group.ecs.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }}
    }}
  }}])
}}
"""
        worker_service_tf = f"""
resource "aws_ecs_service" "worker" {{
  name            = "${{var.project_name}}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  launch_type     = "FARGATE"
  desired_count   = {worker_desired}

  network_configuration {{
    assign_public_ip = true
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
  }}
}}
"""

    secrets_data = ""
    if required_secrets:
        secrets_data = """
data "aws_secretsmanager_secret" "runtime" {
  for_each = toset(local.required_secret_names)
  name     = each.value
}
"""

    main_tf = f"""{locals_block}
{networking_tf}
{rds_tf}
{redis_tf}
resource "aws_lb" "main" {{
  name               = substr("${{var.project_name}}-alb", 0, 32)
  internal           = {str(not alb_public).lower()}
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.public_subnet_ids
}}

resource "aws_lb_target_group" "app" {{
  name_prefix = "tg-"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id

  health_check {{
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }}
}}

resource "aws_lb_listener" "http" {{
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {{
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }}
}}

resource "aws_ecs_cluster" "main" {{
  name = "${{var.project_name}}-cluster"
}}

resource "aws_cloudwatch_log_group" "ecs" {{
  name              = "{log_group}"
  retention_in_days = {log_retention}
}}

resource "aws_iam_role" "ecs_execution" {{
  name_prefix = "${{var.project_name}}-ecs-exec-"
  assume_role_policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect = "Allow"
      Principal = {{ Service = "ecs-tasks.amazonaws.com" }}
      Action = "sts:AssumeRole"
    }}]
  }})
}}

resource "aws_iam_role_policy_attachment" "ecs_execution" {{
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}}

resource "aws_iam_role" "ecs_task" {{
  name_prefix = "${{var.project_name}}-ecs-task-"
  assume_role_policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect = "Allow"
      Principal = {{ Service = "ecs-tasks.amazonaws.com" }}
      Action = "sts:AssumeRole"
    }}]
  }})
}}

resource "aws_iam_role_policy" "ecs_task_secrets" {{
  name_prefix = "${{var.project_name}}-secrets-"
  role        = aws_iam_role.ecs_task.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = "*"
    }}]
  }})
}}

resource "aws_ecr_repository" "app" {{
  name                 = "{ecr_repo}"
  image_tag_mutability = "MUTABLE"
}}

{secrets_data}
resource "aws_ecs_task_definition" "app" {{
  family                   = "${{var.project_name}}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "{app_cpu}"
  memory                   = "{app_memory}"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{{
    name      = "app"
    image     = var.app_image
    essential = true
    portMappings = [{{
      containerPort = var.app_port
      hostPort      = var.app_port
      protocol      = "tcp"
    }}]
    logConfiguration = {{
      logDriver = "awslogs"
      options = {{
        awslogs-group         = aws_cloudwatch_log_group.ecs.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "app"
      }}
    }}
  }}])
}}

resource "aws_ecs_service" "app" {{
  name            = "${{var.project_name}}-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"
  desired_count   = {app_desired}

  network_configuration {{
    assign_public_ip = true
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
  }}

  load_balancer {{
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.app_port
  }}

  depends_on = [aws_lb_listener.http]
}}

{worker_task}
{worker_service_tf}
"""

    outputs_tf = """output "cloudfront_url" { value = null }
output "alb_dns_name" { value = aws_lb.main.dns_name }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_name" { value = aws_ecs_service.app.name }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "rds_endpoint" { value = try(aws_db_instance.main.address, null) }
output "redis_endpoint" { value = try(aws_elasticache_cluster.main.cache_nodes[0].address, null) }
output "website_bucket_name" { value = null }
"""
    tfvars = f'project_name = "{project_slug}"\naws_region = "{aws_region}"\n'
    files = {
        "terraform/providers.tf": providers_tf,
        "terraform/main.tf": main_tf,
        "terraform/variables.tf": variables_tf,
        "terraform/terraform.tfvars": tfvars,
        "terraform/outputs.tf": outputs_tf,
        "README.md": f"# IaC Bundle - {project_name}\n\nGenerated from deployment_profile.\n\n{context_summary}\n",
    }
    if backend_tf:
        files["terraform/backend.tf"] = backend_tf
    warnings: list[str] = [
        "Terraform ECS bundle uses placeholder public container images by default. Replace app_image/worker_image before production rollout."
    ]
    return files, warnings


def build_profile_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
) -> tuple[dict[str, str], list[str]]:
    strategy = str(((payload.get("compute") or {}) if isinstance(payload.get("compute"), dict) else {}).get("strategy") or "")
    if strategy == "s3_cloudfront":
        return _static_site_bundle(
            payload=payload,
            provider_version=provider_version,
            state_bucket=state_bucket,
            lock_table=lock_table,
            aws_region=aws_region,
            context_summary=context_summary,
            website_index_html=website_index_html,
        )
    if strategy == "ecs_fargate":
        return _ecs_bundle(
            payload=payload,
            provider_version=provider_version,
            state_bucket=state_bucket,
            lock_table=lock_table,
            aws_region=aws_region,
            context_summary=context_summary,
        )
    files, warnings = build_manifest_bundle(
        project_name=str(payload.get("project_name") or "deplai-project"),
        workspace=str(payload.get("workspace") or slugify(str(payload.get("project_name") or "deplai-project"))),
        provider_version=provider_version,
        state_bucket=state_bucket,
        lock_table=lock_table,
        aws_region=aws_region,
        context_summary=context_summary,
        website_index_html=website_index_html,
        manifest=[],
    )
    warnings.insert(0, "Deployment profile requested an unsupported compute strategy for deterministic bundling; falling back to the legacy EC2-oriented bundle.")
    return files, warnings

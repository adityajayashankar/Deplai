from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from typing import Any

from .runtime import DEFAULT_PROVIDER_CONSTRAINT, slugify


SUPPORTED_TEMPLATE_TYPES = {
    "aws_cloudfront_distribution",
    "aws_cloudfront_origin_access_control",
    "aws_s3_bucket",
    "aws_instance",
    "aws_vpc",
    "aws_subnet",
    "aws_security_group",
    "aws_db_instance",
    "aws_dynamodb_table",
    "aws_resource",
}

FALLBACK_RESOURCE_SET = [
    "aws_vpc",
    "aws_subnet",
    "aws_security_group",
    "aws_instance",
    "aws_s3_bucket",
    "aws_cloudfront_origin_access_control",
    "aws_cloudfront_distribution",
]


def decide_component_strategy(component: dict[str, Any], knowledge: dict[str, Any]) -> str:
    candidates = knowledge.get("module_candidates") if isinstance(knowledge, dict) else []
    if not isinstance(candidates, list):
        component["strategy"] = "hcl"
        return "hcl"

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        downloads = int(candidate.get("downloads") or 0)
        published_at_raw = str(candidate.get("published_at") or "").strip()
        subresource_count = int(candidate.get("subresource_count") or 0)
        recent = False
        if published_at_raw:
            try:
                published_at = datetime.fromisoformat(published_at_raw.replace("Z", "+00:00"))
                recent = datetime.now(timezone.utc) - published_at <= timedelta(days=365)
            except Exception:
                recent = False
        if recent and downloads > 10_000 and subresource_count >= 3:
            component["strategy"] = "module"
            return "module"

    component["strategy"] = "hcl"
    return "hcl"


def build_website_site_files(site_index_html: str) -> dict[str, str]:
    encoded = base64.b64encode(site_index_html.encode("utf-8")).decode("ascii")
    return {
        "terraform/site/index.html.b64": encoded,
    }


def _safe_context_block(value: str) -> str:
    return str(value or "").replace("\r", "")


def build_manifest_bundle(
    *,
    project_name: str,
    workspace: str,
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
    manifest: list[dict[str, Any]],
) -> tuple[dict[str, str], list[str]]:
    warnings: list[str] = []
    resource_types = {str(component.get("type") or "") for component in manifest}
    if any(resource_type not in SUPPORTED_TEMPLATE_TYPES for resource_type in resource_types):
        warnings.append("Manifest contains resource types outside the deterministic bundle template; fallback bundle may be used during plan remediation.")

    safe_project_slug = slugify(project_name, "deplai-project")[:40]
    encoded_index = base64.b64encode(str(website_index_html or "").encode("utf-8")).decode("ascii")
    context_block = _safe_context_block(context_summary)

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

    variables_tf = f"""variable "project_name" {{
  type    = string
  default = "{safe_project_slug}"
}}

variable "aws_region" {{
  type    = string
  default = "{aws_region}"
}}

variable "environment" {{
  type    = string
  default = "{workspace}"
}}

variable "instance_type" {{
  type    = string
  default = "t3.micro"
}}

variable "enable_ec2" {{
  type    = bool
  default = true
}}

variable "existing_ec2_key_pair_name" {{
  type    = string
  default = ""
}}

variable "ingress_cidr_blocks" {{
  type    = list(string)
  default = ["0.0.0.0/0"]
}}

variable "ssh_ingress_cidr_blocks" {{
  type    = list(string)
  default = []
}}

variable "preferred_availability_zones" {{
  type    = list(string)
  default = ["{aws_region}a", "{aws_region}b", "{aws_region}c"]
}}

variable "use_default_vpc" {{
  type    = bool
  default = true
}}

variable "vpc_cidr_block" {{
  type    = string
  default = "10.42.0.0/16"
}}

variable "public_subnet_cidr" {{
  type    = string
  default = "10.42.1.0/24"
}}

variable "force_destroy_site_bucket" {{
  type    = bool
  default = true
}}

variable "ec2_root_volume_size" {{
  type    = number
  default = 8
}}

variable "bootstrap_index_html_base64" {{
  type      = string
  default   = "{encoded_index}"
  sensitive = true
}}

variable "context_summary" {{
  type    = string
  default = ""
}}
"""

    tfvars = f"""project_name = "{safe_project_slug}"
aws_region = "{aws_region}"
environment = "{workspace}"
instance_type = "t3.micro"
enable_ec2 = true
existing_ec2_key_pair_name = ""
ingress_cidr_blocks = ["0.0.0.0/0"]
ssh_ingress_cidr_blocks = []
preferred_availability_zones = ["{aws_region}a", "{aws_region}b", "{aws_region}c"]
use_default_vpc = true
vpc_cidr_block = "10.42.0.0/16"
public_subnet_cidr = "10.42.1.0/24"
force_destroy_site_bucket = true
ec2_root_volume_size = 8
bootstrap_index_html_base64 = "{encoded_index}"
context_summary = <<-EOT
{context_block}
EOT
"""

    manifest_comment = "\n".join(
        f"# component={component['id']} type={component['type']} deps={','.join(component.get('dependencies', [])) or 'none'} strategy={component.get('strategy') or 'hcl'}"
        for component in manifest
    )

    main_tf = f"""{manifest_comment}
locals {{
  tags = {{
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "deplai"
  }}
}}

data "aws_availability_zones" "available" {{
  state = "available"
}}

data "aws_vpc" "default" {{
  count   = var.use_default_vpc ? 1 : 0
  default = true
}}

data "aws_subnets" "default" {{
  count = var.use_default_vpc ? 1 : 0
  filter {{
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }}
}}

locals {{
  preferred_azs = length(var.preferred_availability_zones) > 0 ? [for az in var.preferred_availability_zones : az if contains(data.aws_availability_zones.available.names, az)] : data.aws_availability_zones.available.names
  selected_az   = length(local.preferred_azs) > 0 ? local.preferred_azs[0] : data.aws_availability_zones.available.names[0]
  default_subnet_ids = try(data.aws_subnets.default[0].ids, [])
}}

data "aws_subnet" "default_details" {{
  for_each = var.use_default_vpc ? toset(local.default_subnet_ids) : toset([])
  id       = each.value
}}

locals {{
  preferred_default_subnet_ids = [for s in values(data.aws_subnet.default_details) : s.id if contains(local.preferred_azs, s.availability_zone)]
  selected_default_subnet_id   = length(local.preferred_default_subnet_ids) > 0 ? local.preferred_default_subnet_ids[0] : (length(local.default_subnet_ids) > 0 ? local.default_subnet_ids[0] : null)
}}

resource "aws_vpc" "main" {{
  count                = var.use_default_vpc ? 0 : 1
  cidr_block           = var.vpc_cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, {{ Name = "${{var.project_name}}-vpc" }})
}}

resource "aws_internet_gateway" "main" {{
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, {{ Name = "${{var.project_name}}-igw" }})
}}

resource "aws_subnet" "public" {{
  count                   = var.use_default_vpc ? 0 : 1
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.selected_az
  map_public_ip_on_launch = true
  tags                    = merge(local.tags, {{ Name = "${{var.project_name}}-public-subnet" }})
}}

resource "aws_route_table" "public" {{
  count  = var.use_default_vpc ? 0 : 1
  vpc_id = aws_vpc.main[0].id
  tags   = merge(local.tags, {{ Name = "${{var.project_name}}-public-rt" }})
}}

resource "aws_route" "internet_access" {{
  count                  = var.use_default_vpc ? 0 : 1
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}}

resource "aws_route_table_association" "public" {{
  count          = var.use_default_vpc ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}}

locals {{
  selected_vpc_id             = var.use_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
  selected_instance_subnet_id = var.use_default_vpc ? local.selected_default_subnet_id : aws_subnet.public[0].id
}}

resource "aws_security_group" "web" {{
  name_prefix = "${{var.project_name}}-web-"
  description = "Web access for DeplAI deployment"
  vpc_id      = local.selected_vpc_id
  tags        = local.tags

  dynamic "ingress" {{
    for_each = var.ssh_ingress_cidr_blocks
    content {{
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }}
  }}

  ingress {{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }}

  ingress {{
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "tls_private_key" "generated" {{
  count     = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}}

resource "aws_key_pair" "generated" {{
  count      = var.enable_ec2 && trimspace(var.existing_ec2_key_pair_name) == "" ? 1 : 0
  key_name   = "${{var.project_name}}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
}}

locals {{
  selected_ec2_key_name = !var.enable_ec2 ? null : (
    trimspace(var.existing_ec2_key_pair_name) != ""
    ? trimspace(var.existing_ec2_key_pair_name)
    : try(aws_key_pair.generated[0].key_name, null)
  )
}}

data "aws_ami" "al2023" {{
  most_recent = true
  owners      = ["amazon"]

  filter {{
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }}

  filter {{
    name   = "virtualization-type"
    values = ["hvm"]
  }}
}}

resource "aws_instance" "app" {{
  count                       = var.enable_ec2 ? 1 : 0
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = local.selected_instance_subnet_id
  vpc_security_group_ids      = [aws_security_group.web.id]
  key_name                    = local.selected_ec2_key_name
  associate_public_ip_address = true
  tags                        = merge(local.tags, {{ Name = "${{var.project_name}}-app" }})

  metadata_options {{
    http_tokens = "required"
  }}

  root_block_device {{
    volume_type = "gp3"
    volume_size = var.ec2_root_volume_size
    encrypted   = true
  }}

  user_data = <<-EOF
              #!/bin/bash
              cat > /var/www/html/index.html <<'HTML'
              ${{base64decode(var.bootstrap_index_html_base64)}}
              HTML
              EOF
}}

resource "random_id" "bucket_suffix" {{
  byte_length = 4
}}

resource "aws_s3_bucket" "website" {{
  bucket        = "${{var.project_name}}-site-${{random_id.bucket_suffix.hex}}"
  force_destroy = var.force_destroy_site_bucket
  tags          = local.tags
}}

resource "aws_s3_bucket_public_access_block" "website" {{
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}}

resource "aws_s3_bucket_ownership_controls" "website" {{
  bucket = aws_s3_bucket.website.id
  rule {{ object_ownership = "BucketOwnerPreferred" }}
}}

resource "aws_s3_object" "index" {{
  bucket       = aws_s3_bucket.website.id
  key          = "index.html"
  content      = base64decode(var.bootstrap_index_html_base64)
  content_type = "text/html"
  depends_on   = [aws_s3_bucket_ownership_controls.website, aws_s3_bucket_public_access_block.website]
}}

resource "aws_cloudfront_origin_access_control" "oac" {{
  name                              = "${{var.project_name}}-oac-${{random_id.bucket_suffix.hex}}"
  description                       = "OAC for website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}}

resource "aws_cloudfront_distribution" "website" {{
  enabled             = true
  default_root_object = "index.html"
  tags                = local.tags

  origin {{
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "s3-website-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }}

  default_cache_behavior {{
    target_origin_id       = "s3-website-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {{
      query_string = false
      cookies {{ forward = "none" }}
    }}
  }}

  restrictions {{
    geo_restriction {{
      restriction_type = "none"
    }}
  }}

  viewer_certificate {{
    cloudfront_default_certificate = true
  }}
}}

resource "aws_s3_bucket_policy" "website" {{
  bucket = aws_s3_bucket.website.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect = "Allow"
      Principal = {{ Service = "cloudfront.amazonaws.com" }}
      Action = ["s3:GetObject"]
      Resource = ["${{aws_s3_bucket.website.arn}}/*"]
      Condition = {{
        StringEquals = {{
          "AWS:SourceArn" = aws_cloudfront_distribution.website.arn
        }}
      }}
    }}]
  }})
}}
"""

    outputs_tf = """output "cloudfront_url" { value = "https://${aws_cloudfront_distribution.website.domain_name}" }
output "website_bucket_name" { value = aws_s3_bucket.website.id }
output "ec2_instance_id" { value = try(aws_instance.app[0].id, null) }
output "ec2_instance_arn" { value = try(aws_instance.app[0].arn, null) }
output "ec2_instance_state" { value = try(aws_instance.app[0].instance_state, null) }
output "ec2_instance_type" { value = var.instance_type }
output "ec2_public_ip" { value = try(aws_instance.app[0].public_ip, null) }
output "ec2_private_ip" { value = try(aws_instance.app[0].private_ip, null) }
output "ec2_public_dns" { value = try(aws_instance.app[0].public_dns, null) }
output "ec2_private_dns" { value = try(aws_instance.app[0].private_dns, null) }
output "ec2_vpc_id" { value = local.selected_vpc_id }
output "ec2_subnet_id" { value = local.selected_instance_subnet_id }
output "ec2_key_name" { value = local.selected_ec2_key_name }
output "generated_ec2_private_key_pem" {
  value     = try(tls_private_key.generated[0].private_key_pem, null)
  sensitive = true
}
"""

    inventory = """[all]
# replace with your hosts
example-host ansible_host=127.0.0.1 ansible_user=ubuntu
"""

    ansible = """---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure unattended upgrades package is present (Debian/Ubuntu)
      apt:
        name: unattended-upgrades
        state: present
      when: ansible_os_family == "Debian"
"""

    readme = f"""# IaC Bundle - {project_name}

Generated by the DeplAI Terraform agent.
"""

    files = {
        "terraform/providers.tf": providers_tf,
        "terraform/main.tf": main_tf,
        "terraform/variables.tf": variables_tf,
        "terraform/terraform.tfvars": tfvars,
        "terraform/outputs.tf": outputs_tf,
        "ansible/inventory.ini": inventory,
        "ansible/playbooks/security-hardening.yml": ansible,
        "README.md": readme,
    }
    if backend_tf:
        files["terraform/backend.tf"] = backend_tf
    files.update(build_website_site_files(website_index_html))
    return files, warnings


def build_fallback_bundle(
    *,
    project_name: str,
    workspace: str,
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
) -> tuple[dict[str, str], list[str]]:
    files, warnings = build_manifest_bundle(
        project_name=project_name,
        workspace=workspace,
        provider_version=provider_version,
        state_bucket=state_bucket,
        lock_table=lock_table,
        aws_region=aws_region,
        context_summary=context_summary,
        website_index_html=website_index_html,
        manifest=[],
    )
    warnings.insert(0, f"Terraform agent fell back to the deterministic AWS bundle: {', '.join(FALLBACK_RESOURCE_SET)}.")
    return files, warnings

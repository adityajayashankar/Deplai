terraform {
  required_version = ">= 1.6.0"

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

locals {
  tags = {
    Name        = var.bucket_name
    Environment = var.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

module "bucket" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket        = var.bucket_name
  force_destroy = var.force_destroy

  versioning = {
    enabled = var.versioning
  }

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = {
        sse_algorithm = "AES256"
      }
    }
  }

  tags = local.tags
}

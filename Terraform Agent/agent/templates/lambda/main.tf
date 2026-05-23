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
  environment = "production"
  tags = {
    Name        = var.function_name
    Environment = local.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

module "lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 7.0"

  function_name = var.function_name
  description   = "DeplAI managed Lambda function"
  handler       = var.handler
  runtime       = var.runtime
  memory_size   = var.memory_size
  timeout       = var.timeout
  publish       = true

  source_path = "${path.module}/index.py"

  create_lambda_function_url = true
  authorization_type         = "NONE"

  tags = local.tags
}

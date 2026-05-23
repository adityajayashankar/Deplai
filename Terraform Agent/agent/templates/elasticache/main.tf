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

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  environment = "production"
  port        = 6379
  tags = {
    Name        = var.cluster_id
    Environment = local.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

resource "aws_security_group" "cache" {
  name        = "${var.cluster_id}-cache-sg"
  description = "DeplAI ElastiCache access"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = local.port
    to_port     = local.port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_elasticache_subnet_group" "cache" {
  name       = "${var.cluster_id}-subnets"
  subnet_ids = data.aws_subnets.default.ids

  tags = local.tags
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = var.cluster_id
  description                = "DeplAI managed Redis cluster"
  engine                     = var.engine
  engine_version             = "7.1"
  node_type                  = var.node_type
  port                       = local.port
  num_cache_clusters         = var.num_cache_nodes
  automatic_failover_enabled = false
  subnet_group_name          = aws_elasticache_subnet_group.cache.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false

  tags = local.tags
}

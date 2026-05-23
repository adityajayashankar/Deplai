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

resource "aws_security_group" "db" {
  name        = "${var.db_name}-db-sg"
  description = "DeplAI RDS access"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Database"
    from_port   = local.db_port
    to_port     = local.db_port
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

locals {
  db_port = var.engine == "mysql" ? 3306 : 5432
  allocated_storage = 20
  environment       = "production"
  tags = {
    Name        = var.db_name
    Environment = local.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = var.db_name

  engine               = var.engine
  engine_version       = var.engine_version
  family               = var.engine == "mysql" ? "mysql8.0" : "postgres16"
  major_engine_version = var.engine == "mysql" ? "8.0" : "16"
  instance_class       = var.instance_class
  allocated_storage    = local.allocated_storage

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = local.db_port

  publicly_accessible     = false
  vpc_security_group_ids  = [aws_security_group.db.id]
  create_db_subnet_group  = true
  subnet_ids              = slice(data.aws_subnets.default.ids, 0, min(2, length(data.aws_subnets.default.ids)))
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0

  tags = local.tags
}

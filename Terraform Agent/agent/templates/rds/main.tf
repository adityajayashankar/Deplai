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
  is_aurora = startswith(var.engine, "aurora-")
  is_serverless = var.instance_class == "db.serverless"

  db_port = var.engine == "mysql" || var.engine == "aurora-mysql" ? 3306 : 5432
  family  = var.engine == "mysql" ? "mysql8.0" : var.engine == "postgres" ? "postgres16" : ""
  major_engine_version = var.engine == "mysql" ? "8.0" : var.engine == "postgres" ? "16" : ""

  environment = "production"
  tags = {
    Name        = var.db_name
    Environment = local.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
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

# -----------------------------------------------------------------------------
# STANDARD RDS MODULE (Used when engine is NOT Aurora)
# -----------------------------------------------------------------------------
module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  count = local.is_aurora ? 0 : 1

  identifier = var.db_name

  engine               = var.engine
  engine_version       = var.engine_version
  family               = local.family
  major_engine_version = local.major_engine_version
  instance_class       = var.instance_class

  allocated_storage     = var.allocated_storage
  storage_type          = var.storage_type
  max_allocated_storage = var.storage_autoscaling && var.max_allocated_storage > var.allocated_storage ? var.max_allocated_storage : null

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = local.db_port

  multi_az                = var.multi_az
  publicly_accessible     = var.publicly_accessible
  deletion_protection     = var.deletion_protection
  backup_retention_period = var.backup_retention_period
  skip_final_snapshot     = true

  vpc_security_group_ids = [aws_security_group.db.id]
  create_db_subnet_group = true
  subnet_ids             = slice(data.aws_subnets.default.ids, 0, min(2, length(data.aws_subnets.default.ids)))

  tags = local.tags
}

# -----------------------------------------------------------------------------
# AURORA CLUSTER MODULE (Used when engine is Aurora)
# -----------------------------------------------------------------------------
module "aurora" {
  source  = "terraform-aws-modules/rds-aurora/aws"
  version = "~> 9.0"

  count = local.is_aurora ? 1 : 0

  name            = var.db_name
  engine          = var.engine
  engine_version  = var.engine_version
  
  master_username = var.db_username
  master_password = var.db_password
  manage_master_user_password = false
  
  port = local.db_port

  instances = {
    for i in range(1 + var.aurora_replica_count) : i => {
      instance_class      = var.instance_class
      publicly_accessible = var.publicly_accessible
    }
  }

  serverlessv2_scaling_configuration = local.is_serverless ? {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  } : {}

  storage_type            = var.aurora_cluster_storage_type
  deletion_protection     = var.deletion_protection
  backup_retention_period = var.backup_retention_period
  skip_final_snapshot     = true

  vpc_security_group_ids = [aws_security_group.db.id]
  create_db_subnet_group = true
  subnets                = slice(data.aws_subnets.default.ids, 0, min(2, length(data.aws_subnets.default.ids)))

  tags = local.tags
}

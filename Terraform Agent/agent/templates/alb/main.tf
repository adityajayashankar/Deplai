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
  tags = {
    Name        = var.alb_name
    Environment = local.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

resource "aws_security_group" "alb" {
  name        = "${var.alb_name}-alb-sg"
  description = "DeplAI ALB access"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
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

resource "aws_lb" "main" {
  name               = var.alb_name
  load_balancer_type = "application"
  internal           = var.internal
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = local.tags
}

resource "aws_lb_target_group" "main" {
  name        = "${var.alb_name}-tg"
  port        = var.target_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  health_check {
    enabled = true
    path    = "/"
  }

  tags = local.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }

  tags = local.tags
}

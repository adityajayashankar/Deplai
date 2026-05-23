terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "tls_private_key" "deplai" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "deplai" {
  key_name   = var.key_pair_name
  public_key = tls_private_key.deplai.public_key_openssh

  tags = local.tags
}

resource "local_sensitive_file" "private_key" {
  content         = tls_private_key.deplai.private_key_pem
  filename        = "${path.module}/${var.key_pair_name}.pem"
  file_permission = "0600"
}

resource "aws_vpc" "deplai" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, {
    Name = "${var.instance_name}-vpc"
  })
}

resource "aws_internet_gateway" "deplai" {
  vpc_id = aws_vpc.deplai.id

  tags = merge(local.tags, {
    Name = "${var.instance_name}-igw"
  })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.deplai.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = "${var.instance_name}-public-subnet"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.deplai.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.deplai.id
  }

  tags = merge(local.tags, {
    Name = "${var.instance_name}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "instance" {
  name        = "${var.instance_name}-sg"
  description = "DeplAI EC2 access"
  vpc_id      = aws_vpc.deplai.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
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
  tags = {
    Name        = var.instance_name
    Environment = var.environment
    ManagedBy   = "deplai"
    ProjectId   = var.project_id
  }
}

module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "~> 5.0"

  name                        = var.instance_name
  ami                         = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id
  instance_type               = var.instance_type
  key_name                    = aws_key_pair.deplai.key_name
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  associate_public_ip_address = true

  root_block_device = [
    {
      encrypted   = true
      volume_type = "gp3"
      volume_size = var.root_volume_size_gb
    }
  ]

  tags = local.tags
}

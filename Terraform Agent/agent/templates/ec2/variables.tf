variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment tag."
  type        = string
  default     = "production"
}

variable "instance_name" {
  description = "EC2 instance name."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.micro"
}

variable "ami_id" {
  description = "AMI ID. Empty string uses latest Ubuntu 22.04 LTS."
  type        = string
  default     = ""
}

variable "key_pair_name" {
  description = "EC2 key pair name to create."
  type        = string
  default     = "deplai-keypair"
}

variable "root_volume_size_gb" {
  description = "Root volume size in GB."
  type        = number
  default     = 20
}


variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "container_image" {
  description = "Container image URI."
  type        = string
}

variable "container_port" {
  description = "Container port."
  type        = number
  default     = 80
}

variable "cpu" {
  description = "Fargate CPU units."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate memory MB."
  type        = number
  default     = 512
}


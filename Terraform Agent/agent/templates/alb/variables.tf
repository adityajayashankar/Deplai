variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "alb_name" {
  description = "Application Load Balancer name."
  type        = string
}

variable "internal" {
  description = "Whether the ALB is internal."
  type        = bool
  default     = false
}

variable "target_port" {
  description = "Target group port."
  type        = number
  default     = 80
}


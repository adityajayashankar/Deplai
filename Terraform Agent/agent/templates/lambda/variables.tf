variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "function_name" {
  description = "Lambda function name."
  type        = string
}

variable "runtime" {
  description = "Lambda runtime."
  type        = string
  default     = "python3.12"
}

variable "handler" {
  description = "Lambda handler."
  type        = string
  default     = "index.handler"
}

variable "memory_size" {
  description = "Memory size in MB."
  type        = number
  default     = 128
}

variable "timeout" {
  description = "Timeout in seconds."
  type        = number
  default     = 30
}

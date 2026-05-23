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

variable "bucket_name" {
  description = "Globally unique S3 bucket name."
  type        = string
}

variable "versioning" {
  description = "Enable bucket versioning."
  type        = bool
  default     = false
}

variable "force_destroy" {
  description = "Delete objects on bucket destroy."
  type        = bool
  default     = true
}

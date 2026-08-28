variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region for the S3 origin bucket."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment tag."
  type        = string
  default     = "production"
}

variable "bucket_name" {
  description = "Globally unique S3 origin bucket name."
  type        = string
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "default_root_object" {
  description = "Default object CloudFront serves at /."
  type        = string
  default     = "index.html"
}

variable "force_destroy" {
  description = "Delete objects on bucket destroy."
  type        = bool
  default     = true
}

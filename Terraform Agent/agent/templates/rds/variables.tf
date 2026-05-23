variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "engine" {
  description = "Database engine."
  type        = string
  default     = "mysql"
}

variable "engine_version" {
  description = "Database engine version."
  type        = string
  default     = "8.0"
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "Initial database name."
  type        = string
}

variable "db_username" {
  description = "Database admin username."
  type        = string
}

variable "db_password" {
  description = "Database admin password."
  type        = string
  sensitive   = true
}

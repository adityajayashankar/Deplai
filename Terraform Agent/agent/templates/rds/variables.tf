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

# ---------------------------------------------------------
# New Extended Configuration Variables
# ---------------------------------------------------------

variable "allocated_storage" {
  description = "The allocated storage in gigabytes (Standard RDS)."
  type        = number
  default     = 20
}

variable "storage_type" {
  description = "The storage type for the DB instance (gp2, gp3, io1)."
  type        = string
  default     = "gp3"
}

variable "multi_az" {
  description = "Specifies if the RDS instance is multi-AZ (Standard RDS)."
  type        = bool
  default     = false
}

variable "publicly_accessible" {
  description = "Bool to control if instance is publicly accessible."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "The database can't be deleted when this value is set to true."
  type        = bool
  default     = false
}

variable "storage_autoscaling" {
  description = "Enable storage autoscaling (Standard RDS)."
  type        = bool
  default     = true
}

variable "max_allocated_storage" {
  description = "The upper limit to which Amazon RDS can automatically scale the storage of the DB instance."
  type        = number
  default     = 0
}

variable "aurora_replica_count" {
  description = "Number of reader nodes to provision for Aurora clusters."
  type        = number
  default     = 0
}

variable "aurora_cluster_storage_type" {
  description = "Aurora cluster storage type (standard or aurora-iopt1)."
  type        = string
  default     = "standard"
}

variable "backup_retention_period" {
  description = "The days to retain backups for."
  type        = number
  default     = 7
}

variable "aurora_min_acu" {
  description = "Minimum ACU capacity for Aurora Serverless v2."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Maximum ACU capacity for Aurora Serverless v2."
  type        = number
  default     = 4.0
}

variable "project_id" {
  description = "DeplAI project identifier."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "cluster_id" {
  description = "ElastiCache replication group ID."
  type        = string
}

variable "engine" {
  description = "Cache engine."
  type        = string
  default     = "redis"
}

variable "node_type" {
  description = "Cache node type."
  type        = string
  default     = "cache.t3.micro"
}

variable "num_cache_nodes" {
  description = "Number of cache nodes."
  type        = number
  default     = 1
}

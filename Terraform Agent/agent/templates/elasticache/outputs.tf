output "primary_endpoint_address" {
  value = aws_elasticache_replication_group.cache.primary_endpoint_address
}

output "port" {
  value = aws_elasticache_replication_group.cache.port
}

output "cluster_id" {
  value = aws_elasticache_replication_group.cache.id
}

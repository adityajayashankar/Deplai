output "endpoint" {
  value = local.is_aurora ? module.aurora[0].cluster_endpoint : module.db[0].db_instance_endpoint
}

output "port" {
  value = local.is_aurora ? module.aurora[0].cluster_port : module.db[0].db_instance_port
}

output "db_instance_id" {
  value = local.is_aurora ? module.aurora[0].cluster_id : module.db[0].db_instance_identifier
}

output "db_instance_arn" {
  value = local.is_aurora ? module.aurora[0].cluster_arn : module.db[0].db_instance_arn
}

output "endpoint" {
  value = module.db.db_instance_endpoint
}

output "port" {
  value = module.db.db_instance_port
}

output "db_instance_id" {
  value = module.db.db_instance_identifier
}

output "db_instance_arn" {
  value = module.db.db_instance_arn
}

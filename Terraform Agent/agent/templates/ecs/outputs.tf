output "cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "service_name" {
  value = aws_ecs_service.main.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.main.arn
}

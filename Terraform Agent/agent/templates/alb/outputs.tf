output "lb_dns_name" {
  value = module.alb.dns_name
}

output "alb_dns_name" {
  value = module.alb.dns_name
}

output "lb_arn" {
  value = module.alb.arn
}

output "target_group_arn" {
  value = try(module.alb.target_groups["app"].arn, null)
}

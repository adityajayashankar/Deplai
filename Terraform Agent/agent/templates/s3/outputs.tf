output "bucket_id" {
  value = module.bucket.s3_bucket_id
}

output "bucket_arn" {
  value = module.bucket.s3_bucket_arn
}

output "bucket_domain_name" {
  value = module.bucket.s3_bucket_bucket_domain_name
}

output "region" {
  value = var.aws_region
}

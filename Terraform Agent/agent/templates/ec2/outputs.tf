output "public_ip" {
  value = module.ec2.public_ip
}

output "instance_id" {
  value = module.ec2.id
}

output "keypair_name" {
  value = aws_key_pair.deplai.key_name
}

output "availability_zone" {
  value = module.ec2.availability_zone
}

output "arn" {
  value = module.ec2.arn
}

output "private_key_pem" {
  value     = tls_private_key.deplai.private_key_pem
  sensitive = true
}

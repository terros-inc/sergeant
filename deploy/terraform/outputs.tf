output "instance_id" {
  description = "The SSM target for `sergeant-update` and sessions (README)."
  value       = aws_instance.host.id
}

output "public_ip" {
  value = aws_eip.host.public_ip
}

output "endpoint" {
  value = "https://${var.hostname}/health"
}

output "log_group" {
  value = aws_cloudwatch_log_group.host.name
}

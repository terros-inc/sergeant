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

output "runner_repository_url" {
  description = "Where install.sh pushes the runner image for Fargate workers, tagged by commit."
  value       = aws_ecr_repository.runner.repository_url
}

output "fargate_runner_parameter" {
  value = aws_ssm_parameter.fargate_runner.name
}

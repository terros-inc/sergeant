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

output "registered_accounts_secret" {
  description = "The registered-accounts secret's name: on a host first booted before TECH-5204, the installation config's `registeredAccountsSecret` (README, Model accounts)."
  value       = aws_secretsmanager_secret.registered_accounts.name
}

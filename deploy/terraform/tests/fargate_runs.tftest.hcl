# A mocked plan of the Fargate worker resources (TECH-5237, fargate.tf): who may read a run's secret,
# and what the host may do with tasks. `terraform init -backend=false && terraform test`. The mock
# provider and overrides are registered_accounts.tftest.hcl's; see there.

mock_provider "aws" {
  # The provider validates that policies are JSON objects; the statements are asserted directly.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

override_resource {
  target          = aws_eip.host
  override_during = plan
  values = {
    public_ip = "192.0.2.10"
  }
}

# user_data names the data volume, so it is known at plan only with the volume's id.
override_resource {
  target          = aws_ebs_volume.data
  override_during = plan
  values = {
    id = "vol-0123456789abcdef0"
  }
}

override_resource {
  target          = aws_route53_record.host
  override_during = plan
}

override_resource {
  target          = aws_secretsmanager_secret.registered_accounts
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/v2/registered-accounts-AbC123"
  }
}

override_resource {
  target          = aws_iam_role.run_execution
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/sergeant-v2-run-execution"
  }
}

# The ARNs the policies name, known at plan.
override_resource {
  target          = aws_ecr_repository.runner
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:us-west-2:123456789012:repository/sergeant-v2-runner"
    repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/sergeant-v2-runner"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.runs
  override_during = plan
  values = {
    arn = "arn:aws:logs:us-west-2:123456789012:log-group:/sergeant/v2/runs"
  }
}

override_resource {
  target          = aws_ecs_cluster.runs
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-west-2:123456789012:cluster/sergeant-v2-runs"
  }
}

override_data {
  target = data.aws_secretsmanager_secrets.registered_accounts
  values = {
    arns = []
  }
}

variables {
  account_id            = "123456789012"
  hostname              = "sergeant.example.com"
  source_repository_url = "https://github.com/example/sergeant"
  secret_names          = ["github-app-key", "github-reviewer-key", "linear-token", "model-token"]
}

run "only_the_execution_role_reads_run_secrets" {
  command = plan

  assert {
    condition = [
      for s in data.aws_iam_policy_document.run_execution.statement : s.resources
      if anytrue([for a in s.actions : startswith(a, "secretsmanager:")])
    ] == [toset(["arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/runs/*"])]
    error_message = "The execution role should read only the per-run secrets."
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.host_runs.statement : !contains(s.actions, "secretsmanager:GetSecretValue")
    ])
    error_message = "The host creates and deletes run secrets but never reads them back."
  }

  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.host_runs.statement : s.actions
      if contains(s.resources, "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/runs/*")
    ])) == toset(["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"])
    error_message = "The host's per-run secret actions should be exactly create, put, and delete."
  }
}

run "the_host_passes_only_the_execution_role" {
  command = plan

  assert {
    condition = [
      for s in data.aws_iam_policy_document.host_runs.statement : s.resources
      if contains(s.actions, "iam:PassRole")
    ] == [toset(["arn:aws:iam::123456789012:role/sergeant-v2-run-execution"])]
    error_message = "iam:PassRole should name only the execution role: there is no task role."
  }

  assert {
    condition     = length(aws_security_group.runs.ingress) == 0
    error_message = "Worker tasks take no inbound traffic."
  }

  assert {
    condition = contains(flatten([
      for s in data.aws_iam_policy_document.host.statement : s.not_resources if s.sid == "NoOtherParameters"
    ]), "arn:aws:ssm:us-west-2:123456789012:parameter/sergeant/v2/fargate-runner")
    error_message = "The host must be able to read its Fargate settings past the deny on other parameters."
  }
}

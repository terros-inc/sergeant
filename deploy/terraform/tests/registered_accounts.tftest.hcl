# A mocked plan of this configuration (TECH-5212): no AWS credentials, nothing read or created.
# `terraform init -backend=false && terraform test`.
#
# Mock providers cannot import, so each imported resource is overridden, and with
# `override_during = plan` every value an import's refresh depends on must be known at plan:
# aws_route53_record.host's `records` is the EIP's address, so the EIP is overridden too. Only the
# test sees these overrides; a real plan still imports the existing A record.

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

variables {
  account_id            = "123456789012"
  hostname              = "sergeant.example.com"
  source_repository_url = "https://github.com/example/sergeant"
  secret_names          = ["github-app-key", "github-reviewer-key", "linear-token", "model-token"]
}

run "fresh_installation_creates_the_secret" {
  command = plan

  override_data {
    target = data.aws_secretsmanager_secrets.registered_accounts
    values = {
      arns = []
    }
  }

  assert {
    condition     = length(local.existing_registered_accounts) == 0
    error_message = "With no existing secret, nothing should be imported."
  }

  assert {
    condition     = aws_secretsmanager_secret.registered_accounts.name == "sergeant/v2/registered-accounts"
    error_message = "The secret should default to sergeant/v2/registered-accounts."
  }

  assert {
    condition     = jsondecode(aws_secretsmanager_secret_version.registered_accounts_initial.secret_string) == { accounts = [] }
    error_message = "The initial value should be {\"accounts\":[]}."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.registered_accounts_initial.version_stages == toset(["sergeant-initial"])
    error_message = "The initial version should carry only the sergeant-initial label, never AWSCURRENT by name."
  }

  assert {
    condition     = strcontains(aws_instance.host.user_data, "SERGEANT_REGISTERED_ACCOUNTS_SECRET=sergeant/v2/registered-accounts")
    error_message = "The first boot should give the host the secret's name."
  }
}

run "existing_secret_is_adopted_by_exact_arn" {
  command = plan

  variables {
    registered_accounts_secret = "sergeant/terros/registered-accounts"
  }

  # The name filter matches prefixes, so a lookalike comes back too and must not be imported.
  override_data {
    target = data.aws_secretsmanager_secrets.registered_accounts
    values = {
      arns = [
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/terros/registered-accounts-old-XyZ789",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/terros/registered-accounts-AbC123",
      ]
    }
  }

  assert {
    condition = local.existing_registered_accounts == toset([
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/terros/registered-accounts-AbC123",
    ])
    error_message = "Only the secret with exactly the configured name should be imported."
  }

  assert {
    condition     = aws_secretsmanager_secret.registered_accounts.name == "sergeant/terros/registered-accounts"
    error_message = "The adopted secret should keep its name."
  }
}

run "host_reads_and_writes_only_that_secret" {
  command = plan

  override_data {
    target = data.aws_secretsmanager_secrets.registered_accounts
    values = {
      arns = []
    }
  }

  assert {
    condition = [
      for s in data.aws_iam_policy_document.host.statement : s.resources
      if s.sid == "ReadWriteRegisteredAccounts"
      ] == [toset([
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:sergeant/v2/registered-accounts-AbC123",
    ])]
    error_message = "The read/write grant should name exactly the registered-accounts secret's ARN."
  }

  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.host.statement : s.actions
      if contains(s.actions, "secretsmanager:PutSecretValue")
    ])) == toset(["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"])
    error_message = "Only the registered-accounts statement should allow PutSecretValue."
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.host.statement : s
      if contains(s.actions, "secretsmanager:PutSecretValue")
    ]) == 1
    error_message = "Exactly one statement should allow PutSecretValue."
  }
}

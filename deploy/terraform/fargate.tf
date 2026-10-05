# Workers on ECS Fargate (TECH-5237): one task per worker run, so workers do not compete with the
# host for CPU and memory. Reviewers stay on the host. Nothing here runs a task: `serve` does, once
# the installation config sets `runners.workerBackend` to "fargate" (../README.md, "Workers on Fargate").
#
# Each run gets its own secret, `sergeant/runs/<runId>` (its brief and its two credentials), created by
# the host as the run starts and deleted as it is collected. A task has no task role, so nothing in a
# run can call AWS; only the execution role, used by ECS itself, reads the run's secret, pulls the image,
# and writes the run's logs. These names differ from the TECH-5231 spike's hand-made resources
# (sergeant-runner, sergeant-fargate-spike, /sergeant/fargate-spike), which are deleted by hand after cutover.

locals {
  runs_name       = "sergeant-v2-runs"
  run_task_family = "sergeant-v2-run"
  run_secrets     = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:sergeant/runs/*"
  # install.sh reads it by this name.
  fargate_runner_parameter = "/sergeant/v2/fargate-runner"
  fargate_settings         = "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.fargate_runner_parameter}"
}

# --- The runner image: install.sh pushes the host-built image here, tagged by commit, on each install. ---

resource "aws_ecr_repository" "runner" {
  name                 = "sergeant-v2-runner"
  image_tag_mutability = "MUTABLE" # a reinstall of the same commit pushes the same tag again
}

# Every install pushes an image; a run uses the one its host installed, so only recent ones matter.
resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "runs" {
  name = local.runs_name
}

# Each task's stream carries its agent's output and its framed result and report, which `serve` reads.
resource "aws_cloudwatch_log_group" "runs" {
  name              = "/sergeant/v2/runs"
  retention_in_days = var.log_retention_days
}

# --- Network: the default VPC's default subnets (public: a task needs a public IP for GitHub and the
# model APIs) and a security group with no ingress. ---

data "aws_subnets" "runs" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_security_group" "runs" {
  name        = local.runs_name
  description = "Sergeant worker tasks on Fargate: no ingress"
  vpc_id      = data.aws_vpc.default.id

  # Empty, not just absent: an inbound rule added by hand is removed at the next apply.
  ingress = []

  egress {
    description = "GitHub, the model APIs, and package mirrors"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- The execution role: ECS's, never the run's. ---

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "run_execution" {
  name               = "sergeant-v2-run-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "run_execution" {
  # Only the per-run secrets: the installation's own secrets stay unreadable to it.
  statement {
    sid       = "ReadRunSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.run_secrets]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "PullRunnerImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.runner.arn]
  }

  statement {
    sid       = "WriteRunLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "run_execution" {
  name   = "sergeant-v2-run-execution"
  role   = aws_iam_role.run_execution.id
  policy = data.aws_iam_policy_document.run_execution.json
}

# --- The host: start, read, stop, and collect worker tasks, and push the runner image. ---

data "aws_iam_policy_document" "host_runs" {
  # Only this family's revisions, and only in this cluster.
  statement {
    sid       = "RunWorkerTasks"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.run_task_family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.runs.arn]
    }
  }

  statement {
    sid       = "ReadAndStopWorkerTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${var.region}:${var.account_id}:task/${local.runs_name}/*"]
  }

  # A start whose RunTask answer was lost finds its task by `startedBy`.
  statement {
    sid       = "ListWorkerTasks"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.runs.arn]
    }
  }

  # Each run registers its own revision (`secrets` cannot be overridden at RunTask) and deregisters it
  # as it is collected. ECS supports no resource scoping for these two.
  statement {
    sid       = "WorkerTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "PassExecutionRoleOnly"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.run_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # PutSecretValue: a start retried after a lost CreateSecret answer takes over the secret it made.
  statement {
    sid       = "PerRunSecrets"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"]
    resources = [local.run_secrets]
  }

  statement {
    sid       = "ReadRunLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runs.arn}:*"]
  }

  statement {
    sid       = "ReadFargateSettings"
    actions   = ["ssm:GetParameter"]
    resources = [local.fargate_settings]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushRunnerImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.runner.arn]
  }
}

resource "aws_iam_role_policy" "host_runs" {
  name   = "${local.name}-runs"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host_runs.json
}

# --- What the host needs to know: identifiers only. install.sh reads it, adds the image it pushed,
# and writes /etc/sergeant/fargate-runner.json for `serve` (packages/runner/src/fargate/aws.ts). ---

resource "aws_ssm_parameter" "fargate_runner" {
  name        = local.fargate_runner_parameter
  description = "Sergeant 2: where worker tasks run on Fargate. Written by Terraform; identifiers only."
  type        = "String"
  value = jsonencode({
    region           = var.region
    cluster          = aws_ecs_cluster.runs.name
    subnets          = sort(data.aws_subnets.runs.ids)
    securityGroup    = aws_security_group.runs.id
    executionRoleArn = aws_iam_role.run_execution.arn
    logGroup         = aws_cloudwatch_log_group.runs.name
    taskFamily       = local.run_task_family
    repositoryUrl    = aws_ecr_repository.runner.repository_url
  })
}

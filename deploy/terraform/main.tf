# The Sergeant 2 host: one Graviton instance running `serve`, its state on a separate encrypted
# volume, behind Caddy on the installation's permanent endpoint. Managed through SSM only: no SSH, no key
# pair. See ../README.md for the runbook.

locals {
  name              = "sergeant-v2"
  log_group         = "/sergeant/v2"
  availability_zone = coalesce(var.availability_zone, "${var.region}a")
  config_parameter  = "arn:aws:ssm:${var.region}:${var.account_id}:parameter/${trimprefix(var.installation_config_parameter, "/")}"
}

# --- Network: the account's default VPC, one public subnet in the host's zone. ---

data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "host" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = local.availability_zone
  default_for_az    = true
}

resource "aws_security_group" "host" {
  name        = local.name
  description = "Sergeant 2 host: HTTPS to Caddy, and HTTP for the ACME challenge. No SSH."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTPS to Caddy, which proxies serve /health"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP for ACME HTTP-01 and the redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "GitHub, Linear, Anthropic, AWS APIs, and package mirrors"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Identity: SSM, its own log group and config parameter, and get-secret-value on exactly the
# installation's secrets. ---

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_cloudwatch_log_group" "host" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "host" {
  statement {
    sid = "ReadSergeantSecrets"
    # Secrets Manager appends a random six-character suffix to each secret's ARN; `-??????` matches
    # exactly that suffix of exactly these names (literal, validated in variables.tf), so no other
    # secret is readable.
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      for name in var.secret_names : "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${name}-??????"
    ]
  }

  # People register their own model accounts through the API (TECH-5113): the host writes this one
  # secret's value, nothing else, and never creates or deletes a secret.
  dynamic "statement" {
    for_each = var.registered_accounts_secret == null ? [] : [var.registered_accounts_secret]
    content {
      sid       = "WriteRegisteredAccounts"
      actions   = ["secretsmanager:PutSecretValue"]
      resources = ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${statement.value}-??????"]
    }
  }

  statement {
    sid       = "ReadInstallationConfig"
    actions   = ["ssm:GetParameter"]
    resources = [local.config_parameter]
  }

  # AmazonSSMManagedInstanceCore allows ssm:GetParameter(s) on every parameter in the account; this
  # host reads only its config.
  statement {
    sid           = "NoOtherParameters"
    effect        = "Deny"
    actions       = ["ssm:GetParameter", "ssm:GetParameters"]
    not_resources = [local.config_parameter]
  }

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = [aws_cloudwatch_log_group.host.arn, "${aws_cloudwatch_log_group.host.arn}:*"]
  }
}

resource "aws_iam_role_policy" "host" {
  name   = local.name
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = local.name
  role = aws_iam_role.host.name
}

# --- The host. ---

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.host.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  # IMDSv2 only, and a hop limit of 1: a Docker container (one hop further) never reaches the
  # instance role, so a worker or reviewer cannot read the secrets the control plane can.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  # First boot only: installs the update command and runs it once at `initial_ref`. Later releases
  # and config changes go through `sergeant-update` over SSM, not a new instance.
  user_data = templatefile("${path.module}/user_data.yaml.tftpl", {
    host_env = join("\n", [
      "SERGEANT_HOSTNAME=${var.hostname}",
      "SERGEANT_SOURCE_REPOSITORY_URL=${var.source_repository_url}",
      "SERGEANT_CONFIG_PARAMETER=${var.installation_config_parameter}",
      "SERGEANT_DATA_VOLUME_ID=${aws_ebs_volume.data.id}",
      "SERGEANT_LOG_GROUP=${local.log_group}",
      "AWS_REGION=${var.region}",
    ])
    update_script = file("${path.module}/../host/sergeant-update.sh")
    initial_ref   = var.initial_ref
  })

  # A newer Ubuntu AMI or an edited first-boot script must not replace a running host and its work.
  # The values in /etc/sergeant/host.env are therefore fixed at creation (README, "Apply").
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = local.name
  }
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.availability_zone
  type              = "gp3"
  size              = var.data_volume_gb
  encrypted         = true

  # Holds every task's state.json, run records, and review telemetry; it outlives the instance.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = "${local.name}-data"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}

resource "aws_eip" "host" {
  domain   = "vpc"
  instance = aws_instance.host.id

  tags = {
    Name = local.name
  }
}

# --- DNS: the zone predates V2 and is never created or destroyed here. ---

data "aws_route53_zone" "sergeant" {
  name = var.hostname
}

# Where an A record for the hostname already exists (Sergeant 1's), this import takes it over on the
# first apply; afterwards it is a no-op. Sergeant 1's state must `state rm` the record and the zone
# before it is destroyed: README, "Taking over from Sergeant 1". With no existing record, remove the
# import block for the first apply.
import {
  to = aws_route53_record.host
  id = "${data.aws_route53_zone.sergeant.zone_id}_${var.hostname}_A"
}

resource "aws_route53_record" "host" {
  zone_id = data.aws_route53_zone.sergeant.zone_id
  name    = var.hostname
  type    = "A"
  ttl     = 300
  records = [aws_eip.host.public_ip]
}

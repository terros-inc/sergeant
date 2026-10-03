# Installation-specific values have no defaults: init.sh writes them to terraform.tfvars.json from the
# infrastructure-config SSM parameter (infrastructure-config.example.json), never from the repository.

variable "account_id" {
  description = "The AWS account this installation lives in; any other account's credentials fail before anything is read."
  type        = string
}

variable "region" {
  type    = string
  default = "us-west-2"
}

variable "hostname" {
  description = "The installation's permanent Sergeant endpoint. An existing Route 53 hosted zone of exactly this name holds its A record."
  type        = string
}

variable "source_repository_url" {
  description = "The Sergeant repository the host checks out, e.g. https://github.com/<owner>/sergeant. It must be public: the host fetches it anonymously."
  type        = string

  validation {
    condition     = can(regex("^https://github\\.com/[^/]+/[^/]+$", var.source_repository_url))
    error_message = "Expected https://github.com/<owner>/<repo>, without .git or a trailing slash."
  }
}

variable "secret_names" {
  description = "The only Secrets Manager secrets the host may read, by name: every secret reference in the installation config. None is created here."
  type        = list(string)

  # They become IAM resource patterns, so a wildcard or an ARN here would widen the grant.
  validation {
    condition     = length(var.secret_names) >= 4 && length(var.secret_names) <= 12 && length(distinct(var.secret_names)) == length(var.secret_names) && alltrue([for name in var.secret_names : can(regex("^[A-Za-z0-9/_+=.@-]+$", name))])
    error_message = "Expected four to twelve distinct Secrets Manager names (letters, digits, and /_+=.@- only; no wildcards or ARNs): the two GitHub App keys, the Linear agent token, the model token, and optionally the Linear and GitHub webhook signing secrets, the Codex credential, the owner's further model accounts, and the registered-accounts secret."
  }
}

variable "registered_accounts_secret" {
  description = "The installation config's `registeredAccountsSecret` (TECH-5113), also listed in `secret_names`: the one secret the host may also write, holding the model accounts people register with `sgt`. Null, nobody can register."
  type        = string
  default     = null

  validation {
    condition     = var.registered_accounts_secret == null || (can(regex("^[A-Za-z0-9/_+=.@-]+$", var.registered_accounts_secret)) && contains(var.secret_names, var.registered_accounts_secret))
    error_message = "Expected a literal Secrets Manager name (no wildcards or ARNs) that is also in secret_names."
  }
}

variable "installation_config_parameter" {
  description = "The SSM parameter (String) holding the installation config JSON. Written by the operator, not Terraform (README)."
  type        = string
  default     = "/sergeant/v2/installation-config"
}

variable "initial_ref" {
  description = "The Sergeant git ref the first boot installs. Later refs go through `sergeant-update` (README), not Terraform."
  type        = string
  default     = "main"
}

variable "instance_type" {
  description = "Graviton. Sized for 2 task slots (`maxTasks`): two tasks' Docker workers and reviewers plus the control plane."
  type        = string
  default     = "m7g.xlarge"
}

variable "availability_zone" {
  description = "The host and its data volume share one zone. Defaults to the region's `a` zone."
  type        = string
  default     = null
}

variable "root_volume_gb" {
  description = "OS, Docker images, and the checked-out source."
  type        = number
  default     = 40
}

variable "data_volume_gb" {
  description = "The service state dir (/var/lib/sergeant): task state, run records, and run workspaces."
  type        = number
  default     = 100
}

variable "log_retention_days" {
  type    = number
  default = 30
}

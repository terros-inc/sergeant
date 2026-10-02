# ADR-0040: Installation identity lives in AWS; Terraform state is per installation account

## Status

Accepted (UNF-491). UNF-689 (ADR-0042) replaced the checked-in `environments/<env>.tfvars`:
the wrapper now generates Terraform's inputs from the verified identity and the installation's
configuration in AWS (`sgt config`), so the "tfvars" link in the selection chain and the
"account id is checked in" guard below are historical. The record, per-account state, and the
backend and provider account guards are unchanged. Replaces the Terraform-workspace installation boundary that
`deploy/scripts/terraform-installation.sh` introduced for Terros, and the "no remote backend yet"
note in `deploy/terraform/versions.tf` (UNF-207). Evolves UNF-390's local profile model
(ADR-0030) rather than adding a second one.

## Context

Sergeant has two real installations — Personal (historically `unforgotten`) and Terros — in
separate AWS accounts, sharing one Terraform root. Which installation a command addressed was
spread across a Terraform workspace (`default` for Personal, `terros` for Terros), a laptop-only
`terraform.tfstate`, the checked-in tfvars, an AWS profile, and occasionally an auto-loaded local
`terraform.tfvars` (UNF-477, UNF-611). Nothing stopped a Terros apply from running with Personal
credentials, or Personal's state from existing only on one laptop.

## Decision

**An installation is the unit of isolation.** Each has its own AWS account, a permanent opaque
installation id, and its own Terraform state bucket; source, Terraform modules and the CLI are
shared. No organizations, stages, backend factories or multi-tenant framework.

- **Identity lives in the installation's account.** One SSM parameter,
  `/sergeant/installation-identity`, holds `{installation_id, environment, aws_account_id, region,
  terraform_state_bucket, endpoint?}` — one installation per account/region, as `sgt admin`'s
  discovery already assumes. `sgt init <name> --bootstrap` writes it once with no-overwrite (an
  atomic claim) and never updates it.
- **State is per account.** `sergeant-tfstate-<installation id>` (globally unique through the id,
  not the friendly name), versioned, SSE-encrypted, public access blocked, TLS-only, created by
  `sgt init`, never by Terraform. The backend is a partial `backend "s3"` with S3-native locking
  (`use_lockfile`, Terraform ≥ 1.11) — no DynamoDB table.
- **The local entry is a pointer.** `~/.config/sergeant/config.toml` keeps UNF-390's file and
  model, renamed to `default_installation`/`[installations.<name>]` (old keys still load) and
  extended with the identity fields `sgt init` copies from the record. A fresh machine rebuilds
  it with `sgt init <name>`; nothing is copied between machines.
- **Selecting an installation selects everything together**: local name → entry → the AWS account
  the credentials resolve to → the record → the bucket → the checked-in
  `environments/<env>.tfvars` → the endpoint. The Terraform wrapper builds its backend
  configuration only from an entry `sgt init <name> --check` has just re-verified against AWS,
  pins the `default` workspace, and refuses local state and workspace directories.
- **The account id is checked in.** Each tfvars pins `aws_account_id`; the AWS provider's
  `allowed_account_ids` and the backend's `allowed_account_ids` both enforce it, so even a raw
  `terraform` run under the wrong credentials fails before reading state or refreshing a resource.
- **The AWS profile is local.** It names an operator's credentials, not desired state, so it moved
  from the tfvars to the entry; the wrapper passes it to the backend and provider.

## Consequences

- `sgt init unforgotten` on a new machine plus AWS credentials is enough to plan Personal; no
  laptop is a single point of failure for state.
- A Terros operation cannot reach Personal state through normal tooling: four independent guards
  (entry verification, tfvars cross-check, backend and provider account allow-lists) each refuse
  the wrong account first.
- Personal's existing local state needs a one-time `migrate-state` (runbook), after which the
  primary checkout holds no state.
- An installation's region and account are fixed; moving either is a new installation.
- Older `sgt` binaries cannot read a config file a newer one has saved (new keys and fields under
  `deny_unknown_fields`); `sgt update` is the fix.

See `docs/runbooks/sergeant-installation-init.md`.

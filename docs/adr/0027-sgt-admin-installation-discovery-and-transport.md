# ADR-0027: `sgt admin` — AWS/IAM-gated installation administration via SSM

## Status

Accepted. Unit-tested Rust only (mocked `InstanceDiscovery`/`CommandTransport` — see
`crates/sergeant-cli/src/commands/admin/`) — no live SSM registration, no real `sgt admin exec`
run against the Unforgotten instance. That verification happens separately, outside a sandboxed
task worktree, with a human/Firstmate holding real AWS credentials driving it explicitly (this
machine's crewmate worktrees inherit real ambient AWS credentials, so nothing here was run against
them).

## Context

UNF-390 scaffolded `aws_profile`/`region` fields on a named `sgt` installation profile
(`crates/sergeant-cli/src/profile.rs`) explicitly for this ticket, but left them unused. Every
other `sgt` subcommand is a Linear-authenticated HTTP client of the daemon
(`crate::client::Client`) — there was no privileged, IAM-gated path at all, and the ticket's own
non-goal is explicit: no Sergeant admin users/roles/tokens, no generic auth-provider negotiation.
The daemon's own on-box access is already SSM-only, no-public-ingress (ADR-0016,
`deploy/terraform/ec2.tf`/`iam.tf`) — an operator today reaches the instance by hand-copying its
current instance id (from a `terraform output`, the console, or memory) into
`aws ssm start-session --target "$instance_id" ...` (see
`docs/runbooks/sergeant-unforgotten-ec2.md`'s resilience-test section). That manual copy is
exactly what "the CLI profile identifies an installation, not a machine" (the ticket's own
constraint) rules out for `sgt admin`: replacing the EC2 instance must not require editing every
local `sgt` profile.

UNF-395 (`crates/sergeant-cli/src/commands/doctor/installation_config.rs`, not yet merged at the
time this ADR was written) put the daemon's own non-secret config overrides in SSM Parameter
Store, keyed by environment name (`/sergeant/<environment>/env/...`) — but that hierarchy is
config data the instance reads about itself at boot, not an operator-facing discovery record, and
requires knowing the environment name up front. A local `sgt` profile deliberately never carries
an "environment" field (see `profile.rs`'s own doc comment on the ticket's simplification
boundary), so reusing that path would have required adding one just for this.

## Decision

**Discovery goes through SSM's own managed-instance inventory, filtered by a tag Terraform already
applies to every installation resource — no new Terraform resource, no instance id anywhere in
`~/.config/sergeant/config.toml`.** `deploy/terraform/main.tf`'s AWS provider `default_tags` block
already stamps `Project = "sergeant"` (plus `Environment`/`ManagedBy`) onto every resource,
including `aws_instance.sergeant`, and SSM Agent republishes an EC2 instance's tags into its own
managed-instance inventory. `sgt admin` calls `ssm:DescribeInstanceInformation` with an AWS-side
`tag:Project = sergeant` filter (`commands/admin/discovery.rs`) and expects exactly one `Online`
match — V1's explicit one-installation-per-AWS-account/region assumption (already true per
ADR-0016: "Unforgotten gets one Sergeant environment"). Zero matches or more than one is a loud,
distinct error (`AdminError::InstanceNotFound`/`AmbiguousInstances`), never a silent guess.
Replacing the instance re-tags the new one identically and re-registers it with SSM under a new
instance id automatically — no local profile edit, no Parameter Store write, nothing Terraform
doesn't already do.

Two AWS-API subtleties this call site has to get right, since silently getting either wrong would
undermine the whole "prove there is exactly one" contract:

- `DescribeInstanceInformation` rejects combining a `tag:<key>` filter with any other filter in the
  same request — so `PingStatus = Online` is applied client-side, over the results the tag filter
  already narrowed down, rather than sent as a second AWS-side filter.
- The call paginates (at most 10 records per page by default, with a `NextToken` for the rest);
  `discover_instance_async` walks every page before deciding, since code whose job is "prove there
  is exactly one online match" cannot stop at the first page without risking a false single-match
  result or a missed duplicate.

**Transport is SSM Run Command (`AWS-RunShellScript`), the same document
`deploy/scripts/deploy.sh` already uses for its own remote install step** — send a command,
poll `GetCommandInvocation` for a terminal status, return stdout/stderr/status
(`commands/admin/transport.rs`). One AWS service (SSM) covers discovery and transport alike,
matching the ticket's own model exactly: `AWS credentials -> SSM -> Sergeant installation`, no
`ec2:Describe*` permission needed at all.

**AWS profile/region resolution is exactly the ticket's own scope note**: `commands/admin/
target.rs`'s `AdminTarget::resolve` requires a *selected installation profile* (an explicit
`--profile` or a configured `default_profile`) — with none selected there is no installation to
administer, so this is the one and only "no AWS admin configuration" error. A selected profile's
`aws_profile`/`region` are each independently optional beyond that: unset falls through to
ordinary AWS credential-chain/region-resolution behavior (env vars, `~/.aws/config`, an instance
role), never a second required field.

**One shared `AdminError` enum, not per-call ad hoc strings**, distinguishes exactly the two error
classes the ticket calls out — `NotConfigured` (no profile selected — no AWS call ever attempted)
vs. `IamDenied` (a real AWS/SSM call, denied by IAM; classified from the SDK error's `code()`
matching `AccessDenied`/`AccessDeniedException`/`UnauthorizedOperation`) — plus
`InstanceNotFound`/`AmbiguousInstances`/a catch-all `Aws` for every other AWS/SSM failure
(network, throttling, a bad region). `commands/admin/error.rs::classify` is the one function every
SSM call goes through, so every operation reports the same two distinguished classes rather than
each call site inventing its own.

**One shared Tokio runtime per invocation** (`commands/admin/backend.rs::RealAdminBackend`),
mirroring `commands::doctor::aws::RealAwsProbe`'s existing "one runtime, reused across calls"
shape, rather than a fresh runtime per AWS call.

**Command surface is deliberately two subcommands, not a general remote-shell client**: `sgt admin
status` (discovery only, non-mutating — proves AWS/IAM access and installation discovery work
without touching the instance) and `sgt admin exec <command>` (the actual transport). Both are
host-local, like `doctor`/`login` — neither ever talks to the daemon's HTTP API.

## Consequences

- An operator with correctly configured AWS/IAM access for the profile's account/region can run
  `sgt admin exec <command>` against the selected installation; a Linear-only human with no AWS
  access for that account/region cannot reach SSM at all, regardless of their Sergeant/Linear
  identity — satisfying the ticket's own acceptance criteria without any Sergeant-side admin
  identity existing.
- Replacing the EC2 instance (a deliberate `-replace=aws_instance.sergeant` apply, see
  `docs/runbooks/sergeant-unforgotten-ec2.md`) requires no `sgt profile`/Parameter Store change: the new instance carries the same tag and
  registers with SSM under a new id, which the next `sgt admin` invocation discovers automatically.
- The IAM policy an operator's own AWS identity needs is exactly three actions —
  `ssm:DescribeInstanceInformation`, `ssm:SendCommand`, `ssm:GetCommandInvocation` — scoped by
  their own organization's IAM setup, not provisioned by this repository's Terraform (which
  provisions the *instance's* role, never a human operator's). This ADR does not add a Terraform
  IAM resource for it, per the ticket's own "no Sergeant admin users/roles" boundary — an admin's
  AWS access is exactly the AWS/IAM access their own AWS account setup already gives them.
- **Not built**: multi-instance clustering/leader election (a second matching instance is a loud
  `AmbiguousInstances` error, not a load-balancing choice), a generic remote-shell/SSH-like
  interactive session (`sgt admin exec` is one command, one round trip — `aws ssm start-session`
  by hand remains the tool for an interactive shell), and any Sergeant-side admin identity, role,
  or token.

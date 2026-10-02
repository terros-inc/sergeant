# ADR-0042: Installation configuration lives in AWS; `sgt init` owns identity, `sgt config` owns configuration

## Status

Accepted (UNF-689). Supersedes ADR-0026's "Terraform config is the desired state" (the
checked-in tfvars and `var.installation_config`) and ADR-0040's "the account id is checked in"
and "selecting an installation selects … the checked-in `environments/<env>.tfvars`". Everything
else in both stands: the runtime parameter and how the instance materializes it (ADR-0026), and
the identity record, per-account state and wrong-account guards (ADR-0040).

## Context

Each installation's values lived in a checked-in `deploy/terraform/environments/<env>.tfvars`:
its account id and region, its subnet and bucket names, its pinned AMI and boot release, and the
`installation_config` map that Terraform wrote into the daemon's SSM parameter. That made the
repository the source of truth for things that belong to one installation, not to Sergeant. It
required a reviewed code change to configure an installation, mixed identity with configuration,
and sent runtime settings (worker profiles, Linear ids) through Terraform. A second installation
(Terros) made this concrete: every value it needs would have meant another installation's ids
checked into shared source.

## Decision

**Identity and configuration are separate, and both live in the installation's own AWS account.**

- **Identity** (`sgt init`, ADR-0040, unchanged): installation id, AWS account id, region, state
  bucket and environment name, in the `/sergeant/installation-identity` record. Created once by
  `sgt init --bootstrap`; never editable through `sgt config`.
- **Configuration** (`sgt config`): two plain-`String` SSM parameters, one per consumer.

  | Section | Parameter | Consumer |
  |---|---|---|
  | `runtime` | `/sergeant/<env>/installation-config` (ADR-0026's parameter, same shape) | the daemon — `materialize-env.sh` at every boot/deploy, unchanged |
  | `infrastructure` | `/sergeant/<env>/infrastructure-config` | Terraform, through the wrapper |

  Runtime keys are `SERGEANT_*` daemon variables (Linear/GitHub ids, Secrets Manager references,
  worker profiles). Infrastructure keys are exactly the Terraform root's variables, JSON-typed; a
  test holds the CLI's key table to `deploy/terraform/*.tf`. Worker profiles and other runtime
  settings never pass through Terraform.
- **The repository allow-list** is configuration too, so `sgt config repo
  add|list|show|enable|disable|remove|set-purpose` manages it; `sgt admin repo` is an alias. It
  stays where it lives — the daemon's `managed_repositories` table (ADR-0029), reached over SSM —
  because enrollment has its own lifecycle. It is never copied into the SSM document.

**`sgt config show|diff|set <installation>`** (`crates/sergeant-cli/src/commands/config/`).

- Each command first runs `sgt init --check`'s verification, so wrong-account credentials read and
  write nothing.
- `diff` previews a change: `KEY=VALUE`, `--unset KEY`, or `--file` for a whole document.
- `set` shows the same diff, requires confirmation (`--yes` is required without a terminal), and
  writes only the sections that changed.
- `set` refuses identity keys, unknown keys, mistyped values, line breaks in runtime values,
  retired single-repo keys, and any section over SSM's 4 KB limit. It runs these checks on the
  whole resulting document, including keys the change did not touch.
- **References only, never credentials.** A runtime key whose name marks a literal credential
  (`…_TOKEN`, `…_SECRET`, `…_KEY`, `…_PASSWORD`, `…_CREDENTIAL(S)`) is refused, from an edit or a
  `--file`, before any diff is rendered, so the value is never echoed or stored in plain SSM text.
  This covers the daemon's development fallbacks such as `SERGEANT_LINEAR_API_TOKEN` and
  `SERGEANT_OPENAI_API_KEY`. Their `…_SECRET_ID`/`…_SECRET_REF` reference forms are accepted.
- With public ingress on, `SERGEANT_PUBLIC_BIND_ADDR` must equal `127.0.0.1:<public_api_daemon_port>`.
  This cross-check was a Terraform precondition; Terraform no longer sees runtime configuration,
  so `sgt config set` enforces it.
- **The host's public hostname** is runtime configuration: `SERGEANT_PUBLIC_API_HOSTNAME`,
  required with public ingress and equal to Terraform's hostname (`public_api_hostname`, else the
  `dns_zone_name` apex). `deploy/host/install.sh` reads it from the materialized configuration at
  every deploy, ahead of the first-boot `host.env` value. A host launched before UNF-655 therefore
  needs no replacement, and the installer no longer carries one installation's hostname as a
  fallback.

**Worker-profile tokens** go through `sgt config claude-profile <installation> <name>`. It reads
the token from stdin only, stores it in the installation's own Secrets Manager as
`sergeant/<env>/claude-profile-<name>-token`, and adds the profile to `SERGEANT_CLAUDE_PROFILES`
through the same validated, confirmed, versioned write. Re-running it rotates the token. It
replaces `scripts/push-claude-profile-token.sh`, which hardcoded one installation. On a host,
`sgt doctor` checks that each profile's secret is under that installation's own prefix.

**Auditability is `show`/`diff` + confirmation + SSM version history.** Every write is a new
parameter version. `set` checks that it landed as exactly the next version after the one it
diffed against, and reports a concurrent writer if not. There is no Git-style approval workflow.

**Terraform consumes generated inputs.** `deploy/scripts/terraform-installation.sh` renders one
tfvars JSON per run from two sources (`terraform_inputs_lib.sh`): the identity verified by
`sgt init --check`, and the `infrastructure` section from `sgt config show --json`. The file goes
in a temp directory outside the Terraform root and is passed with `-var-file`. The wrapper refuses
to run when the configuration is missing or invalid, or when the configuration tries to set an
identity variable. `plan --config-file <doc>` plans a proposed document without writing it.
`environment`, `aws_account_id` and `aws_region` have no defaults, so nothing in the repository
names an installation.

**Terraform releases the runtime parameter without destroying it.** The
`aws_ssm_parameter.installation_config` resource is replaced by `removed { lifecycle { destroy =
false } }`. The next apply drops it from state and leaves the parameter, its value and its history
in AWS. The block stays until every installation has applied past it. The instance role's and the
CI role's exact-ARN read grants are unchanged.

## Consequences

- The repository holds no installation's values. A fresh clone plus `sgt init <installation>`
  can plan, and a new installation is brought up with `sgt init --bootstrap`, `sgt config set` and
  plan/apply alone (`docs/runbooks/sergeant-installation-init.md`).
- Changing an installation is an operator action against AWS rather than a PR. The diff, the
  confirmation and SSM's version history replace code review for these values.
- CI no longer compares the live parameter with a checked-in desired state, because there is none.
  The daily SSM smoke test checks that the live runtime configuration parses and materializes, and
  the `terraform` job plans the example document (`deploy/terraform/examples/`) rendered through
  the wrapper's own input generator.
- Moving Personal is a one-time, captain-run migration: seed `infrastructure-config` from the last
  checked-in tfvars, then apply the ownership flip. The runbook has the exact commands and the dry
  run.
- **No installation values in executable paths.** The CI/CD target this repository deploys to now
  comes from GitHub repository variables (`SERGEANT_CD_*`), not workflow files. That target is the
  region, deploy bucket, instance, environment, and release GitHub App id/key secret.
- **Operator scripts resolve their installation.** `deploy.sh --installation`,
  `push-codex-profile-auth.sh` and `push-github-app-private-key.sh` resolve the environment,
  region, AWS profile and bucket of an installation connected with `sgt init` through
  `sgt config show` (`deploy/scripts/installation_lib.sh`). None of them has defaults any more.
- **Remaining Personal names are records, not configuration.** Historical ADRs, dated runbook
  records, reports and synthetic test fixtures still name Personal.

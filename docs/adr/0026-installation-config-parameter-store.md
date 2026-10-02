# ADR-0026: AWS Systems Manager Parameter Store as the durable installation-config source

## Status

Accepted; partly superseded by ADR-0042 (UNF-689). The parameter, its shape and how the instance
materializes it stand. Terraform (`var.installation_config`, checked-in tfvars) no longer writes
it: `sgt config set` does, and SSM version history is its audit trail. The text below is the
original decision.

Originally accepted. Terraform/`terraform plan` and unit-tested Rust/shell logic only — live `terraform
apply`, real Parameter Store population, and a real EC2-replacement rebuild are
`[NOT YET EXECUTED]` (UNF-395's own sandbox constraint; see the runbook pointers in "Consequences"
below for the real-instance rollout this still needs).

## Context

UNF-389 was a one-time manual recovery after `/etc/sergeant/sergeant.env` was lost on an EC2
rebuild: every non-secret installation override (Linear team/agent/captain ids, GitHub App
id/installation id, Claude/Codex profile strings and their embedded Secrets Manager references,
the S3 artifact bucket name) had to be re-typed by hand from memory/docs, because that one file on
that one root volume was the only copy. `deploy/host/sergeant.service`'s `EnvironmentFile=-...`
(leading `-`) made this worse in a second way: a missing file doesn't fail the unit, it just starts
the daemon with every optional integration silently disabled — the exact failure mode UNF-389
actually hit was invisible until someone noticed Linear/GitHub weren't working.

None of these overrides had anywhere else to live. `deploy/terraform/variables.tf` /
`terraform.tfvars.example` never grew fields for them (only infra-shape values like
`release_s3_key`, `deploy_bucket_name`, instance sizing). Terraform-derived values (S3 bucket name,
data volume id, log group name, environment name, region) already flow cleanly through
`ec2.tf`'s `templatefile()` call into `/etc/sergeant/host.env` at first boot — that mechanism
works and isn't the problem. The problem is specifically the small set of values Terraform doesn't
compute and has no natural place to put: an operator's one-time choices (which Linear team, which
GitHub App, which named Claude profiles) that must still survive an EC2 replacement without
re-entry.

## Decision

**AWS Systems Manager Parameter Store is the durable, AWS-owned home for these overrides — not a
new config service.** One parameter for the whole map — `jsonencode(var.installation_config)`, a
single JSON object — named `/sergeant/<environment>/installation-config`
(`deploy/terraform/ssm.tf`'s `aws_ssm_parameter.installation_config`, driven by a generic
`map(string)` variable, `var.installation_config`) — plain `String` type, never `SecureString`,
because everything that belongs here is non-secret by construction: an id, an app id, a profile
spec string, or a `*_SECRET_ID`/`*_SECRET_REF` *pointer* into Secrets Manager. Raw credential
material never lands in Parameter Store; it stays exactly where it already lived, in Secrets
Manager, resolved by the daemon itself at its own startup (`crates/sergeant-daemon/src/secrets.rs`)
— this ADR changes nothing about that path.

One parameter for the whole map, not one parameter per key — an earlier version of this design did
the latter (`get-parameters-by-path --recursive` over an `/env/<key>` hierarchy) and a review round
on this same ticket flagged it as needless complexity for a map this small: a single
`aws ssm get-parameter` call, one exact-ARN IAM grant, no pagination/recursive traversal, and one
atomic update whenever the map changes, all while still being fully data-driven (neither
`ssm.tf` nor `materialize-env.sh` needs a code change to add or remove one override key).

**Terraform config (`var.installation_config`) is the desired state; the SSM parameter is the
durable runtime projection an EC2 replacement rebuilds from.** For the real Unforgotten
environment, that variable's value is set in `deploy/terraform/unforgotten.auto.tfvars` —
**checked into this repo**, not a gitignored `terraform.tfvars`. The same review round caught that
a gitignored, local-machine-only tfvars file would make whichever laptop happened to apply it the
single point of failure this whole ADR exists to eliminate — `sergeant.env`'s original problem,
just relocated one layer up. Since every value here is non-secret by construction (see above),
committing it costs nothing security-wise; Terraform auto-loads any `*.auto.tfvars` file (no
`-var-file` flag needed), so this changes nothing about how `terraform apply` is invoked.
`terraform.tfvars` (still gitignored) remains where genuinely local/per-operator values like
`aws_profile` belong. First boot/deploy (`deploy/host/materialize-env.sh`, called by
`deploy/host/install.sh`) always reads the parameter live via one `aws ssm get-parameter` call —
it survives an EC2 replacement (which never touches Terraform state or this parameter, only the
instance) without needing `terraform apply` re-run at replacement time.

**Every value round-trips through the fetch/write pipeline as its exact original bytes — two
successive review-round bugs on this same value-safety path, both caught and fixed.** The pure
JSON-to-EnvironmentFile-lines logic lives in `deploy/host/materialize_env_lib.sh`, sourced by
`materialize-env.sh`: each key/value moves through jq's own `@base64`/`@base64d` filters end to
end, never jq's `@tsv` (which textually escapes an embedded newline/tab as a literal
backslash-n/backslash-t rather than preserving it — so a newline-rejection check run *after* `@tsv`
formatting, as the original version of this script did, never actually sees a newline to reject)
and never the system `base64` CLI (whose decode flag differs between macOS/BSD `-D` and Linux/GNU
`-d`). Each rendered line double-quotes the value and backslash-escapes any embedded backslash or
double-quote — the C-style escaping systemd's own `EnvironmentFile=` parser documents support for.

**No newline or carriage return in a value is validated against the raw JSON text itself, before
any value is ever decoded into a bash variable at all** —
`materialize_env_lib.sh`'s `validate_installation_config_json`, run first thing inside
`installation_config_json_to_env`. This ordering is the actual fix, not incidental: bash's own
`value="$(decode_base64 ...)"` command substitution unconditionally strips a *trailing* newline the
moment a value is assigned to a variable (a second review round on this same ticket caught this —
a value like `"foo\n"` silently became `"foo"` before any bash-side check, including an earlier
version of this fix that only checked for *embedded* newlines post-decode, ever got a chance to see
it). Validating the untouched JSON text with `jq` directly — `type == "string" and (contains("\n")
| not) and (contains("\r") | not)` over every value — sidesteps bash's stripping entirely, since no
bash variable holds the value yet when the check runs. `render_env_line` keeps its own embedded-
newline check too, as defense in depth for any future direct caller, but
`installation_config_json_to_env` itself never lets an unvalidated value reach it.

`materialize_env_lib.test.sh` (pure-logic unit tests: normal values, quotes, backslashes, embedded
newline rejection, *trailing* newline rejection, carriage return rejection, non-string-value
rejection, malformed JSON) and `materialize-env.test.sh` (an integration test with a fake `aws`
stub on `PATH`, proving a failed fetch or a rejected value — including a trailing newline — never
replaces an existing `sergeant.env` and leaves no temp file behind) cover this with no real
AWS/network access, mirroring `deploy/scripts/health_check_lib.sh`'s own lib/test split.

**`/etc/sergeant/sergeant.env` becomes a disposable, always-regenerated projection, matching the
ownership model the ticket's brief lays out** (Terraform/AWS installation config → non-secret
overrides and infra-derived values; Secrets Manager → raw credentials; the Sergeant DB → dynamic
runtime state; repo-owned `sergeant.toml` → repo/app/environment context; `sergeant.env` → a
generated artifact, never itself durable). `install.sh` regenerates it, in full, on every
boot/deploy — first by running `materialize-env.sh` (the Parameter-Store-sourced overrides), then
appending `SERGEANT_S3_BUCKET` from `host.env` (Terraform-derived — see below), so deleting the
file and rebooting or re-running `install.sh` reconstructs it with no manual step.

**Terraform-derived values (S3 bucket name, environment name, region, and installation discovery
itself) are generated through the existing `host.env` mechanism, not duplicated through Parameter
Store.** `ec2.tf`'s `templatefile()` call already passes `environment`/`aws_region` to
`user_data.sh.tpl`; this ADR adds `s3_bucket` (`aws_s3_bucket.sergeant_artifacts.bucket`) alongside
them and has `user_data.sh.tpl` write all three into `host.env` as `ENVIRONMENT`, `AWS_REGION`, and
`S3_BUCKET`. `ENVIRONMENT`/`AWS_REGION` double as *installation discovery*: what
`materialize-env.sh` needs to find the right SSM parameter at all, itself Terraform-generated
rather than an operator typing the environment name into yet another manual file.

**Startup fails loudly, not silently, when materialization itself fails.**
`materialize-env.sh` runs under `set -euo pipefail`; any AWS error (unreachable SSM, a permission
error, a bad region) aborts it non-zero, which aborts `install.sh` (same flags) before it ever
reaches `systemctl restart sergeant` — a broken materialization can never leave the daemon running
against stale or missing config. `sergeant.service`'s primary `EnvironmentFile=` now has no leading
`-`: since `install.sh` guarantees the file exists before every service (re)start, a missing file
at unit-start time means materialization was skipped or failed, not "nothing configured yet," and
systemd now fails the unit loudly (visible in `journalctl -u sergeant`) instead of quietly starting
with every optional integration disabled. This is a real behavior change from the prior
`EnvironmentFile=-...` nonfatal-missing pattern, deliberately: a config file silently treated as
optional is exactly what let UNF-389's loss go unnoticed.

**Single-repository settings stay out of Parameter Store, deliberately.**
`SERGEANT_REPO_ROOT`, `SERGEANT_GITHUB_OWNER`, `SERGEANT_GITHUB_REPO`, and
`SERGEANT_LINEAR_PROJECT_ID` are excluded from `var.installation_config` (a Terraform `validation`
block enforces this) because UNF-394 (multi-repo routing) removes the whole single-repo assumption
they encode — durable AWS storage for values expected to disappear soon is exactly the kind of
scope this ADR's own "don't copy every `SERGEANT_*` variable" rule warns against. They still need
somewhere to live until UNF-394 lands: a second, always-optional (`EnvironmentFile=-`)
`/etc/sergeant/sergeant.local.env`, which `install.sh`/`materialize-env.sh` never write or touch —
a manual escape hatch matching exactly today's hand-edit workflow, scoped down to only the values
that are actually expected to keep needing it.

**Not built:** a general config framework or config service (this is one flat key-value map with
no schema, no layering rules beyond "two `EnvironmentFile=` lines, later wins," and no code needed
to add a new key), remote/clustered Parameter Store access patterns, or any change to the daemon's
own `SERGEANT_*` environment-variable interface (`crates/sergeant-daemon/src/config/`) — this ADR
only changes where those values are sourced and regenerated from, per the ticket's own
simplification boundary.

## Consequences

- Replacing the EC2 instance (`terraform apply` after the documented UNF-250 procedure, or simply
  replacing the instance without re-applying at all — the SSM parameter already holds the right
  values from whenever it was last set) now reconstructs `/etc/sergeant/sergeant.env`
  automatically at first boot, with no manual recovery step and no dependency on the previous
  instance's root volume or anyone's memory of what the values were.
- `var.installation_config` is intentionally sparse: an environment that hasn't configured Linear
  or GitHub integration simply has fewer keys in the JSON object, and the daemon's own existing
  per-integration `Option`-returning resolvers (`linear_instance.rs`, `github_instance.rs`) still
  silently disable that one integration exactly as before — this ADR does not change that
  per-integration behavior, only the file-level "does `sergeant.env` exist and reflect durable AWS
  state at all" failure mode.
- The instance role gains one new narrowly-scoped IAM grant (`ssm:GetParameter` on the exact
  `arn:...:parameter/sergeant/<environment>/installation-config` ARN, `deploy/terraform/iam.tf`'s
  `ReadInstallationConfig` statement) — read-only, scoped to exactly this one parameter, mirroring
  the existing `ReadEnvironmentSecrets` Secrets Manager grant's shape.
- `sgt doctor` can now verify a rebuilt installation
  (`crates/sergeant-cli/src/commands/doctor/installation_config.rs`): it confirms
  `/etc/sergeant/sergeant.env` exists and reports how many overrides it holds, the on-host signal
  that materialization actually ran and succeeded.
- `deploy/terraform/unforgotten.auto.tfvars` is checked into this (private) repo with the real,
  already-public-elsewhere-in-this-repo values (GitHub App id/installation id, the deterministic
  Secrets Manager reference names, the `claudePersonal` profile spec) filled in; the Linear
  team/agent/captain user ids remain genuinely unset there (no code or checked-in doc has ever
  recorded a real value for them — they're looked up live from Linear when that setup runbook
  actually runs), documented in that file's own top comment rather than filled with placeholders.

## What this ticket does not attempt

Per UNF-395's own sandbox constraint: no `terraform apply` was run, no real Parameter Store
parameter was created or read, and no real EC2 instance was touched. Everything above is verified
by `terraform validate`/`terraform plan` review, shellcheck, and unit tests against fakes/mocked
AWS clients (including three review-driven fixes across two review rounds — the single-JSON-
parameter simplification, the `@base64`/`@base64d` value-safety fix, and the follow-on trailing-
newline fix a second round caught in the first fix's own remaining gap — each re-verified with new
shell tests after the fix, not just re-reviewed). A real rollout still needs: filling in the
still-pending Linear ids in
`deploy/terraform/unforgotten.auto.tfvars`, one `terraform apply`, and then proving the full loop —
stop the real instance, replace it, confirm `sgt doctor` reports a healthy rebuilt installation —
against the real Unforgotten environment, outside this worktree, with firstmate/captain driving it
explicitly.

# ADR-0016: Sergeant Unforgotten EC2 infrastructure (UNF-207)

## Status

Accepted.

## Context

Sergeant had no provisioned infrastructure of its own yet — `deploy/host/sergeant.service` documented
the intended systemd shape (ADR-0002) but nothing installed or ran it anywhere. UNF-207 asked for
one dedicated Unforgotten EC2 instance to actually run the `sergeant serve` daemon, consuming
UNF-206's immutable CI release artifact, with a real (not just described) backup/restore procedure
and a real, tested toggle-off path — this is the first real AWS spend and security surface Sergeant
has.

The captain corrected the ticket mid-flight after initial dispatch (see the PR description for the
exact wording) on several points reflected in the decisions below: single instance only (no
stage/prod topology yet), boring EC2 + systemd over any container platform, a single EBS volume
rather than split root/data volumes, and confirmation that no public webhook ingress exists yet to
carve a security-group exception for. After a direct review of the resulting PR, the captain gave a
further correction: this is **Unforgotten's one Sergeant environment**, not a "staging" tier —
UNF-207 was explicitly reworded from "a staging environment" to "the single Sergeant environment
for Unforgotten." Terros may get its own separate stage/prod topology later; that remains out of
scope here. This ADR (and `var.environment`'s default) uses `unforgotten` accordingly — earlier
"staging" naming in this repo's history was the pre-correction framing, not a second environment.

## Decisions

- **Terraform**, one stack, one environment (`unforgotten`), under `deploy/terraform/`. Its
  plan/apply/destroy lifecycle is a direct, reviewable answer to "a way to turn it off" — see
  `docs/runbooks/sergeant-unforgotten-ec2.md`'s "Turning this off" section. No remote state backend
  is configured; this is a single-operator environment and adding one is a small follow-up once
  more than one person needs to run this stack.
- **Instance: `m6g.xlarge`** (Graviton2/arm64, 4 vCPU, 16 GiB RAM, non-burstable). Sized per the
  ticket's 4 vCPU/16 GB requirement. arm64 was chosen (over an x86_64 equivalent like
  `t3.xlarge`/`m6i.xlarge`) because UNF-206's CI already builds an `aarch64-unknown-linux-gnu`
  artifact (later changed to `aarch64-unknown-linux-musl` — see
  `docs/adr/0023-static-musl-release-binary.md`; the "statically-compiled" assumption a few words
  below was true of neither at the time this ADR was written, and that gap is exactly what UNF-259
  fixed) — the CI workflow's own comment noted the architecture choice was left open pending this
  ticket — and Graviton instances are meaningfully cheaper per vCPU/GB with no downside for a single
  statically-compiled Rust binary with no arch-specific dependency. Non-burstable (`m6g`, not
  `t4g`) was chosen over the cheaper burstable family because the daemon's supervisor/scheduler/
  reconciliation loops (ADR-0002) poll continuously rather than bursting, and this environment
  running out of CPU credits mid-test is a worse failure mode than the modest extra cost.
- **Single encrypted EBS volume**, not split root/data — per the captain's correction, V1 keeps
  this simple: one `gp3` volume, `encrypted = true`, sized by `var.root_volume_size_gb` (default
  50 GB), holding both the OS and `/var/lib/sergeant` (created as a directory on it, not a separate
  mount). Revisit only if a real capacity/IOPS need for `/var/lib/sergeant` specifically ever
  emerges.
- **IAM instance role scoped to exactly two things**: `secretsmanager:GetSecretValue`/
  `DescribeSecret` on the `sergeant/<env>/*` Secrets Manager namespace — a `local` derived from
  `var.environment` (`main.tf`), not an independently-defaulted variable, so it can't drift out of
  sync with the environment identity — matching the `secrets-manager://sergeant/<env>/...`
  `credential_ref` convention already documented in `docs/security/threat-model.md` §8 (granting
  read access ahead of any caller actually resolving a secret is provisioning the already-documented
  target design, not building an unbuilt Sergeant subsystem), and `s3:GetObject`/`ListBucket` on
  this environment's deploy-artifact bucket's `releases/` prefix (how the instance pulls UNF-206's
  binary — see below). Neither grant is broader than that. `AmazonSSMManagedInstanceCore` is
  attached for Session Manager only. No access to ADR-0010's `sergeant-artifacts-<env>` run-artifact
  object store is granted — nothing in the currently-running daemon calls it yet, so granting it
  here would be broader than what this deployment needs.
- **A dedicated `sergeant-deploy-<env>` S3 bucket**, distinct from ADR-0010's
  `sergeant-artifacts-<env>` run-artifact store, holding release tarballs mirrored from UNF-206's
  GitHub Releases by an operator (`scripts/publish-release-to-s3.sh`, run with both `gh` and AWS
  credentials). The instance only ever reads from this bucket via its scoped instance role — it
  never holds a GitHub credential, so the release artifact still reaches the box with zero
  long-lived secrets embedded anywhere. Versioned, with `force_destroy = true`: the bucket only
  mirrors content whose real source of truth is GitHub Releases, so losing it on a deliberate
  `terraform destroy` loses nothing irreplaceable, and the captain's "a way to turn it off"
  requirement needs `destroy` to actually complete in one command rather than refusing on a
  non-empty versioned bucket.
- **No public ingress.** The security group has zero ingress rules; all administrative access is
  `aws ssm start-session`/`send-command`. Investigated whether a public webhook receiver exists to
  carve an explicit exception for (the captain's correction asked for this check): it does not —
  `crates/sergeant-daemon/src/http/mod.rs` serves only `/health` and the internal Task/Run query API
  (UNF-211); Linear integration (`linear::reconcile`) polls Linear rather than receiving webhook
  pushes. So no exception was added. If a verified webhook receiver is built later, add it as its
  own narrowly-scoped `ingress` block, not a general opening.
- **AWS Data Lifecycle Manager**, not AWS Backup, for automated snapshots. DLM is a narrower,
  purpose-built EBS-snapshot scheduler with a simpler IAM/resource footprint (one policy, one
  service role) than AWS Backup's vault/plan/selection model, which is built for many resource
  types across an org — more machinery than one volume needs. Revisit if Sergeant grows more
  resource types worth backing up under one shared policy.
- **Deploys go through `scripts/deploy.sh` over SSM `send-command`**, never by re-applying
  Terraform with a new `user_data`: changing `user_data` only takes effect on instance replacement
  (`user_data_replace_on_change = true`, deliberately, so that path is reserved for
  bootstrap-script changes, not routine version bumps). UNF-611 later made `aws_instance.sergeant`
  `ignore_changes = [user_data]`, so a user_data change never replaces the instance by itself:
  replacement is always an explicit `-replace=aws_instance.sergeant`, and the boot-time
  `release_s3_key` can be kept current without one. The deploy script fails loudly (non-zero
  exit) on a failed post-deploy `/health` check rather than reporting success, and preserves the
  actual response body on a non-2xx health response (rather than `curl -f` discarding it) so a real
  degraded status is diagnosable from the SSM output alone, not just distinguishable from "not
  listening yet" — see `deploy/scripts/deploy.sh` and `deploy/scripts/health_check_lib.sh` (the pure
  JSON-evaluation logic, unit-tested in `health_check_lib.test.sh` without needing AWS access).
  After that health check succeeds, the same deployment boundary extends the artifact's existing
  `PROVENANCE.json` with the target instance's actual AMI id (read from IMDSv2), instance id,
  immutable release S3 key, and deployment time. It installs that record beside the binary and
  emits it to the SSM/GitHub Actions log, preserving both the current deployment and its historical
  deployment event without changing how Terraform selects or pins the AMI.

## Consequences

- Standing this up for real, testing the restore procedure, and tearing it down are all live-AWS
  actions that could not be executed from this ticket's sandboxed implementation environment (no
  AWS credentials available there by design) — `docs/runbooks/sergeant-unforgotten-ec2.md` documents
  the exact commands for someone with real `lifeDev` credentials to run and confirm. Until that
  happens, treat the Terraform as validated by `terraform fmt`/`validate` and structural review,
  not as proven against real AWS.
- A second environment (Terros stage/prod) is explicitly out of scope here; when it's needed, the
  environment-scoped naming/tagging already in place (`var.environment`, `sergeant-<resource>-<env>`)
  should make a second stack a parameterization exercise, not a redesign.

## Amendment (UNF-236)

UNF-236 added a verified `POST /webhooks/linear` receiver, so the "Linear integration polls rather
than receiving webhook pushes" premise above no longer holds at the application layer. The
infrastructure decision itself is unchanged: `deploy/terraform/`'s security group still has no
public ingress, since exposing the new endpoint is its own explicit follow-up (tracked in
`docs/runbooks/sergeant-linear-agent-integration.md`), not done as part of UNF-236. Add the
narrowly-scoped `ingress` block this ADR anticipated when that follow-up lands.

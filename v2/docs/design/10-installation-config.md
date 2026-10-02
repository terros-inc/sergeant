# 10 — Installation and configuration

Sergeant 2 keeps the installation model the captain chose recently, unchanged in mechanism:

- **Identity** in the installation's own AWS account, created once by `sgt init --bootstrap`
  (ADR-0040).
- **Configuration** in that account's SSM, managed by `sgt config show | diff | set` with
  confirmation and SSM version history (ADR-0042, UNF-689).
- **No named installations in source.** Personal and Terros use the same code and the same mechanism.
- **The repository publishes releases; installations pull them** with their own credentials, by
  policy (`manual | every-release | soak`) and with yanking (ADR-0043, UNF-637).

This document defines only what Sergeant 2 needs from configuration. The shape is
`InstallationConfig` in `01`.

## 1. Identity (unchanged)

`/sergeant/installation-identity`: installation id, environment, account, region, state bucket,
endpoint. Immutable. Every `sgt` command that touches an installation first verifies the caller's
AWS credentials resolve to that account (`sgt init --check`).

## 2. Configuration keys

The runtime configuration document holds Sergeant 2's `InstallationConfig` (01). Grouped:

| Group | Keys | Notes |
|---|---|---|
| Linear | workspace, agent user, allowed teams, ops team, OAuth client ref, webhook secret ref | intake admits only allowed teams |
| GitHub | control-plane App (id, installation ids, key ref), worker App (same), webhook secret ref | two Apps per installation (08 §1); never shared across installations (ADR-0017's rule) |
| Repositories | slug, purpose, enabled, merge policy, merge method, always-review paths | `sgt config repo add\|set\|enable\|disable\|remove` |
| Runner profiles | name, adapter, provider, model, roles, max concurrent, settings, pricing | worker credentials (subscription tokens) go through `sgt config claude-profile` and its siblings, stdin-only, into Secrets Manager (ADR-0042, kept) |
| Defaults | budget (about 2 h active wall time, hard; about $25 per task, best-effort; soft 0.8, grace 10 min, reasoning reserve $2, 2 concurrent reviewers, 6 starts/hour); profile per role (worker, reviewer, audit reviewer) | both budget numbers configurable per installation |
| Limits | max open tasks, max concurrent runs, max concurrent turns | |
| Runners | reconcile interval (60 s), idle/unreachable wake (20 min) | 04 §6 |
| Reasoning | model, max turn cost and seconds, max sleep, session mode, compaction threshold | |
| Review | audit sample rate (default 0.2), review-quality budget per day | 06; subagent reviews never count until the captain decides (06 §5) |
| Follow-ups | max per task, max depth, auto-delegate | |
| Human waits | remind after hours | |
| Approvers | Linear user ids | budget grants, waivers, escalations |
| AWS | runner dev role ARN, artifact bucket, CloudWatch log group | |
| Release | upgrade policy, soak hours | ADR-0043 |

`sgt config set` validates the whole resulting document: unknown keys, types, references only (no
literal credentials, as ADR-0042 already enforces), repository slugs well-formed, profiles naming
known adapters, default profiles existing and supporting their role, approvers non-empty.

Removed compared with Sergeant 1's runtime keys: retry, fix, rethink, and deep-assurance budgets;
phase and preflight settings; planner and test-run settings; capability and tool authorizations;
Jev's authoritative flag. None of those concepts exist.

## 3. Not configuration

- **Prompts and rules** (Sergeant's prompt, worker rules, reviewer rules) are code, versioned with the
  release and recorded on every turn and run.
- **Per-task budgets** come from defaults at admission; only approver grants change them.
- **Repository build/test/topology**: not Sergeant's concern. Workers read each repository's own
  `AGENTS.md` and README. S1's `sergeant.toml` is not carried over (13).

## 4. Setting up an installation

```
sgt init <name> --bootstrap                       # identity, state bucket (unchanged)
sgt config set <name> --file sergeant2.json       # Linear, GitHub Apps, profiles, defaults, approvers
sgt config claude-profile <name> <profile>        # worker model tokens, stdin only
sgt config repo add <name> <slug> --purpose "..." --merge-policy sergeant|human
sgt doctor repo <name> <slug>                     # enrollment checklist (08 §2)
terraform via the existing wrapper                # host, roles (control plane, runner dev role), bucket, log group
sgt admin upgrade <name>                          # pull a release (ADR-0043)
```

Infrastructure additions over Sergeant 1: the runner dev role (with its permission boundary) in the
dev/stage account, the `sergeant-runner` OS user and its metadata block on the host, and the
CloudWatch log group. Each is generic Terraform/host configuration driven by the installation's
infrastructure config, so no installation is named in source.

## 5. A local installation for the transition

Transition step 4 (13 §5) runs Sergeant 2 on the captain's laptop against selected Personal work.
This uses the same mechanism with a different identity, so nothing about it becomes a permanent
special case:

- A separate installation identity (for example `personal-v2-local`) with its own SSM config,
  artifact bucket, and a ledger file on the laptop. ADR-0040 allows one installation per AWS
  account and region, so it lives in a second region of the Personal account (or a small separate
  account), not beside Personal V1's identity record.
- Its **own Linear agent app user** (for example "Sergeant 2"), so the captain chooses which issues
  go to V2 by delegating them to it, and V1 never sees them. Its own two GitHub Apps, installed only on
  the selected repositories.
- Runs execute in a container on the laptop, receiving only vended credentials. They must not run as
  the captain's own user account, whose home holds personal credentials: personal credentials are on
  the hard-boundary side (09 §3). One container for the runner zone is enough; per-run
  containers are not required.
- When V2 replaces V1 on the Personal EC2 installation (step 6), the Personal installation's config
  is rewritten for V2 with `sgt config set`, and the temporary local identity is retired.

## 6. Where the code and releases live (settled)

UNF-700 (captain): Sergeant 2 is an isolated `v2/` TypeScript workspace in the existing Sergeant
repository (Turborepo with pnpm, oxlint, Vitest), with its own path-filtered CI; V1's CI skips `v2/**`.
V2 releases are published from that workspace under distinct tags so an installation pulling V1 releases
never picks one up; Personal's upgrade policy is set to `manual` before the first V2 release (13 §5).

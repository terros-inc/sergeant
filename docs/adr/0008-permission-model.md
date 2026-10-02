# ADR-0008: Principal/connection/grant permission model

## Status

Accepted.

## Context

ADR-0004 established `Organization` as the tenant boundary but explicitly
deferred "permission grants, principals, or any access-control narrower than
'belongs to this organization'" as future work, since UNF-192 had nothing
yet that consumed it. UNF-194 is that future work: it must define, before
any real unattended provider credentials exist, how Sergeant tells "this org
member" apart from "this org member is allowed to do this specific thing to
this specific resource" — see `docs/security/threat-model.md` for the full
trust model.

## Decision

Add `crates/sergeant-core/src/domain/permissions.rs`: pure logic, no I/O,
mirroring `state_machine.rs`'s shape rather than `tasks.rs`'s (no
SQLite persistence yet — see the threat-model doc's "what this implements
vs. defers"). It defines:

- `Principal` (`human` / `service` / `worker`), `organization_id`-scoped.
- `Connection`: a scoped link to exactly one external account
  (`provider` + `external_account_label` + `credential_ref`), never a
  global "the GitHub credential" for the org — so two connections to the
  same provider (two Linear workspaces, a personal-vs-automation GitHub
  identity) stay distinct.
- `CredentialRef`: a pointer into the secret store (AWS Secrets Manager —
  see the V1 runtime security posture), never a raw secret value.
- `Grant`: `action` (a plain `String`, not a closed enum — actions like
  `destructive.production.drop-table` are caller-defined) granted to a
  `principal_id`, constrained by a `GrantScope` (repo/application/
  environment/connection).
- `authorize()`: default-deny. Org mismatch is checked first and denies
  unconditionally. Otherwise a matching `Grant` (same org, same principal,
  same action, scope covers the request) is required, and any action
  identified by `is_production_action` (`deploy.production`,
  `destructive.production`, or anything prefixed `destructive.`)
  additionally requires `explicit_approval` on at least one scope-matching
  grant — evaluated across all of them, not just the first found, so grant
  order can never decide the outcome.

`explicit_approval` is required uniformly regardless of principal kind, not
carved out for `worker` only — see the threat-model doc's open-questions
section for why.

## Consequences

- Org membership alone still never implies access — `authorize()` cannot
  return `Allowed` without an actual `Grant`, closing the gap ADR-0004 left
  open.
- Because `Grant`/`Connection`/`Principal` aren't persisted yet, nothing in
  this crate currently constructs them outside tests. Wiring a real caller
  (an API surface, a worker-dispatch check) is deferred, same as ADR-0004
  deferred this ticket — the next consumer adds the SQLite table(s) and
  loader, not a redesign of these types.
- `redact()` (`crates/sergeant-core/src/redaction.rs`) is the companion
  primitive for `docs/security/threat-model.md#9` (secrets must not persist
  in logs/transcripts); it has no dependency on `permissions.rs` and is now
  wired into the object-storage upload path independently (UNF-202, see
  `docs/adr/0010-object-storage.md`).

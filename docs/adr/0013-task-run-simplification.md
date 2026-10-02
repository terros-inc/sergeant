# ADR-0013: Simplify the domain model to Task/Run, drop organization tenancy and the generic task-system abstraction (UNF-226)

## Status

Accepted. Partially superseded by [ADR-0014](0014-repo-owned-topology-config.md) (UNF-233): the
Repository/Application/Environment SQLite tables this ADR restructured were removed entirely in
favor of repo-owned `sergeant.toml` config and an immutable resolved-context snapshot on `Run`.
Partially superseded again by
[ADR-0031](0031-coding-v1-task-lifecycle-integration-ownership-waits-and-workspace-retention.md)
(UNF-470), only for this ADR's claim that Sergeant need not persist workflow stage. Coding V1 now
persists a fixed Task phase separately from the still-collapsed Task state. Everything else here
(Task/Run rename, four execution-disposition states, open `role`/`provider` strings, removed
organization tenancy, removed generic task-system adapter, removed `watchers` table) is unaffected
and remains the current design.

## Context

UNF-192 (the walking skeleton), UNF-214 (scope hierarchy), and UNF-196 (task-system adapters)
each built out a piece of a fuller control-plane design: organization-scoped multi-tenancy on
every table, a Project→Repository→Application/Environment scope hierarchy with a polymorphic
`ExecutionTarget`/`WorkItemScope` join layer, and a generic `TaskSystemAdapter` contract with its
own connection/external-reference/idempotency-ledger tables so Sergeant could in principle talk
to more than one task-tracking system.

In practice, real usage clarified that most of this was premature:

- Sergeant V1 runs one independent server/database per organization. There is no multi-tenant
  deployment to isolate within a single database, so `organization_id` on every row was pure
  overhead — a column to join through and validate on every write, with no caller that needed the
  isolation it provided.
- Linear is, and is expected to remain, the only V1 task source. The generic multi-provider
  adapter contract (ADR-0012) — connections, external references, an idempotency ledger for
  outbound writes — was solving a problem ("more than one task system") nobody had yet, at the
  cost of a whole extra layer between a `Task` and the one external id it actually needs.
- The scope hierarchy's `Project` layer and the `ExecutionTarget`/`WorkItemScope` polymorphic
  joins (ADR-0011) existed to support flexible many-to-many targeting that nothing in `worker/` or
  the daemon's ticks ever actually resolved. A `Run` targeting a repository/application/environment
  directly, as plain optional columns, covers the same real need without the indirection.
- The detailed workflow states (`IMPLEMENTING`/`REVIEWING`/`FIXING`/`TESTING`/`HUMAN_VALIDATION`/
  `NEEDS_DECISION`/`READY_TO_MERGE`) and the `previous_state`-resume mechanism for `NEEDS_DECISION`
  were modeling human/review/test workflow that Linear already tracks. Sergeant only needs to know
  whether a Task is being worked on, paused, or finished — not which specific stage it's paused at.

The guiding principle going forward (from the Sergeant Architecture handoff doc): Sergeant should
strongly model only the runtime state it must itself persist, recover, reconcile, or enforce.
Everything else — human work coordination, decisions, review/test staging — lives in Linear.

## Decision

- Rename `WorkItem` to `Task`. Keep `Run` as `Run` (not renamed to "Assignment" — an earlier
  dispatch briefly used that name before the captain corrected it back).
- Collapse the detailed workflow states into four: `ACTIVE`, `WAITING`, `DONE`, `CANCELED`. There
  is no Task-level `FAILED`: an individual `Run` can fail while its `Task` stays `ACTIVE` (about to
  retry) or `WAITING` (paused for retry/recovery/human action) — only a deliberate decision to
  abandon the Task reaches `CANCELED`. A Task is created `WAITING`, not `ACTIVE`: Linear is the V1
  queue, and a materialized Task doesn't become `ACTIVE` until a `Run` actually begins work. Drop
  `previous_state`/`NEEDS_DECISION` entirely — `WAITING` is generic and always resumes to `ACTIVE`,
  never to a remembered sub-stage.
- `Run.role` and `Run.provider` become plain `String`, not closed enums (`RunRole`/`RunProvider`
  are removed). Adding a new role (`investigate`, `deploy`, ...) or a new provider never requires a
  schema or Rust enum change. Per-role target-kind enforcement in `create_run` goes away with
  `RunRole` — see the `ExecutionTarget` removal below.
- Remove `organization_id` from every table, and the `Organization` entity/table itself. V1 is one
  independent Sergeant server/database per organization; the database/deployment boundary is the
  tenant boundary now, not an app-layer-enforced column. (`permissions.rs`'s `Principal`/
  `Connection`/`Grant` types keep their own `organization_id` fields — they are pure, unpersisted
  logic per ADR-0008, unaffected by this removal, and out of this ticket's scope.)
- Remove `Project`, `ExecutionTarget`, and `WorkItemScope` entirely. `Repository`/`Application`/
  `Environment` survive as installation/context configuration, restructured into a strict
  single-parent chain: `Environment` belongs to exactly one `Application`, which identifies exactly
  one `Repository` (no many-to-many). `Run` gets plain, optional, unenforced
  `repository_id`/`application_id`/`environment_id` columns directly instead of an
  `ExecutionTarget` indirection row. `Environment` gains a flexible `config` blob for deploy
  configuration and AWS Secrets Manager references — never a raw secret value. None of this table
  set is assumed to be the long-term home for repository/application/environment topology; it may
  move to `sergeant.toml` or another repository-backed config source later without that being a
  permanent commitment made here.
- Remove the generic task-system adapter abstraction wholesale: `TaskSystemAdapter`,
  `TaskSystemConnection`, `ExternalWorkReference`, and the write-operation idempotency ledger (the
  entire `tasksystem/` module and its dedicated tests). Linear is the only V1 task source, so
  `Task.linear_issue_id` — the stable Linear issue UUID stored directly on the row, `None` for
  Sergeant-created internal runtime work — replaces the whole connection/reference graph. This
  ticket does not re-solve idempotent/safe outbound Linear writes or any needed integrity
  validation for the new model; that is explicitly deferred to UNF-227/UNF-229.
- Remove the `watchers` table. V1 only ever scheduled one durable timer per work item (the
  supervisor's recheck heartbeat), so it now lives directly on `tasks.next_check_at` — set by the
  supervisor tick when unset, cleared by the scheduler tick when due, both guarded the same way
  the old watcher table's pending/fired status was.
- (UNF-220, folded in here to avoid duplicate rebase churn across every id-generating call site)
  `new_id()` draws its random suffix from a 62-character alphanumeric alphabet (`0-9A-Za-z`)
  instead of nanoid's default alphabet, which can include `_`/`-` — ambiguous against the
  `<prefix>_` separator.
- No production data existed yet (per the captain's explicit direction, given after this ticket
  started), so this landed as a direct rewrite of the shipped `0001`-`0004` migrations rather than
  a forward data-migrating one. `migrations/0001_init.sql` now creates the Task/Run schema
  directly; `0004_repository_topology.sql` (renamed from `0004_scope_hierarchy.sql`) creates the
  simplified Repository/Application/Environment tables; `0005_tasksystem.sql` is deleted outright.
  This is a one-time exception to "never edit an already-shipped migration" (see `db.rs`), not a
  new standing practice.

## Consequences

- Core orchestration reads naturally as `Task -> Run(s)`, matching how the daemon and worker
  adapters actually use these entities.
- The core schema no longer pays an unused multi-tenant cost on every relationship.
- Provider and Run-role additions never require a Rust enum or schema change.
- `docs/adr/0004`, `0009` (partially), `0011`, and `0012` are superseded by this ADR; `0005` is
  narrowed but its core principle stands. Each carries its own status note pointing here; their
  historical context is left intact rather than rewritten.
- UNF-227 and UNF-229 own re-solving idempotent/safe outbound Linear writes for the new Task/Run
  model — this ADR deliberately does not attempt that. (Intra-model Task/Run cross-reference
  consistency — e.g. an Artifact's run_id must belong to its task_id — was later handled
  separately, narrowly, in UNF-232; see `domain::artifacts::upload_artifact` and
  `domain::runs::create_run`.)

## Amendment (UNF-227)

`state_machine::allowed_targets` now also allows `WAITING -> DONE`, in addition to the
`WAITING -> ACTIVE`/`WAITING -> CANCELED` this ADR originally specified. UNF-227's Linear
reconciliation can observe a delegated issue resolved directly by a human (they close it
themselves) while the local Task is `WAITING` on something unrelated (e.g. a separate human-decision
issue); that is a completion, not a reason to force a resume-to-`ACTIVE` detour first. See
`docs/adr/0012`'s status note and `crates/sergeant-core/src/linear/` for the reconciliation logic
this addition serves.

# ADR-0012: Task/work-system adapters are pluggable, sync, and connection-scoped

## Status

Superseded by [ADR-0013](0013-task-run-simplification.md) (UNF-226). The generic adapter
contract, `TaskSystemConnection`, `ExternalWorkReference`, and the write-operation idempotency
ledger described below were all removed — Linear turned out to be the only V1 task source, so
`Task.linear_issue_id` (a plain optional column) replaced the whole abstraction. Re-solving
idempotent/safe outbound Linear writes for the new model is UNF-227/UNF-229's job, not a
resurrection of what this ADR describes. The context below is kept for history, not as the
current design.

## Context

UNF-196 turns ADR-0005's principle ("external task systems are adapters,
not core identity") into a real, tested module: `ExternalWorkReference`
and a Linear adapter, without letting Linear's own types or ids become
part of `domain/`. The design doc's requirement is that a `WorkItem` may
reference several external systems at once (a Linear issue and the
Intercom conversation that prompted it, say), that authentication is
scoped per connected account rather than globally per provider
(`docs/security/threat-model.md#5`), and that retries never duplicate a
comment, a created task, or a reference.

## Decision

**Schema** (`crates/sergeant-core/migrations/0005_tasksystem.sql`):

- `task_system_connections`: one row per connected provider account/
  workspace, `UNIQUE (organization_id, provider, external_account_label)`.
  Shaped like `domain::permissions::Connection`
  (`docs/security/threat-model.md#5`) but is its own persisted,
  task-system-scoped table rather than a shared cross-domain `connections`
  table — `permissions::Connection` itself is still in-memory-only
  (persisting it is deferred "until a real caller needs it"), and building
  a table serving every external-system domain (CI, cloud, task systems)
  before a second domain actually needs one would be speculative. `config`
  is opaque, non-secret, provider-specific JSON (e.g. a default Linear
  team id); `credential_ref` is a secret-store pointer, never a raw value.
- `external_work_references`: the many-per-`WorkItem` link to one item in
  one connection, `UNIQUE (connection_id, external_type, external_id)`.
  This is what makes "does this Linear issue already have a `WorkItem`"
  answerable without a Linear-issue-id column on `work_items` itself.
- `task_system_write_operations`: an idempotency ledger keyed by
  `(connection_id, idempotency_key)`. A caller-supplied key lets a retried
  outbound write short-circuit to the first attempt's cached result
  instead of calling the adapter (and therefore the external system)
  again.

**`tasksystem::adapter::TaskSystemAdapter`** is the provider-neutral
contract (`fetch_work`/`create_work`/`add_comment`/`update_status`/
`poll_changes`) every integration implements, using only
`tasksystem::model`'s neutral types. It is synchronous, matching the rest
of `sergeant-core` (`docs/adr/0002-rust-v1.md`) — an adapter wraps
whatever blocking I/O it needs the same way `rusqlite` already does, and
the daemon is expected to call it from the same `spawn_blocking`-style
boundary it uses for the domain layer.

`poll_changes(cursor)` is a pull, not a push subscription: it matches the
daemon's existing due-watcher poll loop (`docs/adr/0009-daemon-leases-watchers-generic.md`)
and keeps the trait sync. A provider that only offers webhooks in
production can still implement it by reading its own durably-queued
webhook deliveries — that queue is a future adapter's problem, not this
trait's.

**`tasksystem::idempotency::write_once`** is the generic retry-safety
mechanism; `create_work_idempotent`/`add_comment_idempotent`/
`update_status_idempotent` apply it to each adapter write method. A row
left `Pending` by an earlier attempt that never reached `complete()` or
`fail()` (most likely a mid-write crash) is ambiguous — whether the
external write already landed can't be known locally — so `write_once`
returns an error instead of retrying it automatically, rather than
risking a duplicate comment or issue. The same applies when `execute()`
itself returns an error whose `SergeantError::is_outcome_unknown()` is
true (a transport timeout/connection error, an ambiguous response, or a
confirmed-success response whose body couldn't be parsed — see
`error::AdapterOutcome`): `write_once` parks the operation `Ambiguous`
instead of marking it `Failed`, so it isn't picked up as safe to retry
either. Only a definite adapter failure (an authoritative rejection) is
marked `Failed` and retried normally.

**`tasksystem::external_refs::create_or_attach_work_item`** is the
matching idempotency mechanism for the create-or-attach flow itself: it
creates the `WorkItem` and its first `ExternalWorkReference` in one SQLite
transaction (via `domain::work_items::insert_work_item`, a
transaction-scoped sibling of `create_work_item` added for this purpose),
so a crash between the two inserts is impossible — a retry either sees
neither (and creates both) or both (and creates neither), never an
orphaned `WorkItem`.

**`tasksystem::linear`** is the first adapter, built against Linear's
public GraphQL schema shape (`linear::transport` has the actual query/
mutation strings) behind a `GraphQlTransport` trait. No HTTP-backed
implementation of that trait exists in this repo — per this ticket's
brief, a real Linear credential and live-integration testing are a
deliberate follow-up once this contract has been reviewed; every test
here drives `LinearAdapter` through a fake transport
(`tests/support/mod.rs`). `linear::mapping` is the only
place Linear's JSON shape is parsed; nothing outside `linear/` ever sees
it.

## Consequences

- A second task-system provider (GitHub Issues, Intercom) implements
  `TaskSystemAdapter` and adds its own `tasksystem::<provider>` submodule;
  nothing in `domain/`, `tasksystem::model`, `tasksystem::connections`, or
  `tasksystem::external_refs` changes.
- A Linear outage surfaces as `SergeantError::TaskSystemAdapter` from the
  adapter call site; nothing about a failed adapter call touches
  `work_items`, `runs`, or any other durable Sergeant state, so Sergeant's
  own runtime state survives Linear being unreachable.
- Feeding a detected `ChangeEvent` into an actual workflow action (e.g.
  resuming a `NEEDS_DECISION` work item on a human reply) is not built
  here — `tasksystem::external_refs::resolve_work_item` gives a caller the
  `WorkItem` a change concerns, but deciding what to *do* about it is
  workflow-dispatch policy, which ADR-0009 already defers past this ticket
  (no dispatch policy exists yet for the daemon to plug this into).
- Unifying `task_system_connections` with `domain::permissions::Connection`
  into one persisted, cross-domain connections table is deliberately not
  done here; if a second connection-using domain (e.g. a CI adapter) lands
  before `permissions::Connection` itself is persisted, that unification
  should happen then rather than being speculatively built now.

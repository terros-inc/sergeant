# ADR-0009: The V1 daemon's leases/watchers are generic; supervisor dispatch is not built yet

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)): the `leases` table and `domain::leases` are removed. One `sergeant serve` process per database is enforced by a single-process `flock` guard (`db::process_lock`); per-Task mutual exclusion inside that process needs no durable lease row.

Partially superseded by [ADR-0013](0013-task-run-simplification.md) (UNF-226). Leases are kept
exactly as designed here. The generic `watchers` table is not: V1 only ever needed one durable
timer per Task (the supervisor's recheck heartbeat), so it now lives directly on
`tasks.next_check_at` instead of a separate polymorphic table. The watcher-specific sections below
are kept for history, not as the current design.

Further superseded by UNF-487: the supervisor loop/tick described below (and its
`task_supervision` lease resource) was removed outright, not merely simplified. Once
UNF-197's `implementation_tick` began rescanning every ACTIVE Task itself each tick, the
supervisor's one job here — "idempotently ensure every non-terminal work item keeps getting
looked at" — was fully redundant with that rescan, and its `next_check_at = now +
check_lead_time` write actively fought the event-driven wake UNF-487 added (it shared that
column with the retry/external-wait "explicit not-before" uses `next_check_at` genuinely
needs, so it could gate normal ACTIVE Task progress off a deadline nothing was actually
waiting for). `leases`/`domain::leases` themselves are unaffected — they're still generic
infrastructure, just with one fewer resource type in use today.

## Context

UNF-204 turns the UNF-192 domain model into a long-running daemon
(`sergeant-daemon`, binary `sergeant`) with a supervisor loop, a durable
scheduler, and a reconciliation loop. The design doc expects these loops
to be genuinely useful, but the entities a "useful" supervisor would
obviously want — Review/TestRun, Decision packets, HumanValidation,
ExternalJob, and the provider adapters that would let Sergeant actually
dispatch a run — are explicitly deferred past this ticket (see AGENTS.md's
walking-skeleton scope note and docs/repo-map.md's build order; the worker
interface itself later landed as UNF-193, ahead of UNF-197-203, per explicit
dispatch — see docs/repo-map.md's build order for the current, authoritative
sequencing).

## Decision

Two new durable primitives are added in `crates/sergeant-core/migrations/0002_daemon.sql`,
deliberately generic rather than tied to any deferred entity:

- `leases`: a crash-safe claim keyed by an arbitrary `(resource_type,
  resource_id)`, held by an opaque `holder_id` until `expires_at`. V1 only
  uses `resource_type = "work_item_supervision"`, but the mechanism itself
  assumes nothing about what it's protecting — it is infrastructure for
  "make an action idempotent/exclusive," not a work-item-specific table.
- `watchers`: a persisted timer with an opaque `kind` string. V1 only ever
  creates `kind = "supervisor_check"` watchers, and firing one in V1 does
  nothing but mark it fired. Kinds with real side effects (CI/deploy
  polling, worker heartbeat timeout, ...) are introduced by the tickets
  that actually need them (UNF-203 and later), not invented speculatively
  here.

Correspondingly, the supervisor loop (`sergeant-daemon`'s `ticks::supervisor_tick`)
does **not** decide what a work item needs next or create `Run`s — that
would require inventing a state→role dispatch policy that isn't specified
anywhere and belongs with the worker interface/provider adapter tickets.
Instead it does the one thing that's both real and policy-free: for every
non-terminal `WorkItem`, idempotently ensure a `supervisor_check` watcher
is pending, via a lease-guarded claim. The reconciliation loop
(`ticks::reconciliation_tick`) similarly only does what's possible with
today's domain model: it flags `Run`s stuck `running` past a staleness
threshold as stale and reports them (see
`docs/adr/0006-workers-disposable-work-state-durable.md`). It does **not**
mutate a stale run to `failed` — age alone doesn't prove a worker is dead.
A legitimate run (a real Claude/Codex session, a large build or test run)
can plausibly exceed any fixed threshold once real workers are connected,
so auto-failing on age alone would misclassify healthy-but-slow work.
Real failure detection needs worker/process liveness, a heartbeat, an
external-job terminal state, or an explicit timeout policy — none of
which exist yet — and is deferred to a dedicated future ticket (UNF-215).
There is no `ExternalJob` reconciliation — `crates/sergeant-daemon/src/startup.rs`
logs that gap explicitly rather than fabricating a table for it.

## Consequences

- Nothing in this ticket had to guess at workflow-dispatch policy, which
  would have been far more likely to need reworking once the worker
  interface/provider adapters actually land.
- `leases` and `watchers` need no schema change when later tickets give
  watchers real per-kind behavior or use leases for a different resource
  type — both tables are already generic enough.
- The supervisor loop today is observably "keeps every active work item
  scheduled for another look," not "drives the workflow forward." A
  future ticket that adds real dispatch slots in as a new watcher
  kind/handler and a real allocation of work to runs, not a rewrite of
  this infrastructure.

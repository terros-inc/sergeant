# ADR-0035: Fault watchdog -- liveness-based stale-Run detection, and retryable fault-clear delivery

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: `task_faults`/`task_tick_failures` are replaced by `tasks.faults_json`, `task.fault_*` `events`, and `tasks.health_json.tick_failure`, and the `cleared_notified_at` marker is replaced by the fault-clear comment's `outbox` row, which the outbox driver retries until delivered. The watchdog behavior below is unchanged.

Accepted (UNF-509). Amends [ADR-0033](0033-task-fault-independent-watchdog.md): keeps that ADR's
overall TaskFault model (tick-failure streak, stale Run, auto-clear, Linear surfacing) but replaces
its stale-Run corroboration rule and adds retryable clear-notification delivery. Everything else in
ADR-0033 still stands.

## Context

ADR-0033's stale-Run condition required a stale `Run` (`domain::runs::list_stale_running_runs`,
`started_at` age past `RetryPolicyConfig::idle_timeout`) to be *corroborated* by that same Task also
carrying an open `task_tick_failures` row, to avoid false-positiving on a merely long-but-healthy Run.

That left a blind spot UNF-509 (successor to the canceled UNF-489) exists to close: a Task whose
`implementation_tick` loop hangs, stops running entirely, or fails *before* the point in
`advance_task`'s chain that would have recorded a tick failure never gets a `task_tick_failures` row
at all -- so a genuinely stale Run on that Task went undetected indefinitely, precisely the class of
"early failure silently starves later recovery" bug ADR-0033 itself was written to catch (UNF-485).
Requiring corroboration against an unrelated bookkeeping table reintroduced a dependency on the same
tick loop the watchdog exists to be independent of.

Separately: `domain::task_faults::clear_fault` commits `cleared_at` before its Linear follow-up
comment is even attempted. If that comment post fails once (a transient Linear API error), nothing
tracked that the notification itself still owed delivery -- the fault no longer appears in
`list_open_faults`, so no later watchdog pass ever retried telling Linear the fault cleared.

## Decision

**Stale-Run detection**: `orchestrator::finalize::poll_and_finalize` already makes a live,
in-process liveness check every poll (via `Worker::status`'s `last_activity_at`, itself sourced from
per-adapter output-log mtime -- there is no durable DB signal for this anywhere in the schema).
UNF-509 turns that live observation into a durable fact: every time that function confirms a Run
non-idle (the same moment it would otherwise return `PollOutcome::StillRunning`), it now also calls
`domain::runs::record_run_poll_activity`, stamping `runs.last_polled_active_at` (migration 0037).

`domain::runs::list_runs_stale_by_activity` is the fault watchdog's new stale-Run query: a `running`
Run whose `last_polled_active_at` (falling back to `started_at` before the first poll) is older than
`idle_timeout`. `ticks::fault_watchdog_tick` now qualifies a stale Run on this alone -- no
`task_tick_failures` corroboration required. This still protects against the false positive
ADR-0033 was originally guarding: a long-but-healthy Run keeps its `last_polled_active_at` fresh as
long as the normal tick chain keeps reaching `poll_and_finalize` and finding it alive; a Run whose
tick chain stops reaching that check at all -- healthy worker or not -- is exactly what should be
flagged, since Sergeant itself has lost the ability to observe or recover it.

`domain::runs::list_stale_running_runs` (the older, `started_at`-only query) is unchanged and kept
for its own distinct use: `reconciliation_tick`'s daemon-restart-derived cutoff, which is deliberately
about "did this Run predate the process's last startup", not liveness.

**Retryable clear-notification delivery**: `task_faults` gains `cleared_notified_at` (migration
0038), set only once `linear::fault_comments::post_fault_cleared` is confirmed to have run (or once
a caller determines there is nothing to notify, e.g. no Linear issue on the Task). `clear_fault`
itself no longer attempts any Linear post -- it only ever commits the domain-level clear.
`domain::task_faults::list_faults_pending_clear_notification` returns every fault that is cleared but
not yet notified, regardless of which pass cleared it; `ticks::fault_watchdog_tick` runs this list at
the end of every pass and retries delivery for each entry. `post_fault_cleared`'s own idempotent
marker-based posting (`decision_comments::post_once`) makes a repeat attempt always safe, including
the case where an earlier post actually landed but this process's own view of the outcome was lost.

## Consequences

- A genuinely stale Run now surfaces a TaskFault on its own durable liveness signal, with no
  dependency on `advance_task` ever having reached the point of recording a tick failure -- closing
  the blind spot a Task whose tick loop wedges entirely left open under ADR-0033's original rule.
- `runs.last_polled_active_at` is a new, generally useful liveness column beyond just this watchdog
  -- any future caller wanting "is this Run still making progress" now has a durable answer instead
  of only a live, in-process one.
- Fault-clear delivery to Linear is now retried automatically and remains idempotent under retry,
  closing a silent-delivery-loss gap that existed for as long as `clear_fault`'s comment post could
  fail even once.
- Two new nullable columns, no new tables, no change to `TaskFault`'s kind set or its "no human
  interaction required to clear" contract.

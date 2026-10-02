# ADR-0033: TaskFault -- a persisted, self-clearing operator-fault signal, independent of the implementation-tick loop

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: the `task_faults` table is replaced by open faults in `tasks.faults_json`, their open/clear history as `task.fault_*` `events`, and their Linear comments as `outbox` rows keyed by the fault id; `task_tick_failures` is replaced by `tasks.health_json.tick_failure`. The fault model below is unchanged.

Accepted (UNF-486). Amended by [ADR-0035](0035-fault-watchdog-independent-stale-run-and-retryable-clear.md)
(UNF-509): the stale-Run corroboration rule described below (a stale Run must also carry an open
`task_tick_failures` row) is replaced by a liveness-based check that no longer depends on that table,
and fault-clear delivery to Linear is now retried rather than attempted once. Everything else here --
the TaskFault model itself, tick-failure streak detection, auto-clear, Linear surfacing -- still
stands as described below.

## Context

UNF-485 fixed one specific bug (a GitHub-response-parsing failure in `sergeant-core::github`)
that silently stalled a live task for over 80 minutes with zero external signal. The deeper
problem UNF-486 addresses is structural, not that one bug:

- `implementation_tick::implementation_tick_at` already isolates one Task's `advance_task` error
  from stopping the whole tick (per-Task `try`/continue, mirroring
  `linear::reconcile_all_active_tasks`'s own per-task isolation) -- but that error was only ever
  `eprintln!`'d (`loops::run_implementation_loop`) and folded into the in-memory
  `ImplementationReport::errors`, both discarded the instant that tick's log line printed. Nothing
  durable could ever answer "has this Task been failing repeatedly."
- `advance_task`'s own steps are chained with `?` (`phase_step` -> `ci_observation_step` ->
  `sme_consultation_step` -> `next_step`/`dispatch_step`). An error anywhere early in that chain
  prevents every later step -- including `dispatch_step`'s own `wait_step` idle-timeout stuck-
  worker recovery (`orchestrator::dispatch::poll_and_finalize`, ADR-0022's `idle_timeout`) -- from
  running for that Task that tick. `idle_timeout` is therefore not really an independent
  Task/Run watchdog: it only fires along one particular successful execution path, the same one a
  future bug in an *earlier* step (like UNF-485's) can silently starve again.

Sergeant already has one first-class "Sergeant needs a person" concept: `linear::decision`'s
`NeedsHumanDecision`, for when Sergeant genuinely needs a person to choose between options. That
model doesn't fit this failure mode -- there's no decision to make, no options to offer. Routing a
tick failure or a stale Run through `create_decision_task`/its answer-interpretation path would
mean either inventing meaningless "choices" or leaving a decision open forever, and would give the
fault the same lifecycle (waits for an answer) as a real judgment call it structurally isn't.

## Decision

Add a second, deliberately separate first-class concept: **TaskFault** -- Sergeant reporting that
it, itself, cannot advance a Task (an internal operation keeps failing, or a Run has gone stale
with no recovery). Not a request for judgment; a report that the system is stuck. It auto-clears
(no human interaction required) once a subsequent tick succeeds or the stale Run actually
recovers.

Three durable pieces, each its own migration/module (see each module's own doc comment for the
full design and rationale):

- `domain::tick_failures` (`task_tick_failures`, migration 0034): one row per Task, upserted every
  failing `advance_task` tick (fingerprinted via `retry_policy::classify_tick_error`, which mirrors
  `classify_worker_failure`'s existing substring-matching shape rather than inventing a second
  classification scheme) and deleted the moment a tick succeeds again. This is `implementation_tick_at`'s
  own write -- it changes nothing about that loop's control flow, only what gets persisted at the
  exact point an error was already being caught.
- `domain::task_faults` (`task_faults`, migration 0035): the TaskFault record itself -- kind
  (`tick_failure` | `stale_run`), detail, a stable per-instance comment marker, and `cleared_at`.
  At most one open fault per Task; reopening after a clear gets a fresh id/marker so an unrelated
  later incident is never confused with an earlier, already-resolved one.
- `sergeant-daemon`'s `ticks::fault_watchdog_tick` (`ticks/fault_watchdog.rs`), wired into its own
  loop (`loops::run_fault_watchdog_loop`) on its own interval, alongside (never inside)
  `run_implementation_loop`. It evaluates the two tables above plus `domain::runs::list_stale_running_runs`
  (the same query `reconciliation_tick` already uses, just against `RetryPolicyConfig::idle_timeout`
  instead of that tick's longer daemon-restart-derived cutoff) and opens/clears a TaskFault
  accordingly. **It never calls `advance_task`, `dispatch_step`, or anything in that chain** --
  only reads persisted state and writes an escalation record. That is the entire point: it cannot
  be silently disabled by the same class of bug it exists to catch. A stale Run alone never
  qualifies (a long-but-healthy Run legitimately runs past `idle_timeout` while `poll_and_finalize`
  still sees fresh worker activity); it only escalates when corroborated by that Task also
  currently carrying a tick-failure record, which is the actual signature of UNF-485's failure
  mode (the tick loop can't even reach the check that would otherwise recover it).

TaskFault surfaces via a Linear comment on the Task's own issue, through a new
`linear::fault_comments` module that reuses `decision_comments::post_once`'s idempotent-marker
pattern -- **not** `decision::create_decision_task` or its answer-interpretation path, per this
ADR's own "not a decision" framing above. A second, short comment posts when the fault clears on
its own.

Explicitly out of scope (deliberate fast-follow, not forgotten): any monitoring external to
Sergeant's own process (CloudWatch alarms, a firstmate-side heartbeat, any daemon-health signal
consumed outside this process). This ADR is about Sergeant's own internal fault model; external
alerting on top of it is a separate, later decision once this model is proven.

## Consequences

- A repeatedly-failing Task is now durable, queryable state (`task_tick_failures`), not a log line
  that vanishes when the tick ends.
- A second, genuinely independent line of defense exists against the "early failure starves
  `wait_step`'s own stuck-worker recovery" failure class -- one that keeps working even if a future
  bug reintroduces exactly that pattern somewhere else in `advance_task`'s chain.
- The domain model now distinguishes "Sergeant needs a person to decide something" from "Sergeant
  is stuck and reporting it" -- the latter never blocks on a reply, never routes through decision
  interpretation, and never requires anyone to explicitly dismiss it.
- Two new tables, one new daemon loop/thread, one new Linear-comment surfacing path -- bounded
  scope, no generalized alerting/notification framework introduced.

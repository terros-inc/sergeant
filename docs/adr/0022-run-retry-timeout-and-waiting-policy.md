# ADR-0022: Run retry, timeout, and waiting policy (UNF-215)

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: `run_retry_decisions` is now the `run.retry_decided` event, and `task_deep_assurance_requirements` is now `tasks.deep_assurance_requirement`.

UNF-641 ([ADR-0039](0039-worker-decided-independent-review.md)) retired the mandatory exact-head
final review the last paragraph of this section mentions; the merge gate now consumes existing
review evidence instead.

Accepted. UNF-487 removed `supervisor_tick` entirely (see ADR-0009's own status note) —
the "unrelated `supervisor_tick` reschedule" imprecision the retry-delay section below
describes no longer exists as a possibility; `next_check_at`'s only writers now are this
ADR's own `schedule_retry_at` and `domain::task_lifecycle`'s external-wait recheck
projection.

## Context

UNF-197's implement -> review -> fix -> test loop (`orchestrator::decide::next_step`)
originally escalated to a human decision on the very first non-success outcome for
any role: a worker crash, a timed-out/stuck worker (never even detected — see
below), or a plain non-zero exit all went straight to `LoopStep::NeedsHumanDecision`,
with zero automatic retry. `ticks::reconciliation_tick`'s own doc comment already
flagged the gap this ADR closes: a `Run` stuck `running` past `stale_run_after` was
only *reported*, never acted on, deferring "worker/process liveness ... an explicit
timeout policy" to this ticket. Left as-is, Sergeant would escalate routine,
self-clearing engineering difficulty (a transient provider hiccup, a single crashed
turn) to a human far too early, while a genuinely stuck worker (`WorkerState::Stuck`
is not part of `WorkerState::is_terminal`) was never even noticed.

## Decision

**One shared retry budget across every retryable failure class, not a per-class
policy matrix.** `retry_policy::RetryPolicyConfig` (`crates/sergeant-core/src/retry_policy/`)
holds every configurable limit this ticket asks for — `max_run_retries`,
`max_fix_cycles` (replacing the old hardcoded `MAX_FIX_CYCLES` constant),
`idle_timeout`, `max_wall_time`, `retry_backoff`, and the deep-assurance
wall-time/cost fields — each independently overridable via a `sergeant-daemon`
environment variable, mirroring `Config::from_env`'s existing pattern. This stays
deliberately small: this ticket's own scope explicitly warns against building a
generalized policy engine.

**Failure classification (`domain::types::FailureClass`)**: `Transient`,
`ProviderFailure`, `Deterministic`, `StuckWorker`, `HumanDecision` — a Run's own
worker-execution outcome, persisted on `runs.failure_class` at finalize time
(`orchestrator::dispatch::poll_and_finalize`, via
`retry_policy::classify_worker_failure`). Every class but `HumanDecision` is
retry-eligible under the shared budget; `HumanDecision` never is. This is
deliberately **separate** from `error::AdapterOutcome` (Definite/Unknown), which
governs whether an outbound Linear/GitHub *write* is safe to retry (UNF-222/UNF-229)
— a Run's own execution failure and an ambiguous Linear/GitHub mutation outcome are
different signals, and this ticket's Run-retry budget never wraps or consumes
UNF-229's existing write-safety layer. An ambiguous Linear mutation keeps following
UNF-229 exactly as before.

**Stuck-worker detection**: `poll_and_finalize` now force-finalizes a Run that has
sat idle (no observed `WorkerStatus::last_activity_at`/`started_at` activity) past
`idle_timeout` as `FailureClass::StuckWorker`, best-effort cancelling it first —
closing the gap where `WorkerState::Stuck` (not part of `is_terminal`) was never
noticed by anything.

**Retry-eligibility decision (`orchestrator::retry::handle_run_failure`)**, the
single entry point every `(ROLE_X, non-succeeded)` case in `decide::next_step` now
shares: checks the wall-time safety net first (regardless of remaining retry
budget — raising `max_run_retries` later must never reopen a hot loop on a Task
that already burned unreasonable wall time), then whether the Run was explicitly
`Canceled` (never auto-retried — a deliberate stop), then `FailureClass::is_retryable()`,
then the same-role attempt count against `max_run_retries`. Under budget, it
reconstructs the *exact* dispatch step that originally produced the failed Run
(`LoopStep::DispatchImplementation`/`DispatchReview`/`DispatchFix`/`DispatchTest`) —
a retry redispatches the same stage, never advances to the next one — wrapped in
the new `LoopStep::RetryAfter { failed_run_id, inner, not_before, attempt,
failure_class }`. This is entirely separate from the pre-existing review<->fix
*content* loop (a review/test Run that succeeded but reported a must-fix finding or
a failing test) — that loop's own budget (`max_fix_cycles`) and escalation shape are
unchanged, just now configurable instead of a hardcoded constant.

**Delayed retry via `Task.next_check_at`, reused, not a second scheduling field.**
`sergeant-daemon`'s `implementation_tick` sets `next_check_at = not_before`
(`domain::tasks::schedule_retry_at`, an unconditional set distinct from
`schedule_check_if_unset`'s set-if-null) when a `RetryAfter`'s backoff hasn't
elapsed, and gates its own outer loop on it (skip a Task whose `next_check_at` is
still in the future) purely for efficiency/observability — `LoopStep::RetryAfter`'s
own `Utc::now() < not_before` check inside `implementation_tick::retry_step::handle_retry_after`
is the actual correctness guarantee, not the outer gate. This can occasionally push
a retry's actual fire time slightly later than `not_before` when an unrelated
`supervisor_tick` reschedule (its own, different use of the same field: "make sure
we glance at this periodically") races in after `scheduler_tick` clears the
checkpoint — accepted as harmless imprecision (never a hot loop, never indefinite
starvation) rather than adding a second field to avoid it.

**Auditable retry history (`run_retry_decisions`, `migrations/0011_retry_policy.sql`)**:
an append-only row per retry decision (waiting/dispatched/escalated, failure class,
attempt, reason), mirroring `dispatch_concurrency_checks`/`run_steering_events`'s own
"record every occurrence" shape — satisfying "persist retry attempts/reasons and
make policy decisions auditable" without a third parallel evidence mechanism
(considered, and rejected, extending UNF-256's `RunExecutionTelemetry`/`SteeringEvent`
directly: both record a different kind of fact — what a worktree needed, or what a
human told Sergeant — neither is "what the retry policy decided and why").

**Deep-assurance policy surface, consumed by UNF-345.** `RetryPolicyConfig`'s
`deep_assurance_max_wall_time`/`deep_assurance_max_cost_usd`, plus
`task_deep_assurance_requirements` (`retry_policy::store::mark_deep_assurance_required`,
upserted like `dispatch_concurrency_overrides`) were introduced as policy surface for
specific high-risk Tasks. UNF-345 later added the concrete `deep-assurance` Run that
consumes this surface only when a requirement row exists. It observes and certifies
the exact GitHub PR head, enforces the dedicated wall-time/cost bounds, and feeds
objective failures into the existing bounded fix loop. The ordinary path remains
structurally free of this heavyweight stage and proceeds from green GitHub checks to
the fresh exact-head final review.

## Consequences

- A repeatedly failing Run cannot loop forever: bounded by `max_run_retries` per
  role, with `max_wall_time` as an independent safety net.
- A transient/provider/stuck-worker failure retries automatically, without
  consuming the Linear-write retry-safety budget UNF-229 already owns.
- Ambiguous Linear mutation outcomes keep following UNF-229's own
  reconcile-before-retry mechanism entirely untouched by this policy.
- Genuine human-decision-required failures (`FailureClass::HumanDecision`) and an
  explicit cancellation never retry, going straight to the existing
  `WAITING` + `create_decision_task` pattern — no new Decision/HumanValidation
  entity.
- Review/fix content cycles keep their own explicit, now-configurable limit and
  escalation outcome, unchanged in shape.
- Deep-assurance Runs have an explicit wall-time/cost budget and a structurally
  non-blocking default; UNF-345 supplies the requirement-driven caller.
- Retry/waiting history is SQLite-durable (`run_retry_decisions`, plus
  `Task.next_check_at`) and survives a restart, per `docs/adr/0006`.

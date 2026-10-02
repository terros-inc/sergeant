# ADR-0015: Human attention and escalation policy (UNF-218)

## Status

Accepted.

## Context

Linear is the organizational source of truth for work and decisions
(`AGENTS.md`); Sergeant keeps its own durable runtime state but does not own
human-facing project management (ADR-0006). UNF-227 (`crates/sergeant-core/src/linear/`,
landed on `main` in an earlier PR) gives Sergeant two
Linear-native mechanisms already built for exactly this purpose:

- `linear::intake`/`linear::reconcile`: Task state is driven from Linear issue
  state (assignment, labels, blockers), not a Sergeant-owned queue.
- `linear::decision::create_decision_task`: the human-decision pattern — a new
  Linear issue carrying question/context/options/recommendation/impact, blocking
  the original issue, with the local Task marked `WAITING`. `try_resume_waiting_task`
  re-derives readiness from Linear's own current blockers. UNF-227's own doc
  comment on `decision.rs` already establishes that human validation reuses this
  same mechanism rather than a separate entity — there is nothing
  validation-specific to build.

Without an explicit policy, the natural failure mode is for every internal Run
event (each supervisor/scheduler/reconciliation tick, every retry, every
provider status change) to turn into Linear noise, or — the opposite failure —
for a security-sensitive or unrecoverable failure to go unnoticed because
nothing surfaces it. UNF-218 asks for the classification that prevents both,
without building a second notification system inside Sergeant.

## Decision

**Linear is the only human-attention surface for V1.** No Sergeant-internal
notification/routing table, attention-request domain entity, or Slack
integration is introduced. A human understands when Sergeant needs them by
looking at Linear: their assigned issues (decision/validation requests) and
comments on issues they're already watching.

### Classification

Every internal event that could plausibly matter to a human is classified into
exactly one of four actions, decided once, close to where the event is
detected — not accumulated in a generic event bus:

| Action | Mechanism | When |
|---|---|---|
| **Silent** | nothing | routine, expected, self-correcting, or already visible via ordinary Linear issue state (assignment/labels) that `linear::reconcile` keeps in sync |
| **Comment** | a concise Linear comment on the Task's existing issue | meaningful progress or failure a human watching the issue would want to see, but that does not require them to act |
| **Decision task** | `linear::decision::create_decision_task` | Sergeant needs a human's judgment to proceed — a genuine choice, not an implementation detail (`AGENTS.md`'s "Escalation" section) |
| **Validation task** | `linear::decision::create_decision_task` (same mechanism, framed as validation rather than a choice) | a human must confirm a real-world outcome the worker cannot verify itself (e.g. "does this look right in the deployed environment") |

Decision and validation tasks are the same underlying mechanism with a
different question shape — UNF-227 already treats them this way (see
`decision.rs`'s doc comment). This ADR does not introduce a second Linear
workflow for validation; it only distinguishes them at the classification
level so callers frame the created issue's question correctly (a choice among
options vs. a yes/no confirmation of an outcome).

### Event -> action mapping

Silent (no Linear write):
- Supervisor/scheduler/reconciliation tick activity with no state change
  (lease contention, an overdue-check clear, a stale-run report that resolves
  on its own).
- A Run transitioning through ordinary in-flight states (`pending` ->
  `running`), or a retry that Sergeant itself decided to attempt.
- **An individual Run succeeding, or failing on a first attempt Sergeant will
  retry automatically.** A Task passes through many Runs
  (implement/review/fix/test/deep-assurance); each one succeeding, or a
  single transient provider/network failure a retry is expected to clear, is
  Sergeant's internal execution machinery, not Task-level progress. Commenting
  on every Run would mirror the internal execution engine into Linear —
  exactly the noise this ADR exists to prevent. Humans care about the Task,
  not the Run underneath it.
- Any Task `WAITING` <-> `ACTIVE` transition driven by ordinary blocker
  changes that `linear::reconcile` already reflects in the issue itself —
  the issue's own state *is* the human-visible signal; a duplicate comment
  saying "now waiting" would be exactly the noise this ADR exists to avoid.

Comment (concise, on the Task's Linear issue):
- A meaningful **Task-level** milestone: implementation ready for review,
  merged/completed, or an equivalent point a human watching the issue would
  want to see — as opposed to a Run finishing underneath it.
- A Run has now failed more than once, or in an otherwise unusual way, before
  exhausting the retry budget: no longer ordinary churn, but not yet worth a
  decision task either. Lean toward staying silent through the first retry
  and only commenting once a failure is unusual or repeated, per the same
  "internal machinery vs. Task-level signal" bar above.
- Any other "meaningful progress" a caller judges worth surfacing — the bar
  is "would a human watching this issue want to see this," not "did
  something happen at the Run level."

Decision task:
- A genuine product/architecture choice surfaces mid-run (the same bar
  `AGENTS.md`'s "Escalation" section sets for a human worker) and Sergeant
  cannot pick a default.
- A `Task` has exhausted its automatic retry budget and needs a human
  decision about whether/how to continue — framed as options, not silent
  abandonment.

Validation task:
- A worker completed real-world-affecting work (a deploy, a migration, a
  destructive action gated by `permissions::is_production_action`) that
  Sergeant cannot itself verify succeeded correctly.

Escalation (decision task, urgent framing):
- A security-sensitive event: `permissions::authorize` returning
  `Decision::Denied` for an action a worker actually attempted (not a
  routine capability check), or any credential/secret-handling anomaly
  `redaction.rs` surfaces.
- An unrecoverable failure: a Run fails in a way that leaves the Task with no
  further automatic path forward (not merely "this turn failed, retry" but
  "Sergeant cannot make progress on this Task without a human").

  Both route through the same `create_decision_task` mechanism as an ordinary
  decision — there is no second, higher-priority channel for V1, per this
  ticket's scope. Urgency is expressed in the issue's title/description
  (e.g. a `Security` or `Unrecoverable` prefix) and assignee, not a different
  delivery mechanism. If a genuine need for a lower-latency channel (e.g.
  paging) emerges later, ADR-0009's precedent applies: build the specific
  thing needed, not a generic notification-routing layer speculatively.

### Implementation shape

`crates/sergeant-core/src/attention.rs` (UNF-218) is a pure classification
layer, mirroring `redaction.rs`/`permissions.rs`'s existing "no I/O" module
shape:

- `AttentionEvent`: the internal events above, carrying just enough context
  (Task id, a short human-readable summary, options/recommendation for a
  decision) to render a comment or a `DecisionRequest`.
- `AttentionAction`: `Silent`, `Comment { body }`, `DecisionTask(DecisionContent)`,
  `ValidationTask(DecisionContent)`.
- `classify(&AttentionEvent) -> AttentionAction`: the table above, as code.

It has no dependency on `linear::` and performs no Linear I/O itself. Now that
UNF-227 is on `main`, a `DecisionTask`/`ValidationTask` action maps directly
onto `linear::decision::create_decision_task`'s `DecisionRequest`, and a
`Comment` action maps onto whatever comment-creation call `LinearClient`
exposes — `client.rs` currently has issue/relation creation and lookup
(`create_issue`, `add_blocking_relation`, `fetch_issue_with_blockers`,
`list_delegated_issues`), but no comment mutation yet; adding one, and the
caller that actually wires ticks/worker outcomes through `classify()` into
these calls, remains follow-up work — this ticket's scope is the
classification policy, not that wiring.

This keeps `attention.rs` testable with zero Linear/database setup, and keeps
the actual Linear write — where idempotency/deduplication matters — entirely
inside `linear::` and UNF-229's hardening of it (not yet landed as of this
ADR). This ticket does not implement retry, dedup, or idempotency of its
own; per UNF-229's scope, any real Linear write this classification result
feeds into must go through the `LinearClient` call surface that exists
today, and adopt UNF-229's write-safety layer without this module changing,
once it lands.

## Consequences

- Humans can answer "does Sergeant need me?" by looking at their assigned
  Linear issues and the comments on issues they watch — no second place to
  check.
- Routine Run/tick churn produces zero Linear writes, by construction: the
  classifier's `Silent` arm is the default for anything not explicitly listed
  above.
- Decision and validation requests always go through
  `create_decision_task`/`try_resume_waiting_task`, so they get UNF-227's
  blocker-based resume semantics for free — this ADR does not add a second
  way to ask a human something.
- No Slack/notification architecture, generic routing table, or new domain
  entity is introduced. Extending to another channel later means adding a
  new `AttentionAction` consumer (e.g. a Slack-posting caller reading the
  same classification), not redesigning the classification itself.
- `attention.rs` exists today as a tested, standalone policy layer with no
  Linear I/O of its own. Wiring it to `linear::`'s real writes — adding the
  comment-creation mutation `LinearClient` doesn't yet have, and the caller
  that actually invokes `classify()` from ticks/worker outcomes — is
  follow-up work, not this ADR.

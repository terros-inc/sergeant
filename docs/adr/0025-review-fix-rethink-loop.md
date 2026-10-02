# ADR-0025: Replace repeated review<->fix patching with one fix round, then rethink (UNF-343)

## Status

Accepted.

## Context

Before this ticket, `orchestrator::decide::next_step` handled a review Run's persistent must-fix
findings with a single flat budget: `RetryPolicyConfig::max_fix_cycles` (default 3) counted every
`ROLE_FIX` Run dispatched for a Task, and as long as that count stayed under budget, a still-failing
review dispatched another `ROLE_FIX` Run addressing the same findings — up to three increasingly
local, line-level patch rounds before finally escalating to a human decision. Each fix round
observed the same failing candidate and tried to patch around the same review comments again,
never stepping back to ask whether the findings shared a root cause a restructure could actually
fix.

This pattern was observed live: UNF-366 (a different task, worked the same night this ticket was
authored) went through two full review->fix rounds on the same underlying issue before landing —
real evidence of the exact failure mode this ADR exists to close, not just a theoretical concern.

## Decision

**One normal fix round, a fresh re-review, then a rethink pass instead of a second blind patch.**
`RetryPolicyConfig::max_fix_cycles` is reinterpreted (default changed from 3 to 1): it now bounds
only *normal*, review-triggered `ROLE_FIX` Runs since the Task's last rethink Run (or since its
first Run, if none) — see `orchestrator::decide::review_loop::fix_cycles_since_last_rethink`.
Once that budget
is exhausted and a review still has must-fix findings, `next_step` dispatches a rethink Run
(`LoopStep::DispatchRethink`, `ROLE_RETHINK`) instead of another `ROLE_FIX`, gated by a new sibling
budget, `RetryPolicyConfig::max_rethink_cycles` (default 1) — the total `ROLE_RETHINK` Runs a Task
may ever dispatch. Both budgets exhausted (one rethink pass ran, and the fix round it produced
still didn't clear review) escalates to a human decision (`fix_and_rethink_exhausted_content`),
replacing the old `fix_cycles_exhausted_content`.

UNF-669: both human decisions this loop raises -- the budget-exhausted one (keyed per triggering
review since UNF-669) and a rethink's `NeedsHumanDecision` -- also offer "Accept the current
implementation as-is" when what they present is exactly one review's remaining must-fix findings
with no blocked CI. The decision lists those findings; the answer accepts that review's must-fix
findings for the candidate it observed, through the same `orchestrator/accepted_findings.rs`
record UNF-668's SME approval uses, so the Task continues to planned validation and the merge gate
accepts the review. A new head is reviewed normally, and CI is never accepted.

**The rethink Run is a judge, never a fixer — reviewer/rethink stay conceptually separate from
the implementer/fixer role.** It runs in a fresh context (`WorkspaceRequest::Observe`, same shape
as a review Run), is given the original/effective intent (the same `ContextSnapshotBody` every
role gets), the current diff (it inspects its own observed worktree, same instruction shape as
`review_prompt`), and the prior finding history (the persistently-failing review's own must-fix
list) — see `implementation_prompts::rethink_prompt`. It never mutates the candidate itself. Its
structured verdict (`orchestrator::RethinkReport`, written to `rethink-report.json`, same
`is_valid`-gated missing/malformed-evidence handling as `SimplificationReport`) is one of these
outcomes:

- `Simplify` — an intent-preserving restructure/simplification fixes the findings' root cause.
  Adopted automatically, no human approval: `next_step` dispatches one more plain `ROLE_FIX` Run
  (`LoopStep::DispatchRethinkFix`) carrying the adopted `effective_plan`.
- `BoundedFix` — the remaining findings are clearly independent small defects, not a repeated
  symptom of the same root cause. `next_step` dispatches the same `LoopStep::DispatchRethinkFix`,
  this time carrying the rethink's own bounded `findings` list instead of a plan.
- `NeedsHumanDecision` — resolving the findings would require changing product behavior, security
  properties, architecture intent, acceptance criteria, or another material requirement. Routes
  through the existing `HumanDecision`/`escalate()` machinery (`rethink_needs_decision_content`),
  the same pattern every other stuck condition in this loop already uses — no new escalation
  mechanism.
- `Proceed` (UNF-668) — every remaining finding was already accepted as-is by a human for this
  exact candidate (an "Approve and continue" answer to the triggering review's SME decision,
  covering every one of that review's must-fix findings).
  Sergeant honors it only when its own decision records agree, and then (as for a
  `NeedsHumanDecision` verdict on such findings) continues to planned validation instead of
  escalating; without a recorded acceptance it escalates like `NeedsHumanDecision`.

Either `Simplify` or `BoundedFix` still dispatches a `ROLE_FIX` Run, not a new "rethink-fix" role:
the loop has exactly one implementer/fixer role, whether a fix addresses a review's findings
directly or a rethink's verdict. `LoopStep::DispatchRethinkFix`'s own fix Run sets `parent_run_id`
to the rethink Run (not the review), so provenance distinguishes a rethink-originated fix from a
review-triggered one without inventing a second `ROLE_FIX`-like role — `orchestrator::retry`'s
crashed-Run reconstruction switches on that parent's own role (`ROLE_REVIEW` -> `DispatchFix`,
`ROLE_RETHINK` -> `DispatchRethinkFix`) to redispatch the exact same shape a retry needs.

**Fresh context for every full review/re-review/rethink**, restated because it's load-bearing: a
review Run always observes the candidate independently (`WorkspaceRequest::Observe`), never
carries state from a prior review Run's own reasoning forward, and the rethink Run is dispatched
the identical way — no shared session, no accumulated conversation state across rounds.

**One bounded, restart-safe loop, no overlapping retry budget.** Both `max_fix_cycles` and
`max_rethink_cycles` are derived purely from a Task's durable `Run` history (`fix_cycles_since_
last_rethink`/`rethink_cycles` in `orchestrator::decide::review_loop`), the same "no separate state machine,
recompute from history" shape `docs/adr/0022`'s retry policy already established — a process
restart mid-loop loses nothing, since the next `next_step` call recomputes identically from the
same Run rows. This is a *reinterpretation* of the existing budget, not a second overlapping one:
`max_fix_cycles` still governs the same field, `RetryPolicyConfig::max_fix_cycles`, just now scoped
to "since the last rethink" rather than "ever."

**All limits remain configurable**: `SERGEANT_MAX_FIX_CYCLES` (existing var, new default 1) and
the new `SERGEANT_MAX_RETHINK_CYCLES` (default 1), both plain `RetryPolicyConfig` fields resolved
by `sergeant-daemon/src/config/policy.rs`, same env-var-with-default shape as every other retry
policy limit.

## Consequences

- A normal review defect is fixed once and independently re-reviewed in a fresh context — the same
  shape as before this ticket, just bounded to exactly one round before escalation logic changes.
- Persistent review failure triggers a rethink pass, not a second or third blind patch — the
  UNF-366-observed pattern this ADR exists to close.
- An intent-preserving rethink verdict (`Simplify`/`BoundedFix`) proceeds autonomously, no human
  decision in between, mirroring UNF-341's own pre-implementation `Simplify` precedent.
- An intent-changing rethink verdict (`NeedsHumanDecision`) pauses through the existing
  human-decision path — never a parallel escalation mechanism.
- The loop stays bounded (two small budgets, default 1 each) and restart-safe (derived from Run
  history alone, no new durable state machine).
- Existing tests asserting the old `max_fix_cycles = 3`/`fix-cycles-exhausted` shape were updated:
  `fix_cycle_budget_exhausted_dispatches_rethink_instead_of_escalating` (formerly `..._needs_human_
  decision`) now asserts the rethink dispatch; a new `fix_and_rethink_budgets_exhausted_needs_
  human_decision` covers the actual double-exhaustion escalation case.

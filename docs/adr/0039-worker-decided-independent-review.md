# ADR-0039: Worker-decided independent review

## Status

Accepted (UNF-641). Supersedes the "first review is mandatory; later candidates carry a
review-impact judgment" section of [ADR-0032](0032-parallel-ci-and-review.md) and retires the
UNF-345 mandatory exact-head final review (`ROLE_FINAL_REVIEW`). Deep assurance (UNF-345) and
ADR-0032's parallel CI observation are unchanged. [ADR-0041](0041-reviewer-rules-on-acceptance-criteria-ci-is-the-test-gate.md)
(UNF-647) amends what a review is given and must rule on, makes CI the test gate (the planned
validation below dispatches a test Run only for `targeted` checks), and adds the
`human_found_must_fix` calibration count.

## Context

Independent review used to be a lifecycle stage: every Task's first candidate was reviewed, and a
second, generic `final-review` Run re-reviewed GitHub's exact PR head right before merge, even when
nothing had changed since a clean review (UNF-404's trigger). UNF-480 let a fix skip re-review only
when it reported `review_impact: non_material` against an already-passed review. Review count was
therefore mostly predetermined rather than driven by what each change actually was.

## Decision

**The worker that mutated the candidate decides whether its change needs independent review.**
After every candidate-mutating Run (`implement`, `fix`, `repair`) the worker's completion contract,
`implementation-result.json` (`ImplementationResult`, both `code_change` and `deliverable`),
carries:

```json
"review_decision": {
  "review_required": true,
  "review_reason": "one or two sentences",
  "categories": ["behavior_change", "security"]
}
```

`categories` is a closed set so decisions can be grouped later: `behavior_change`,
`architecture`, `data_model`, `security`, `concurrency`, `api_contract`, `uncertainty`,
`large_change` (reasons to review) and `mechanical`, `docs_or_tests_only` (reasons a skip is
safe). An unknown string reads as `other` rather than invalidating the decision. The prompt
(`implementation_result_instruction`) asks the worker, at the end of its work, to judge the change
it actually made: scope, behavioral impact, architecture/data/auth/security/concurrency/API
impact, its own uncertainty, and — for a fix or repair — prior review findings and the size and
materiality of the delta since the last review. Sergeant has no scoring rubric of its own; it only
reads the decision.

**Fail-safe.** A missing `review_decision`, one that does not parse, or `review_required: false`
with a blank `review_reason` is treated as `review_required: true`. A malformed decision never
invalidates the rest of the implementation result. UNF-480's `review_impact` is removed; an old
artifact that still carries it simply has no decision and fails safe to review.

**Lifecycle** (`orchestrator::decide::candidate_mutation`). `review_required: true` dispatches one
ordinary `review` Run of that candidate. `false` goes straight to the planned validation path — the
same path a passing review takes: a `deliverable` completes; a `code_change` dispatches `test` for
the plan's `targeted` checks, or completes -- with CI gating the merge -- otherwise (ADR-0041; before
UNF-647 it tested at the plan's effective level, including UNF-569's fail-safe upgrade). Review findings dispatch a fix through the unchanged fix/rethink/escalate
budgets, and the fixer decides again, so a mechanical correction may skip re-review and a material
one may request it. A Task naturally ends with 0, 1, 2 or more reviews; nothing is numbered. A
review that settles after the candidate's test already passed consumes that test instead of
re-running it. A `repair` also owes the review the candidate it repaired still owed
(`candidate_review_required`, UNF-646): a conflict repaired before that candidate's required review
ran would otherwise let the repair worker's skip — a judgment about its own rebase — carry the
unreviewed change to the merge gate. Such a review is recorded as `required`, not `audit`.

**No mandatory final review.** `ROLE_FINAL_REVIEW` and `LoopStep::DispatchFinalReview` are
removed. The merge gate (`completion::certification::certification_gate`) keeps deep assurance and
now *consumes* review evidence instead of creating it: when the merging candidate's own decision
was `review_required` (fail-safe included), or the candidate was reviewed anyway by an audit
(below), a passing `review` Run of that candidate must have observed the exact PR head SHA (its
Observe workspace's recorded commit — no new artifact); when the decision was `false` and no review
ran, no review evidence is required. Sergeant pushes candidates without force, so
the PR head is the reviewed commit in practice. If that evidence is ever missing, the gate
dispatches one ordinary `review` of the exact head, never merely because merge is approaching.
Legacy `final-review` Runs already in history are read as ordinary reviews so in-flight Tasks keep
moving; nothing dispatches that role any more.

**Review and testing stay independent.** Skipping review never skips planner-selected validation
or GitHub's required checks (the merge gate is unchanged). (ADR-0041 retired the changed-files
classification this paragraph used to describe, along with the upgrade it fed.)

**Audit sample.** `RetryPolicyConfig::audit_review_sample_rate`
(`SERGEANT_AUDIT_REVIEW_SAMPLE_RATE`, 0.0–1.0, default 0.2) sends that fraction of
`review_required: false` candidates to an **audit review** anyway. The draw is a stable hash of the
candidate Run id, so it is random across candidates but identical on every tick and restart
without new state. An audit review is an ordinary `review` Run: its findings drive the normal fix
loop, and it is review evidence the merge gate holds to the same exact-head rule. (The first
iteration of this ADR made it a non-gating shadow review; a real one cost the same latency with
less machinery, so the captain chose the real one.)

**Calibration.** Facts are write-once keys in the existing `runs.outcome_json`. No schema
change:

- implement/fix/repair Runs, at finalization: `review_decision` — `{review_required, reason,
  categories, fail_safe}`, where `fail_safe` marks a decision forced to `true`.
- every review Run, in the transaction that creates it (so the fact survives a dispatch that fails
  before the worker starts, and cancellation): `review_trigger` — `required` (its candidate's
  decision required review, fail-safe included) or `audit` (a sampled review of a skipped
  candidate), so the two paths stay distinguishable.
- completed review Runs, at finalization: `review_result` — `{findings, must_fix}`.
- A review "led to a fix" when it had `must_fix > 0` and a `fix`/`rethink` child Run
  (`runs.parent_run_id`).

`orchestrator::review_calibration::summarize` (served at `GET /runs/review-calibration`) aggregates
these overall and by category: mutations, review request rate, fail-safe count, and -- separately
for required and audit reviews -- reviews, with findings, with must-fix, and led to a fix. No
target rates are encoded; the numbers exist to tune the worker prompt empirically.

## Consequences

- Review cost tracks the change rather than the Task: trivial follow-up fixes and low-risk changes
  merge without a generic re-review, and risky ones are still reviewed as often as they change.
- Review quality now depends on the worker's self-assessment. The fail-safe default, the gating
  audit sample, and per-category calibration numbers are the safeguards; the sample rate and prompt
  are the tuning knobs.
- The implementer-eval harness checks that a valid `review_decision` is written, so prompt changes
  are exercised by the existing agent-eval machinery.

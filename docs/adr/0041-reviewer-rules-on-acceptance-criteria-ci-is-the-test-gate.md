# ADR-0041: The reviewer rules on every acceptance criterion; CI is the test gate

## Status

Accepted (UNF-647). Amends [ADR-0039](0039-worker-decided-independent-review.md)'s review evidence
contract, lifecycle, and calibration, and retires UNF-569's actual-diff validation upgrade
([ADR-0038](0038-planner-first-repository-selection.md)'s planned local validation).

## Context

On UNF-639 (PR #302) two Sergeant reviews passed a change in which the captain then found three
correctness bugs (the 2026-09-30 retro, finding F2). Each miss came from what the reviewer was given
and asked, not only from model strength:

- The planner decided "no backfill" against the acceptance line "`sgt task show UNF-404` works".
  The reviewer never saw the decision: a review Run's `supplied_context` was empty.
- The implementer called an identical-body dedupe "an accepted, tested, documented trade-off".
  Review 2 accepted that label without tracing a new `asked_at` through the decision-wait state
  machine.
- All three reviews called a +2211/−1051 change a "net simplification". The implementer's own
  `known_gaps` said +761.

No review was asked for a verdict on each acceptance criterion. Every review also re-ran the full
workspace gate (review 1 took 27 minutes), as did the implement and fix workers and Sergeant's own
test Run, before CI ran it again. The retro counted about nine full-suite runs on one task. The
captain's rule: "we run tests way too much. we run them on the worker, then on the reviewer, then in
CI/CD."

## Decision

**The reviewer is given the planner's decisions and the implementer's declarations.** A review Run
(`dispatch_review`, and the merge gate's exact-head review) gets two documents in its
`context_snapshot`'s `supplied_context`, re-derived from Run history
(`implementation_tick::review_inputs`):

- `planner-execution-plan`: the accepted plan, exactly as the implementation Run received it.
- `implementer-declarations`: every succeeded implement, fix, and repair Run's summary, rationale,
  and known gaps, oldest first.

`review_prompt` renders both as claims nobody has reviewed yet, to check against the issue and the
actual change.

**Every review rules on every acceptance criterion.** `ReviewReport` gains
`acceptance_criteria: [{id, criterion, verdict, evidence}]`. The verdict is `met`, `not_met`,
`contradicted`, or `needs_live_validation`. Where the criteria come from, and what a review must
cover, is fixed at dispatch in a versioned completion contract (`orchestrator::review_contract`):

- *Expected criteria come from the issue.* When the issue has an Acceptance section (a
  `## Acceptance` / `Acceptance criteria` heading, or a line holding only that label), its bullets
  are the authoritative criteria, with stable ids `AC1`, `AC2`, ... in order. They are read from
  the issue itself, never from the Planner's plan, because the plan is one of the things the review
  checks and may not narrow acceptance. The prompt lists them by id, and the review must give
  exactly one verdict per id. Nothing beyond that section is parsed: an issue without one falls
  back to the reviewer listing the outcomes it asks for itself.
- *The contract is recorded where finalization reads it.* The review Run's durable
  `resolved_context` carries `review_contract: {version, criteria_source, criteria}`. Finalization
  holds a review to the contract it was dispatched under. A review Run dispatched before the
  contract existed (none recorded) was given the older prompt, so it only has to write a parseable
  report: deploying this never fails a review that did what it was asked.
- *Completion.* Under the contract, every verdict a review gives must name its criterion and its
  evidence. With reviewer-listed criteria it must also give at least one (`ReviewContract::accepts`).
  A report that fails this is incomplete evidence, handled like any other missing evidence.
- *Gating.* Sergeant persists the review's report reconciled with its contract
  (`ReviewContract::reconcile`). Every expected id the review left out gets a `missing` verdict,
  however many other verdicts it returned (a duplicate never stands in for a missing id), and the
  report is labeled with its `criteria_source` (`issue_acceptance_section` or `reviewer_listed`).
  `ReviewReport::must_fix` then adds one must-fix finding (category `acceptance-criterion`) for
  each `not_met`, `contradicted`, or `missing` verdict. An unrecognized verdict string counts as
  unmet. These findings drive the existing fix/rethink/escalate loop and count in
  `review_result.must_fix`, and no later reader needs the contract itself. `needs_live_validation`
  never gates on its own.

The prompt also states three rules:

- A planner decision that narrows, defers, or drops a criterion makes that criterion
  `contradicted`, because only a human may narrow acceptance criteria.
- A self-declared trade-off that changes control-plane or persisted state must be traced through
  every transition and reader it affects, or reported as must-fix.
- A size or simplification criterion needs `git diff --numstat` evidence.

**CI is the test gate.** The pull request's required CI checks run the repository's complete
automated suite. The merge gate already waits for them, and a PR with no check runs never merges
(`CheckRunState::Missing` reads as pending). So nothing else in Sergeant repeats that suite:

- The implement, fix, and repair prompts limit the worker to targeted tests for what it changed
  (`implementation_result_instruction`). The `sergeant.toml` local-validation document now asks for
  a narrowed form of the declared commands, not the whole command.
- The review prompt limits the reviewer to the targeted probes a specific verdict or finding needs.
- The test role runs only validation CI cannot do. `decide::validation_plan::needs_test_run`
  dispatches a test Run only when the Planner named `targeted` checks for the Task's repository, for
  example a live-environment or manual-equivalent check. `none`, a pre-UNF-647 plan's `full`, and no
  plan at all go straight to completion, and CI gates the merge there. The Planner is offered only
  `none` and `targeted`, and its plan summary (UNF-640) reports validation as `CI` or
  `CI plus targeted -- <checks>`. UNF-671: that test Run is dispatched under a versioned
  `test_contract: {version, checks}` in its `resolved_context`, and finalization fails it closed
  unless its result gives exactly one entry per requested check, so an omitted check never reads
  as passed.
- UNF-569's actual-diff upgrade is retired. It turned a planned `none` into a full local test Run
  whenever the diff was not documentation-only, and CI now tests every such change anyway. The
  changed-files classification it read is retired with it. `ArtifactType::ChangedFilesSummary`
  stays so historic rows still parse.

**Human-found misses feed ADR-0039's calibration record.** A new review-decision category,
`human_reported_defect`, is set by a worker whose given human comment reported a defect or unmet
criterion in the candidate as already reviewed or validated. It is the same worker-made call as
every other category. `review_calibration::summarize` counts, per path and category,
`ReviewYield::human_found_must_fix`: clean reviews (no must-fix finding) where a Run continuing
that review or its candidate carries that category. It adds no new outcome fact or table.

## Consequences

- A Task no longer runs the full suite locally at all. The test Run exists only for planned checks
  CI cannot do, so most Tasks lose a whole worker Run. The retro's UNF-639 spent 21.6 minutes in two
  test Runs.
- A CI failure now surfaces through CI observation and the merge gate. Both already route it into
  the same fix loop (`ci_blocked_findings`, `dispatch_fix_for_final_ci_failure`), rather than a local
  test Run finding it first.
- If a repository's required checks do not run its tests, those tests are no longer run before
  merge. Such a repository needs CI that runs them. Merge still requires at least one passing check.
- A review costs a little more context (the claims) and output (one verdict per criterion). In
  exchange, an unmet criterion gates deterministically instead of depending on the reviewer
  choosing to file a finding.
- The reviewer-eval corpus carries three regression scenarios modeled on UNF-639's misses: a
  planner decision contradicting a criterion, an unexamined "accepted trade-off" in a state machine,
  and an unmeasured "net simplification".

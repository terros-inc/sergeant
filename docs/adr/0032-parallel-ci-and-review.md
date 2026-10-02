# ADR-0032: Run GitHub CI and independent review in parallel, drop the pre-review CI gate (UNF-480)

## Status

Accepted. Supersedes UNF-342's pre-review CI-viability gate (`decide/ci_gate.rs`,
`implementation_tick/ci_viability_step.rs`, `task_ci_bypass_grants`) and UNF-463's timing fix for
that gate — both fully removed by this ticket, not just patched further.

UNF-641 ([ADR-0039](0039-worker-decided-independent-review.md)) supersedes the "first review is
mandatory; later candidates carry a review-impact judgment" section below: every candidate-mutating
worker now reports a `review_decision`, and `review_impact` is removed.

## Context

Coding V1's implementation loop (ADR-0031) previously blocked independent review until this
repository's own GitHub CI appeared and passed for a candidate's draft pull request:
`orchestrator::decide::next_step` classified a just-succeeded implement/fix Run's CI evidence into
`Missing`/`Pending`/`Passed`/`Blocked` and refused to dispatch review until it read `Passed`. A
`Missing` read escalated to a human `ci-unavailable` decision (with a one-shot bypass grant) once a
bounded observation window elapsed.

UNF-463 fixed one timing bug in that gate: anchoring the missing-CI window to the evidence
artifact's own durable creation time rather than the mutation Run's finish, after a live incident
(UNF-388) showed GitHub Actions creating a check suite and passing well within the configured
window while the old clock had already escalated.

UNF-479's fresh smoke test reproduced the deeper problem that timing fix couldn't reach: Sergeant
reported no CI for the exact candidate SHA even though the repository's GitHub Actions workflow
existed and succeeded for that SHA. The wrong abstraction was treating "zero check-runs observed
right now" as evidence that CI is unavailable — an inherently racy signal (PR publication and
GitHub's own check-suite creation are asynchronous, unrelated events) that no amount of window
tuning fixes, only shrinks the failure window for.

This also created orchestration complexity out of proportion to what it bought: `Missing` vs
`Pending` states, a CI-missing observation window, repeated pre-review polling, CI-bypass grants, a
human `ci-unavailable` decision kind, a race between PR publication and GitHub Actions visibility,
and a merge-gate CI check (UNF-253/UNF-345) that already re-verifies GitHub's own authoritative
state before merging regardless — meaning a passed pre-review gate never actually replaced that
final check, only delayed review by however long CI's own asynchronous latency happened to be.

## Decision

### GitHub CI is observed opportunistically, never gates review

`decide::candidate_mutation::after_candidate_mutation_succeeded` dispatches independent review
immediately once an implement/fix/repair Run succeeds, regardless of what (if anything) is known
about this repository's own CI for that candidate. Sergeant no longer asks "does this repository
have CI?" as a lifecycle decision at all — there is no `Missing`/`ci-unavailable` escalation path
left to reach.

`implementation_tick::ci_observation_step::refresh_candidate_ci_evidence` runs on every daemon
tick, before `next_step`'s own decision, independent of whatever `LoopStep` that tick otherwise
dispatches (including while a review Run is in flight). It finds the Task's current candidate (the
latest succeeded implement/fix/repair Run), publishes/updates its pull request, and records GitHub's
own freshly-observed check-run state as `CompletionEvidence` — the same evidence shape/artifact type
the final merge gate already used (UNF-342's "the semantic distinction is where this evidence
appears, not a second artifact type"). It stops observing a given candidate once its CI state
resolves to a terminal `Passed`/`Blocked` value, or once independent review has already settled for
it (from that point the final merge gate owns publish/observe against `mergeable_state`, not this
step against raw check-run status/conclusion).

### GitHub owns GitHub policy; Sergeant never guesses CI state

The final merge gate (`completion::complete_candidate`) remains the one authoritative pre-merge
check: it re-reads the exact current PR head immediately before merging and classifies via GitHub's
own `mergeable_state`, never a second reimplementation of branch-protection or required-check policy
(ADR-0020). Required checks pending waits on GitHub; a merge conflict (`mergeable_state == "dirty"`)
routes through the existing same-Task repair Run (ADR-0031); a clean state merges.

For every other `Blocked` reason, the gate additionally inspects the same observed check runs'
own `status`/`conclusion` (never `mergeable_state` for this part — see `merge_readiness::ci_check_state`'s
own doc comment) to tell an actual failing/blocked check apart from `mergeable_state` blocked for
some other policy reason (a required review, branch protection, "behind") it still never
reimplements or guesses at. A real failing check returns `CompletionOutcome::CiChecksFailed`,
routed by `implementation_tick::completion_step::dispatch_ci_check_failure` through
`orchestrator::dispatch_fix_for_final_ci_failure` — the identical shared fix/rethink/escalate budget
review's own must-fix findings already use, never a second budget or an unconditional human
escalation. Every other blocked reason keeps the existing human escalation, since Sergeant has no
principled way to resolve a required-review or branch-protection blocker itself. No LLM or
Sergeant-side heuristic ever decides whether CI exists or passed — that fact comes from GitHub
alone, at both the opportunistic-observation point and the final gate.

### Combine CI and review findings instead of serializing fix cycles

`decide::mod.rs`'s review-succeeded and test-succeeded arms call
`candidate_mutation::ci_blocked_findings`, which reads back whatever CI evidence
`ci_observation_step` already recorded for the exact candidate. When that evidence reports
`CheckRunState::Blocked`, its finding is combined with review's own must-fix findings (if any) into
one `dispatch_fix_or_rethink_or_escalate` call — the same shared fix/rethink/escalate budget review
findings already used, never a second parallel budget. A still-pending or missing CI read at that
moment contributes nothing; it keeps running asynchronously and the final merge gate re-checks it
regardless. An already-running review is never canceled because CI failed.

### The first review is mandatory; later candidates carry a review-impact judgment

`ImplementationResult::CodeChange`/`::Deliverable` gained an optional `review_impact:
Option<ReviewImpactJudgment>` field (`{ impact: Material | NonMaterial, reason: String }`). Every
fix/rethink-fix/repair Run in Coding V1 continues a candidate a review has already been attempted
against (a fix/repair is only ever dispatched in response to a review or CI finding), so these
roles' own prompts ask for this judgment; the Task's first implement Run never has anything to
compare against and never reports one.

`candidate_mutation::after_candidate_mutation_succeeded` dispatches a fresh independent review for
every successful mutation **unless** both: the review directly preceding this exact candidate in its
own mutation lineage (`last_passed_review` — walking `parent_run_id`, through at most one rethink
hop, never scanning the Task's whole history for *any* review that ever passed) actually passed, and
the just-succeeded mutation's own judgment is explicitly `NonMaterial`. In that case the prior
review's certification carries forward — a `CodeChange` candidate proceeds straight to
`DispatchTest`, a `Deliverable` candidate straight to `ReadyToComplete` with `validated_by_run_id`
naming the earlier review Run, not the new candidate's own id. Anything else — `Material`, no
judgment reported at all, or the directly-preceding review itself never having passed — dispatches a
fresh review; a missing, ambiguous, or lineage-broken judgment is treated exactly like `Material`,
never granted a skip. Scanning the whole history for any passed review is unsound: a later material
mutation can dispatch a fresh review that itself fails, and a fix addressing *that* review's findings
must never be certified against an earlier, unrelated review that happened to pass before either of
them existed. This keeps the coding/fix worker as the sole classifier (it already has the prior
findings, task context, and actual diff) rather than adding a second review-impact model.

CI/merge evidence is always re-evaluated against the exact current candidate regardless of the
review-impact judgment — a non-material change still gets fresh CI observation and a fresh final
merge-gate check against its own head SHA.

### What this removes

`decide/ci_gate.rs`, `implementation_tick/ci_viability_step.rs`,
`domain::task_ci_bypass_grants` (migration `0025`, dropped by migration `0033`),
`LoopStep::PublishCandidateForCi`, `LoopStep::DispatchReview::ci_bypass_grant`,
`ActionId::BypassCi`, the `ci-unavailable:` decision kind and its "Configure CI for this
repository, then resume" / "Explicitly allow review to proceed without CI" options, and
`RetryPolicyConfig::ci_missing_escalation_window`.

## Consequences

- Review latency is no longer coupled to GitHub Actions' own queue/runtime latency at all —
  independent review and CI now run concurrently from the moment a candidate's PR is published.
- Sergeant can never again mistake "no check-runs observed yet" for "CI is unavailable" (the
  UNF-479/UNF-463/UNF-388 failure family), because that classification no longer exists as a
  lifecycle decision.
- A repository with no CI configured at all behaves identically to one with CI whose checks simply
  never appear: neither ever blocks or escalates on that basis; the final merge gate is the only
  place GitHub's own state (or its absence) has any effect.
- A material change after review always gets a fresh review; only a coding/fix worker's own
  explicit `NonMaterial` judgment against an already-passed review skips one, so review coverage
  degrades only when the worker itself asserts nothing material changed — a self-report the loop
  still doesn't blindly trust for anything else it already independently verifies (the actual diff,
  `ImplementationResult` vs. git state, exact-head CI/merge evidence).
- The final merge gate's own CI/mergeable-state handling (UNF-253/UNF-345, `completion::
  complete_candidate`) is unchanged by this ticket and remains the sole authority immediately before
  merge.

### Local deterministic validation runs through the existing sandboxed worker, never the daemon

`RepoConfig`'s `ApplicationConfig::build`/`test` fields already existed in `sergeant.toml`'s schema
(UNF-349; Sergeant's own repo config populates both), but nothing executed them before this ticket —
they were descriptive metadata only. This ticket wires them into the exact same `Worker` sandbox
every implement/fix/repair Run already runs inside, never a new sergeant-daemon-side command
execution seam: `implementation_prompts::build_context` reads a repository's declared `build`/`test`
commands and folds them into `ContextSnapshotBody::configuration` (rendered into every dispatched
role's prompt via the same `render_for_prompt` path `repo_instructions` already uses), instructing
the worker itself to run the relevant command(s) before committing a final result and to not report
success while one fails. A repository with no `sergeant.toml`, or no declared `build`/`test` command,
sees no behavior change at all.

The sergeant-daemon process itself never executes a repo-declared command directly — doing so would
be a new trust boundary (the daemon running arbitrary repo-supplied shell strings, rather than the
already-sandboxed worker that already has full shell access inside its own workspace) that would
deserve its own deliberate security review, not something to add as a side effect of this lifecycle
simplification. The existing `ROLE_TEST` post-review worker Run continues to provide its own
independent test execution, unchanged, through the same sandboxed `Worker` path.

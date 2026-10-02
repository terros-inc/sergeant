# ADR-0031: Coding V1 task lifecycle, integration ownership, waits, and workspace retention (UNF-470)

## Status

Accepted. Amended by [ADR-0038](0038-planner-first-repository-selection.md) (UNF-569): the Task's first Run, the Planner, no longer claims the retained mutation workspace -- it runs repo-less, and the first implementation Run creates that workspace.

This ADR partially supersedes ADR-0013 only where ADR-0013 says Sergeant does not persist a
Task's workflow stage and can recover that stage from Linear or the latest Run. ADR-0013's other
simplifications remain in force: Task/Run stays the durable core, `TaskState` stays the small
ACTIVE/WAITING/DONE/CANCELED execution-disposition model, Linear remains the only V1 task source,
and no generic task-system or workflow abstraction returns.

## Context

Sergeant's implementation loop already performs planning, implementation, independent review,
testing, GitHub evidence collection, and final merge. It persists the Runs and their evidence, but
the current lifecycle position is inferred from the latest Run's role/status. That is insufficient
for recovery at the boundaries where no Run is needed, where a phase contains multiple Runs, or
where Sergeant must record that a candidate moved backward after verification found a problem.

`TaskState` answers a different question: whether Sergeant may currently work the Task, is paused,
or has terminated it. Expanding it into combinations such as `WAITING_FOR_CI` or
`IMPLEMENTING_NEEDS_DECISION` would couple two independent dimensions and recreate the detailed
state enum ADR-0013 deliberately removed.

The existing `next_check_at` timestamp is also not a wait record. It says only when to wake up; it
cannot say what external authority Sergeant is waiting on, which candidate the evidence applies
to, how long the wait has existed, or what happens at its deadline.

Coding V1 deliberately narrows the product around one delegated Linear issue and one repository.
The worker owns local reasoning, edits, commits, tests, and code-level conflict resolution.
Sergeant owns the durable lifecycle, repository workspace, dispatch, Linear and GitHub writes,
candidate publication, evidence validation, retries, waits, and final merge.

## Decision

### One explicit phase beside `TaskState`

Every Task persists one `current_phase`:

1. `PLANNING`
2. `IMPLEMENTATION`
3. `VERIFICATION`
4. `FINALIZATION`
5. `DONE`

`TaskState` remains separate:

- `ACTIVE` means Sergeant may take the next lifecycle action.
- `WAITING` means progress is paused on authorized external input.
- `DONE` and `CANCELED` remain terminal outcomes.

A Task is created in `PLANNING`. A successful completion moves both state and phase to `DONE` in
one transaction. Cancellation preserves the phase at which work was abandoned for diagnosis.
Phase changes are compare-and-set, transactionally recorded in an append-only transition table,
and applied before the action belonging to the new phase. If the process stops between the phase
change and dispatch, the next tick sees the persisted phase and repeats only the still-missing
action.

The current Run history remains evidence within a phase; it is no longer the only representation
of lifecycle position. Planning may have a simplifier Run, implementation may have several
implement/fix/repair Runs, verification may have CI observations and review/test/certification
Runs, and finalization may contain no worker Run at all.

The fixed phase mapping for Coding V1 is intentionally code, not configuration:

- planning dispatches and evaluates the existing simplifier;
- implementation dispatches candidate-mutating implement/fix work;
- verification collects candidate-bound GitHub and independent-worker evidence;
- finalization performs Sergeant-owned GitHub completion and the exact-head gates already required
  by policy;
- a verification failure that needs candidate mutation returns to implementation, and the new
  candidate must be verified again;
- (UNF-539) a finalization gate whose findings exhaust the fix budget returns to verification for a
  non-mutating rethink (`FINALIZATION -> VERIFICATION`).

UNF-539 also settles what happens when the step derived from Run history is not one legal edge
from the persisted phase: Sergeant records the intermediate hop(s) only when Run history proves
them (a candidate whose passed review was carried forward) or a human answers the resulting
`phase-mismatch:` decision; otherwise it escalates that decision once rather than failing every
tick. A Run that became durable without its phase transition pulls the phase up to its role's
phase before the next decision.

There is no workflow DSL, task-type registry, or generalized phase-handler framework.

### Waits are a separate durable record

A Task may have at most one open external wait. The wait records:

- reason: `GITHUB_EVIDENCE` or `HUMAN_INPUT`;
- the external identity (for example the PR URL or Linear issue id);
- the candidate Run identity when the wait is candidate-bound;
- when waiting began;
- the next authoritative recheck time;
- the deadline;
- the defined timeout action;
- when the wait was cleared.

For a human decision, that same wait also stores the stable decision id, question/context, exact
choice labels and stable action ids, and the latest interpretation/application outcome. This is
the one active durable representation of the decision; there is no parallel decision Task.

Recording the same logical wait again is idempotent: it preserves `started_at`, advances the next
recheck, and never creates a second open row. Replacing the subject or candidate closes the prior
wait and opens a new one. Clearing a wait is also idempotent.

The timeout actions are deliberately small and integration-specific: refresh GitHub evidence or
refresh Linear and keep the Task surfaced for human attention. Reaching a deadline never deletes,
cancels, or silently advances the Task. `next_check_at` remains only the scheduler projection of
the open wait/retry; the wait row is the semantic authority.

A running worker is not a wait. Worker capacity, retry backoff, and drain state remain scheduling
concerns. Authentication, storage, or provider failures remain operational errors unless a real
decision is required.

### Linear and dependency ownership

Sergeant re-reads Linear blockers both while reconciling and immediately before a new mutating
Run. A delegated issue materialized while blocked remains Planning/WAITING with a Human Input wait
and becomes ACTIVE when blockers clear, even if it has never run before. If a blocker is added
after admission, Sergeant does not begin another mutating Run until it clears. An already-running
Run is allowed to finish and be finalized; the next mutation is the admission boundary.

Human questions are comments on the original Linear issue. The ask, clarification, and
acknowledgment each carry a deterministic marker, so a duplicate tick, restart, or
outcome-unknown Linear write reconciles before posting again. Before any interpretation runs,
Sergeant classifies whether a reply is even attempting to answer: a bare number, an `Answer: ...`
marker, or an exact offered label/action id. Ordinary discussion that matches none of these is not
a decision attempt at all -- Sergeant ignores it entirely, posts nothing, and the same wait stays
open exactly as it was, with no clarification and no interpreter call. Only a reply already
classified as an answer attempt is parsed deterministically or, for an `Answer: ...` reply that
doesn't match verbatim, interpreted through the existing typed decision interpreter for an
unambiguous paraphrase -- that interpreter is never reachable from arbitrary discussion, only from
a comment that already looked like an attempt to answer. The typed request contains the decision
id and schema version, candidate Run identity, human comment, and every offered choice keyed by
its stable action/choice id -- every offered choice a real transition Sergeant can apply, never a
non-mutating hold (see below). Sergeant validates every selection against that stored finite
choice set and applies machine effects only through the existing `ActionId` boundary. Provider
errors, invalid output, an unoffered choice, ambiguity, or confidence below the fixed authority
threshold on an actual answer attempt all clarify and hold rather than guess.

The Task wait durably records the provider/model, returned choice, full probabilities and
confidence, validation result, validated choice id, and eventual action result. This record is
bound to the decision schema, candidate Run, and Linear comment, so a restart can reconcile the
same interpretation without authorizing a newer candidate. A candidate change opens a new wait
and posts a candidate-specific ask marker; comments predating that ask cannot answer it.

TypeSafe/Jev remains shadow-only by default. `SERGEANT_JEV_AUTHORITATIVE=true` is the one narrow,
explicit promotion gate. When enabled, Jev supplies the semantic selection and Claude is not a
fallback: Jev being absent or failing follows the same fail-closed clarification path. The gate
must remain off until real shadow evidence has been reviewed; retiring the Claude interpreter is
a later explicit decision, not an automatic consequence of enabling or implementing this path.
Ambiguity produces one clarification on the same issue; it never creates a recursive "Decision
needed" issue. A human comment is sufficient: no issue resolve or workflow-state edit is
required.

The answer and acknowledgment are persisted before the Task returns to ACTIVE. The `HUMAN_INPUT`
wait itself is the hold: Sergeant is already stopped, waiting for a human, from the moment it
opens one, so a decision's own offered choices never need a separate non-mutating "investigate" or
"hold" option to represent that state -- every offered choice is something Sergeant can actually
do (retry/fix, a bounded continue/override where appropriate, or cancel). Accepted planning/
rethink answers are read by the next-step decision logic as durable overrides, so unchanged worker
evidence cannot immediately ask the identical question again. Historical decision issues remain
readable during migration, and a wait whose already-recorded answer names a since-retired choice
(for example, an old "Investigate manually" selection, offered by decisions asked before this
invariant) keeps resolving to that same safe no-op hold rather than erroring or misbehaving -- but
no new decision menu offers that choice, and no new reconciliation infrastructure exists around
that legacy state; an unanswered historical issue stays waiting rather than generating a
replacement issue.

### GitHub evidence and candidate identity

GitHub waits are bound to both the PR identity and candidate Run. Every recheck obtains fresh
GitHub evidence. Existing exact-head certification remains the authority for whether evidence
applies to the current head. Any candidate mutation changes the candidate Run identity, closes the
old wait, and makes old candidate-bound evidence inapplicable without deleting its audit record.

### Merge conflicts are implementation repair

A merge/rebase conflict does not create another Task or PR. Sergeant refreshes the retained
repository state and dispatches a candidate-mutating repair Run on the same Task and candidate
lineage. The phase returns to Implementation; after the repair commit, the new candidate returns
through Verification. A conflict requiring a product or architecture choice records a Human Input
wait instead of guessing.

The conflict is caught before a candidate's next review, test, deep-assurance, fix or rethink-fix
Run, not only at the merge gate (UNF-646): Sergeant re-reads the candidate PR's mergeability
immediately before dispatching one, and `mergeable == false` or `mergeable_state == "dirty"`
dispatches the repair instead. While GitHub is still computing mergeability (after a push or a base
move) the Run waits for its answer. A repair held ahead of a fix takes the fix's trigger as its
parent, like a fix Run, and once it resolves the loop resumes that same fix -- its findings rebuilt
from durable evidence -- against the repaired candidate. A repair held ahead of a review carries
forward the review its candidate still owed; only a review whose report was durably persisted
counts as having discharged it.

### Workspace retention

An unfinished Coding V1 Task's working copy is authoritative and ineligible for age-based cleanup,
including while the Task is WAITING. Workspace cleanup may consider only workspaces belonging to
terminal Tasks (`DONE` or `CANCELED`) and still applies the existing dirty/unpushed safety checks.
Disk pressure stops or defers new admission and surfaces an operator problem; it never broadens
cleanup to unfinished work. Terminal workspaces may be removed after the configured grace period.

UNF-471 implements that authority as one physical branch-backed mutation workspace per Task.
Sequential planning, implementation, fix, and repair Runs claim and reuse it without changing its
original base, so candidate diffs and cleanup safety cover the whole Task lineage. A durable
Run-to-workspace association preserves candidate lookup after ownership passes to a later Run.
Non-mutating observation Runs remain separate detached worktrees at an exact candidate SHA.

### Repository boundary

Coding V1 admits one repository per Task. Run-level repository provenance remains useful, but a
mutating Run cannot silently change the Task's repository. Work that genuinely spans repositories
must be planned outside Coding V1 and represented as separate, explicitly-dependent coding issues.

## Consequences

- Restart recovery reads the Task's explicit phase and open wait before deciding work; a phase is
  not reconstructed solely from the newest Run.
- Duplicate ticks can observe the same phase action safely because phase changes, open waits,
  Run creation, outbound Linear writes, and candidate evidence retain their existing idempotency
  boundaries.
- Linear contains one coding issue and a comment conversation for its decisions; decision answers
  alter the next lifecycle action without manufacturing or resolving child issues.
- The existing Task/Run, Linear, GitHub, certification, and workspace modules remain the mechanism;
  this ADR adds the missing durable lifecycle facts rather than replacing them.
- Operator and UNF-468 Linear presentation work can expose one unambiguous phase/wait record.
- ADR-0013's claim that detailed workflow need not be persisted is narrowed only for this fixed
  Coding V1 lifecycle. Its rejection of speculative generic workflow machinery still stands.

## Non-goals

- generic workflow DSL or distributed workflow engine;
- arbitrary task-type registry or four-task-type framework;
- multi-repository coding Tasks;
- worker-server migration or resuming an individual worker process;
- new orchestration service, queue, or message bus.

# 08 — GitHub contract

GitHub is the source of truth for code, branches, PRs, CI results, required checks, and the hard
merge boundary (rulesets). The worker does all ordinary git and PR mechanics. Sergeant reads facts,
links PRs to the Linear issue, and merges under the Gate's rules.

## 1. Two GitHub identities per installation

| App | Held by | Permissions on enrolled repos | Used for |
|---|---|---|---|
| **control-plane App** | Sergeant's deterministic core only | contents: write (merge), pull_requests: write, checks: read, metadata: read; webhooks | reading facts, approving then merging a gated head, closing a stopped task's PRs and deleting their `sergeant/` branches (§3), nothing else |
| **worker App** | never held directly; Sergeant mints one-hour installation tokens per run, scoped to the task's repository set (04 §9) | workers: contents: write, pull_requests: write, checks: read, actions: read, metadata: read. Reviewers: none (the host checks out their PRs with a read-only token that never enters the run) | pushing branches, opening and updating PRs, reading CI logs |

Why two: the default-branch ruleset must let Sergeant merge and must stop a worker from pushing to
or merging into the default branch. The worker's contents write would let it merge its own green PR,
so the ruleset requires an approving review: GitHub never lets a PR's author approve it, and only the
control-plane App supplies that approval, inside the gated merge (§7). The worker therefore needs a
different actor from the one that approves and merges. Neither App has administration, secrets,
environments, deployments, `workflows`, or `actions: write` (which could dispatch workflows)
permissions.

## 2. Repository enrollment

Enrollment is configuration (`sgt config repo add <slug> --purpose ... --merge-policy ...`). Before a
repository is enabled, the operator confirms this checklist (`sgt doctor repo <slug>` checks what it
can through the API):

1. Both Apps are installed on the repository.
2. The default branch has a ruleset that requires a PR, required status checks, and at least one
   approving review, and the worker App is **not** a bypass actor. (The worker App authors the PR
   and so cannot approve it; only the control-plane App's gated approval, §7, lets the merge
   through.)
3. Required checks run the repository's full automated suite (CI is the test gate, S1 ADR-0041).
   A repository with no required checks cannot be merged by Sergeant (M5).
4. **No production secret is reachable by workflows that run for pull requests or non-default
   branches.** Worker-authored code runs in CI. Production deploy credentials belong in protected
   environments that only default-branch workflows with approval can use (09 §5).
5. The Linear GitHub integration is connected, so a merged PR with `Fixes <IDENTIFIER>` closes the
   issue (07 §7).
6. `mergePolicy` is set deliberately: `sergeant` or `human`. **If merging to the default branch
   deploys to production, merging is a production action** and the policy is `human` (09 §5; settled,
   `14` §A).
7. Optionally, `alwaysReviewPaths` for paths where a skip should never be accepted (CI config,
   infrastructure, auth).

## 3. Branches

Runner-owned. Convention, stated in the worker rules (05 §3):
`sergeant/<IDENTIFIER>-<short-slug>`, one per repository per task. The convention helps humans and
candidate discovery (§4). It is not used for authority. Workers never push to default branches
(enforced by the ruleset) and force-push only their own branches.

GitHub's "delete branch on merge" removes a merged PR's branch. When a task's stop closes a PR the
worker App opened, Sergeant deletes its branch after the close (TECH-5230), only if it starts with
`sergeant/`, is in the PR's own repository (not a fork), no other open PR is from or onto it, and its
tip is still the PR's head. A failed delete is logged and never fails the stop.

## 4. Which PRs belong to a task

**The Linear issue's GitHub PR attachments are the association.** They are human-visible and
human-editable, and survive loss of the ledger.

- **Worker-reported PRs**: when a report names a PR, a guardrail links it (Linear attachment) if the
  PR exists, its repository is in the task's set, and its author is the worker App (05 §6).
- **Candidates**: open PRs in the task's repositories whose branch follows the convention for this
  issue, or whose body references the identifier, but which are not linked, appear in the
  Situation Report as `candidatePrs`. Sergeant links them with `link_pr` if they belong.
- **Human-attached PRs**: a human attaching a PR in Linear links it. A human removing the attachment
  unlinks it. Sergeant respects both.
- `unlink_pr` removes a PR Sergeant decided does not belong (abandoned approach, superseded PR).

Routing GitHub webhooks to tasks uses an in-memory index from PR to task, built at startup from
open tasks' attachments and updated on every link and unlink. A webhook for an unknown PR is
dropped; the reconcile poll covers it.

## 5. Multiple PRs per task

No special orchestration. Each PR has its own CI, its own head, and its own review disposition. The
worker says how they relate (`note`, `mergeOrder`) and which one closes the issue (`closesIssue`).
Sergeant merges in that order, and checks that only the last one to merge carries the closing
reference (M9, 07 §7).

## 6. CI facts

FactReader reads, for each linked PR's head SHA:

- the required checks for the PR's base branch (from rulesets and branch protection);
- check runs and commit statuses for that exact SHA;
- an `overall` summary: `passed` (every required check succeeded), `failed` (any required check
  failed or was cancelled), `pending`, `missing` (a required check has not reported at all yet), or
  `not_run_conflict` (the PR conflicts with its base, so GitHub does not run `pull_request` CI).

`missing` and `not_run_conflict` are never reported as failures (S1 retro F1: "no CI" read as "CI
failed" sent a $3 rethink at an unrelated file). For failed checks, `get_ci` returns names, URLs,
and a bounded log tail, enough for Sergeant to brief a worker. The worker reads full logs itself
(`actions: read`). Sergeant never re-runs CI; a worker retriggers by pushing.

## 7. Merging

`merge_pr(repo, number, expectedHeadSha)` (carrying the proposing turn's `conversationRevision`, 03 §5) is
allowed only when every rule holds, checked against
live GitHub and Linear facts at execution time:

| Rule | Check |
|---|---|
| M1 | the repository is in the task's set, enrolled, enabled, and its `mergePolicy` is `sergeant` |
| M2 | the PR is linked to the task's issue |
| M3 | the PR is open and not a draft |
| M4 | the PR's live head SHA equals `expectedHeadSha` |
| M5 | the base branch has at least one required check, and every required check passed on `expectedHeadSha` |
| M6 | a `ReviewDisposition` exists for this PR at `expectedHeadSha` and still passes D1–D6 against the evidence recorded by now (06 §6) |
| M7 | GitHub reports the PR mergeable: `mergeable` is `true` and `mergeableState` (GitHub's `mergeable_state`) is `clean`, `unstable` (past M5, only non-required checks failed), or `blocked`. Every PR waiting for Sergeant is `blocked`, because the ruleset's required approval is the one Sergeant gives just before merging (§2); a block that approval does not lift makes GitHub refuse the merge, which M12 hands to a human. Refused, naming the state: `unknown` or `mergeable: null` (GitHub is still computing; wait), `dirty` or `mergeable: false` (conflicts with its base; a worker rebases), `behind` (a worker rebases), `draft`, and `has_hooks`. A value GitHub adds later reads as `unknown`. None is a policy refusal: a later read that changes them wakes a turn (TECH-4991, TECH-5013) |
| M8 | no `sergeant:hold` label on the issue or the PR, and no outstanding human "changes requested" review on the PR: no human whose latest review, at any head, is `CHANGES_REQUESTED` (a later approval by that human or a dismissal clears it; a later plain comment does not). Built: the review check (TECH-4987); the label is not |
| M9 | if any other PR linked to the task is still open, this PR's body does not carry a closing reference to the issue |
| M10 | re-read Linear and the PR: the current conversation revision (issue title and description, every human comment's id and `updatedAt`, and every human review and comment on the task's PRs: id, `updatedAt`, review state, and body hash) equals the `conversationRevision` the proposing turn saw. Otherwise refuse and wake the task, so a fresh turn decides with the new input in front of it (no locking; a comment arriving in the instant between this read and the merge is an accepted race) |
| M11 | no run of the task is running, including one started earlier in the same turn; and once a merge succeeds, no later action in that turn executes |
| M12 | GitHub has not already refused merging this PR at `expectedHeadSha` by repository policy against the same live conversation revision (see below) |
| M13 | the run whose review or skip gives the head its standing started from the issue's current title and description (its recorded `issueRevision` equals the live one), so the work is judged against the current acceptance criteria, not the text the worker started from (TECH-5034). A record without one, from before runs recorded it, is not judged |
| M14 | every input a run reported it could not read (`unreadableInputs`: an auth-gated link, a missing file or attachment, an issue file not downloaded) is named in a Sergeant question on the issue (a comment starting with "**Question for you**"; other bot comments do not count): reasoning asked a human about it. Q1 then holds the task only until a human next changes the conversation, which need not be an answer; M14 checks that the question was asked, and the turn that follows judges whether the change answers it (TECH-5034) |

Plus G1–G3 (not paused, task open, PR belongs to the task). Budget exhaustion does not block a merge:
merging spends nothing, and landing finished work is the cheapest way to stop.

Each M rule exists for a material risk: M1, M3–M7 and M9 for an unreviewed, red, or wrong-head merge
(L1, and L2 where a merge deploys); M2 so only this task's PRs are merged; M8 and M10 so a human's hold,
requested changes, edit, or comment that no turn has seen is never overtaken (L4); M11 so a merged
task leaves no live worker, reviewer, or follow-up started after it (L3).

Execution: once M1–M11 and G1–G3 pass, the control-plane App submits an `APPROVE` review with
`commit_id = expectedHeadSha`, then immediately calls GitHub's merge endpoint with
`sha = expectedHeadSha` and the repository's `mergeMethod`. A failed approval stops the merge. A head
that moved in between is refused by GitHub (M4 again). On a retry, "already merged at that SHA"
counts as success. The merged SHA goes in the action result. A merge GitHub refuses by repository
policy (405, or `merged: false`: a required review Sergeant cannot give, such as a code owner's) is not
retried while nothing changes (M12): Sergeant records it, posts one Linear comment
that the PR is ready for a human to merge (its link and the reviewed head), and waits. A changed head,
a new human review or comment, or a human edit on the issue lets a later turn try again. A temporary
405 is not policy and fails the action instead, so a later turn retries: "Base branch was modified", or
"Pull Request is not mergeable" while GitHub is still computing mergeability (M7 normally refuses that
first). After every merge attempt, whether it succeeds, fails, or is refused, the loop commits the
turn's fingerprint; an unchanged poll therefore does not spend another reasoning turn. When M7 denies
a merge for a PR that the turn's poll saw as mergeable, the committed fingerprint records that PR as
`mergeable: null` and `mergeableState: unknown`, matching the merge preflight's later read; a PR the
poll already saw M7 refuse (`behind`, say) is recorded as it was, so the same facts wake no turn. The first poll that reports definite
mergeability again then differs and wakes exactly one turn. `baseSha` is also part of the fingerprint,
so a moved base wakes a turn even when the other PR facts are unchanged. A failed `ask_human` is the
only action outcome that leaves the fingerprint uncommitted, so the question can be retried after the
next poll or a restart. The Linear issue's Done state follows from automation, not from Sergeant
(07 §7).

Where `mergePolicy` is `human`, Sergeant gets the PR ready (green, reviewed, disposition recorded),
says so in Linear once if useful, and waits. A human merge triggers automation as usual.

## 8. Moved bases and conflicts

Facts in the Situation Report: `mergeable` and `mergeableState` (built), `behindBy` and `not_run_conflict` CI
(not built).
The worker owns rebasing and conflict resolution (05 §3). Sergeant decides when it matters:

- a running worker: `send_run("main moved and PR #12 now conflicts; rebase it")`;
- no running worker: start one (or continue the last) with the conflict as its objective;
- after the rebase, the worker's report says whether the conflict resolution was material
  (`sinceReviewedSha`), which decides whether another review is needed (06 §3);
- a conflict that needs product judgment comes back as a question.

Sergeant does not rebase, merge main into branches, or resolve anything itself.

## 9. Webhooks and reconciliation

Webhooks (`pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment` on a
PR, `check_suite`, `check_run`, `status`, `push`)
are verified by signature and translated into wake reasons for the owning task. Nothing else happens
on a webhook. A reconcile poll every 5 minutes refreshes facts for linked PRs of open tasks, so a
missed webhook delays a turn but loses nothing.

## 10. Humans on GitHub

- **A human pushes to a worker's PR**: the new head has no worker recommendation. Sergeant starts a
  reviewer, or an approver waives (06 §3).
- **A human requests changes or leaves a review comment**: every human review and comment on a task PR
  (author, state, body, file/line) is in the Situation Report and the conversation revision, so it
  wakes a turn. Reasoning treats a request for changes as a blocking finding that outranks Sergeant's
  own reviewer, and continues the work on the same PR; a successor's brief carries the feedback. M8
  blocks the merge until that human approves or the review is dismissed. Once the PR's current head
  has addressed the request (it was left on an earlier head), has review standing, GitHub reports it
  mergeable, and every required check passed on it, Sergeant posts one Linear comment per head naming that human and linking the PR,
  asking them to re-review or dismiss (TECH-4992). It is keyed by the head, and Sergeant rereads the
  issue's comments rather than recording it: a new head that reaches the same point asks again. Like
  a handoff, it is posted even while the task is held for budget: it costs none, and the human's
  re-review is needed whatever the budget decision.
- **A human merges or closes a PR**: a fact. A merge with a closing reference completes the issue
  through automation.
- **A human approves**: informative; it does not replace the fresh-review disposition unless an
  approver waives it explicitly in Linear.

## 11. What Sergeant never does on GitHub

Push code, create branches, delete a branch other than a closed PR's (§3), open PRs, rebase, resolve conflicts, comment on PRs, approve a PR other
than as the first step of its gated merge (§7), change settings, rulesets, secrets, or workflows, or
dispatch workflows.

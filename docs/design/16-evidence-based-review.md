# 16 — Evidence-based review and earned merge autonomy (proposal)

**Status: proposal (TECH-6605), pending approval. Nothing here is built. Approval authorizes only
stage 1; later stages remain vision requiring separate decisions.** §10 marks the exact stage-1
contract changes and the possible later changes separately. Written against `main` at `a84f38c`. People, repositories and SHAs in the examples are
placeholders.

## 0. Summary

We want to learn when an extra review helps, and when Sergeant has earned the trust to merge a
production PR without a human. The alternative under way is a static map that sorts every file path
of a repository into review tiers, then gates review counts and merge rights by tier. This proposal
replaces it with **evidence we can count**, plus a **small number of deterministic boundaries** that
GitHub enforces. It starts small, and adds data only when a question needs it.

### Authorization boundary

This document separates the ambitious destination from what approval of its first implementation
would authorize:

| Authorized first implementation (stage 1) | Vision only; requires later approval |
|---|---|
| Add one immutable, full-SHA-bound readiness line to Sergeant's existing per-head PR summary, in every repository | Expanded post-merge audits, audit enrollment and public audit comments (stage 2) |
| Keep the readiness comment id and reason in the existing task records | Earned autonomous merge, shadow human-review samples and the provisional change-management definition (stage 3) |
| Reconcile declarations against human merge or explicit-rejection evidence already in GitHub, and report the simple agreement fraction through one read-only `sgt` command | New review measures, richer external-review metadata, reviewer-position analysis, APIs, a generalized review framework, or any other instrumentation |

Stage 1 reuses the current review, task-record, handoff and GitHub adapter machinery. It adds **no
new service, database, policy engine, trust score, dashboard, Gate rule, evidence index, API, audit
behavior or generalized review framework**. Sections describing later stages explain the intended
direction and tradeoffs; they are not implementation requirements and approving this proposal does
not authorize building them.

- **One readiness declaration per head** (§4). When Sergeant judges that the reviews and checks are
  enough, it posts `READY TO MERGE | SHA: <full head SHA>` with a short reason on the PR, before any
  human acts. It never edits that comment. A new head gets a new assessment. This is the handoff
  summary Sergeant already posts, with a fixed first line added. It is posted in every repository,
  including those where Sergeant already merges.
- **Agreement is simple** (§5). Only the declaration is measured. If a human merges exactly the head
  SHA Sergeant declared ready, the declaration succeeded (**AGREED**), even after asking for more
  reviews or waiting a week. If a different head is merged after the declaration, it failed
  (**DIFFERENT_HEAD**). An explicit human rejection is **REJECTED**. Asking for more reviews and
  revising before the declaration is ordinary iteration and counts neither way. Everything
  uninterpretable is **UNKNOWN** and is left out of the rate. Squash and rebase merges compare the
  PR's frozen pre-merge head, never the merge commit.
- **Later measurement vocabulary** (§2.1; not stage 1). *Changes required (blocking)*: a review with at least one
  blocking finding. *Review was valuable (feedback)*: a human review that says anything beyond a plain
  approval. Each report says which one it uses; the agreement rate uses neither.
- **Stage 1 uses only the review evidence that already exists** (§2): Sergeant's own reviewer
  verdicts, which `reviews.jsonl` and the run records already hold, and GitHub's native reviews, which
  GitHub already binds to a commit. Nobody is asked to write anything new.
- **Judgment, not counts, decides who else looks** (§3). The worker says whether another review is
  worthwhile, and reasoning can start one. There are no fixed reviewer counts and no path tier map. The
  few hard boundaries stay deterministic, in GitHub rulesets and Sergeant's existing Gate.
- **Independent retrospective audit** (§6, stage 2). The existing stable-hash audit draw is widened
  from "merged Sergeant heads that skipped review" to 1 in 10 of all merged PRs, Sergeant's or not, in
  the first repositories working toward auto-merge; other repositories are added once the audit
  numbers look trustworthy. Each audit is a fresh reviewer judging the code and requirements as
  of the merge. It records `Found: YES | NO` and never blocks. In a public repository, the PR gets only
  the verdict line and code-only findings that pass a deterministic public-data filter. The full
  details stay in Sergeant's records and Linear (§6.4).
- **Autonomy has to be earned and granted** (§8, stage 3). The target is about 90% AGREED out of the
  evaluated decisions, over a meaningful sample (suggested: 50 per repository). Meeting it only
  invites a human to set the repository's
  existing `mergePolicy` to `sergeant`. Nothing escalates automatically. Once a repository has
  auto-merge, a small random shadow sample of its ready heads still goes to a human instead (§8). §8.1
  records a **provisional** definition of a "significant" change for the
  organization's change-management control, pending the auditor's review.
- **Queryable reporting, no dashboard** (§7). `sgt review readiness` in stage 1 and `sgt review audits`
  in stage 2 print counts and rates with their numerators and denominators.
- **Later, only on demand: richer review evidence** (§15). A company-wide review convention is **not
  part of stages 1–3**. It gets its own design only when a specific question justifies the added
  metadata and machinery.

The economical core of stage 1 is **one parsed line on Sergeant's own comment, the agreement rate
computed by rereading GitHub, and one `sgt` command.** That is the complete authorized first
implementation.

## 1. What changes and what stays

| Existing machinery | Stays | Changes (stage) |
|---|---|---|
| Fresh-context reviewer runs (06 §2–5) | The required review is still a separately launched reviewer run. The brief already carries human and bot PR feedback and earlier reviews | Stage 1: none; its verdict is read from the records that already hold it (§2). Stage 2: each PR in the report's `reviewed` list gains its own `found`, which the audit's YES/NO needs (§6.3) |
| Review dispositions and D1–D6 (06 §6) | Unchanged. No stage changes a Gate rule. GitHub reviews are evidence and reasoning input, not disposition standing | D4 stops naming the unbuilt `alwaysReviewPaths`. The built protected-CI matcher (M15) stays the deterministic part (§3.2) |
| Calibration sampling, 20% of skipped reviews (06 §8, `audit.ts`) | The stable-hash draw `auditDrawn(rate, head)`, the nonblocking audit reviewer, the after-merge follow-up | Stage 1: none. A later stage may correct the prose to the built after-merge behavior and add the audit changes in §6 |
| Review telemetry, `reviews.jsonl` (06 §9) | Every finished review still writes its `ReviewFacts` line | Stage 2: each reviewed PR in `ReviewFacts.subject` gains that PR's `found` and the id of the audit comment posted on it |
| Handoff summary on the PR (08 §7, TECH-5244, TECH-6374) | One comment per head, posted by the control-plane App, older heads' copies minimized (minimized, not edited) | Stage 1: it starts with the readiness line and lists the evidence on that head. It is also posted in `sergeant`-policy repositories, just before the gated approval (§4) |
| `mergePolicy` (08 §2, §7) | The only switch for who merges. It defaults to `human`, and only an operator sets it | Stage 3 defines the evidence a human looks at before setting it to `sergeant`, and adds a shadow sample of ready heads still handed to a human in `sergeant`-policy repositories (§8) |
| Rulesets, required checks, M1–M15 | Unchanged. Sergeant never changes rulesets | A repository's hard human-review boundaries live in its ruleset's required-reviewer rule. They should stay a short list, not a tier map (§3.2) |
| Public-data check (`check-public-data.mjs`, the installation's `publicDataDenylistSecret`) | The canonical check and its denylist, as the pre-push hook and CI use them | Stage 1: the core runs it on model-written readiness text before posting it on a public repository's PR (§4.1). Stage 2: the core also runs it on every audit comment (§6.4) |
| `sgt review quality` (designed, 06 §9, not built) | Its metrics, unchanged and not scheduled by this proposal | Stage 1 adds only `sgt review readiness`; a later approval may add `sgt review audits` (§7) |

## 2. Review evidence in stage 1

Stage 1 counts only evidence that already exists and needs no new convention:

| Evidence | Where it already is | Read as |
|---|---|---|
| **Sergeant's reviewer verdict** | The reviewer run's report (`approve`, `changes_requested`, `needs_human`) and its `reviews.jsonl` line, both keyed by run id and the reviewed `{ repo, number, headSha }` | `approve` passes that head; the other two do not. The reviewer is identified by its run id and model provider |
| **GitHub native review** | The PR's reviews: `APPROVED`, `CHANGES_REQUESTED` or `COMMENTED`, each with the reviewing account, its type (`User` or `Bot`), its time and its `commit_id` | `APPROVED` passes that commit and `CHANGES_REQUESTED` does not. `COMMENTED` is a review with no verdict |

Identity is the GitHub account (login and `User`/`Bot` type) for a native review, and the run id for
Sergeant's reviewer. Nothing is parsed out of comment text, so nothing a commenter types can claim an
identity or a verdict. A review by the PR's own author, or by Sergeant's worker App on a Sergeant PR,
is recorded but never shown as independent.

**Sergeant's gate approval is not evidence.** In a `sergeant`-policy repository the control-plane App
submits a native `APPROVE` inside every merge (08 §7), including merges no reviewer saw. That approval
is a gate mechanism, and every report skips reviews by Sergeant's own Apps (recognised by their
configured `<slug>[bot]` logins, since the reviews API carries no App id). The review behind it, if
any, is the reviewer run's own record.

What stage 1 cannot answer is whether a review **found something new**, or how reviewers in
different positions compare. GitHub's native reviews carry no such field, and asking every reviewer
in the company to add one is the review-line extension of §15. It waits until a specific question
needs that data. The post-merge audit (§6) records `Found` for its own reviews from stage 2.

### 2.1 Two separate measures of a review (later-stage vocabulary, not stage 1)

These definitions keep two questions distinct in the longer-term vision. **Stage 1 does not add,
record or report either measure.** It relies on the Gate's existing treatment of review verdicts
before readiness and otherwise preserves existing review evidence without new instrumentation.

Each review in §2 is recorded with two yes/no measures. They answer different questions, are
computed separately, and are never combined into one score.

| Measure | Question | Yes when | Read from |
|---|---|---|---|
| **Changes required (blocking)** | Did this review stop the head as it was? | The review has **at least one blocking finding**, however small the fix | A Sergeant reviewer run with any `blocking` finding or a verdict other than `approve`; a GitHub native review in state `CHANGES_REQUESTED`; an audit with any `blocking` finding |
| **Review was valuable (feedback)** | Did the reviewer have anything to say? | A **human** review carries **any feedback beyond a plain approval**: non-blocking comments, nits and questions all count | A native review by a `User` account other than the PR's author, its inline comments, and that account's PR conversation comments on the same head. **No** only when it is an `APPROVED` review with no inline comment and a body that is empty or, trimmed and lower-cased without punctuation, one of a short fixed list (`lgtm`, `looks good`, `looks good to me`, `ship it`, `👍`) |

The broad blocking measure deliberately counts small fixes. The feedback measure is deliberately
structural and errs towards yes: anything other than a bare approval counts, so no code has to judge
whether a comment was useful. Both are computed when a report runs, from GitHub and the run records,
and stored nowhere.

If a later stage is approved, calculations use them as follows:

- **The readiness declaration** (§4) is made only on a head with no outstanding changes-required
  review, which is what M8 and the D-rules already enforce. It uses the blocking measure, through the
  existing Gate, with no new rule.
- **The agreement rate** (§5) uses **neither**. It compares the merged head with the declared head
  and nothing else.
- **Possible later breakdowns beside the agreement rate** use both: of AGREED declarations, how many had
  a valuable human review before the merge (feedback); of DIFFERENT_HEAD declarations, how many had a
  changes-required review after the declaration (blocking).
- **Audit FAIL** (§6.3) is the blocking measure applied to the audit's own report. `Found` is a
  third, audit-only question (something actionable nobody raised before the merge).

## 3. Who else should look

### 3.1 Judgment, recorded where it is used

- **The worker** already recommends per head whether a fresh review is required (05 §5), and if in
  doubt it asks for one. Its reason can say who could add context and why ("a second model provider:
  the retry math is subtle", "someone who owns the billing integration").
- **Any reviewer** can say the same in its summary. A human or external reviewer just says so in a
  comment, which the next brief already carries (06 §2).
- **Reasoning** acts on these suggestions. It can start another reviewer run, which already needs no
  new mechanism: "reasoning may review more than recommended" (06 §3). Its `focus` and the other
  provider (04, Provider by quota) supply the different perspective. A suggestion it does not act on
  before declaring readiness goes into the readiness comment, so the human sees it (§4.1).
- AI reviews are relatively cheap and each reviewer brings a different perspective. So the bar for
  adding one is "would a new reader plausibly see something different?", not a count. No numeric rule
  is encoded. Data to tune this guidance comes from audits from stage 2 (§6) and, if it is ever
  adopted, the richer evidence extension (§15).

### 3.2 The few hard boundaries

These stay deterministic, because getting them wrong does material harm, and they stay few:

1. **GitHub rulesets** on every enrolled default branch: a PR, required status checks, at least one
   approving review, and no worker-App bypass (08 §2). Sergeant never changes them.
2. **`mergePolicy: human`** wherever a merge deploys to production (14 §A) until stage 3 changes it
   per repository by a human decision. It fails safe when unset (TECH-5244).
3. **Protected CI configuration** (M15): workflow and CI-definition changes, or an unknown
   changed-file list, need an independent reviewer's approval and a human merge under every policy.
4. **Requirements and human feedback**: M8 (an outstanding human change request), M10 (unseen human
   input), M13 (a review judged against the current issue text), M14 (unreadable inputs asked about).
5. **Optional required-reviewer paths in the ruleset** for the handful of changes an organization
   wants a human to approve whatever the evidence: for example the review controls themselves,
   identity trust policies, and destructive data migrations. GitHub enforces them. Sergeant sees
   GitHub's refusal and hands the head to a human (M12). The recommendation is **no more than about
   ten patterns per repository**. Anything finer belongs to judgment and the evidence loop, not to a
   path list.

This list is the **hard-rule list** that §8.1 refers to. Boundaries 3 and 5 are the ones that single
out kinds of change; 1, 2 and 4 apply to every change.

The designed-but-unbuilt `alwaysReviewPaths` is dropped. Boundary 3 is the built part of it, and
boundary 5 covers the rest where GitHub can enforce it.

## 4. The readiness declaration (stage 1)

### 4.1 What it is

Sergeant reaches the point where it would merge a head when reasoning proposes `merge_pr` and the
preflight passes (A1, A2, M1–M15, B1). That is the moment the task judges that the reviews and
checks are enough. The judgment combines the worker's recommendation, the reviews, and reasoning's
reading of the evidence, because only reasoning sees the final review and CI facts. (The issue
phrases this as "the worker's" judgment. In Sergeant the worker usually ends before review and CI
finish, so the task's reasoning declares on its behalf. The worker's own reason is part of the text.)

At that moment, before any approval, merge, or handoff call, the control-plane App posts on the PR:

```
READY TO MERGE | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f

Reason: one fresh-context review passed this exact head with no open blocking findings, all 4
required checks passed, and the change is limited to the retry handling the issue asks for.

Evidence on this head:
- Sergeant reviewer run_rev2: approve (a different model provider from the implementer)
- example-dev: GitHub review APPROVED on this head
- Required checks: 4 of 4 passed
Suggested, not acted on: someone who owns the billing integration could confirm the retry ceiling.

This repository's merge policy is `human`, so Sergeant did not approve or merge it. Review is
requested from @example-owner.
```

Grammar of the first line:
`^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$`, and the comment must have a non-empty
`Reason:`. This is the only line stage 1 parses, and only on comments Sergeant posted through its App
(`performed_via_github_app`, the same test TECH-6374 uses to minimize its own comments). Nobody
else's comment can create a Sergeant readiness decision.

In a public repository, before posting, the control plane passes the model-written `Reason:` and
suggestion lines to the repository's existing `check-public-data.mjs` with its configured denylist.
It accepts only text that passes. If no denylist is configured, or if the check cannot run, the text
is rejected. Rejected text is replaced by the fixed line "Reason recorded in Sergeant's task
record". This is the stage-1 owning rule for readiness text; stage 2 reuses it for audit comments
(§6.4). The first line, the head SHA, the evidence list and the check counts are built from records,
not prose, and are always posted.

### 4.2 Rules

- **One per head, never overwritten.** Today the PR summary is deduplicated only by an exact body
  match (`hand-to-human.ts`). That is safe for fixed text but not for a model-written `Reason:`, where
  a retry could post a second, different declaration. So before posting, Sergeant reads its own
  comments on the PR (by App ID) and posts nothing if one already carries `READY TO MERGE | SHA: <H>`.
  If several ever exist, the earliest counts. Sergeant never edits or deletes one.
- **Minimizing is narrowed.** Today `handToHuman` minimizes every earlier App comment whose body
  differs from the one just posted. Under this proposal it minimizes only readiness or summary
  comments for **other** heads, never a readiness comment for the current head and never an audit
  comment (§6). Minimizing hides a comment in the UI but keeps it readable through the API, so the
  report still reads it.
- **Posted before any human action on Sergeant's part.** It precedes the approval in a
  `sergeant`-policy repository, the handoff in a `human` one, and the handoff after a policy refusal
  (M12). A human who merges before Sergeant declared anything made no readiness decision to
  evaluate. Readiness is **never reconstructed afterwards** from runs or dispositions.
- **In every repository, whatever its merge policy.** A declaration in a `sergeant`-policy repository
  that Sergeant then merges cannot be evaluated (`not_human_merge`, §5.1), but it is posted anyway, so
  the track record is built the same way everywhere, the shadow sample (§8) has a declaration to
  measure, and the evidence already exists if the repository ever goes back to `human`.
- **A changed head needs a new assessment.** The old declaration stays as history for the old head
  and says nothing about the new one. Sergeant declares again only when the new head passes the
  preflight again. Reviews requested and revisions made before a declaration are ordinary iteration:
  no declaration exists yet, so nothing is measured.
- **No withdrawal line.** If a later review on the same head fails, that review sits on the PR beside
  the declaration, and the human sees both. The declaration is classified only by what the human
  finally did (§11.3).
- **Existing records, no new store.** The handoff record in `state.json` (`refusedMerges`, H1) and
  the merge record (`merged`) gain the readiness comment's id. These records are how `sgt review
  readiness` finds Sergeant's declarations (§7.1). Linear's "Ready for a human to merge" comment links
  to the PR comment. The `merge_pr` action gains a `readinessReason`, the one or two sentences
  reasoning writes. Nothing else is stored.

## 5. Human agreement (stage 1)

### 5.1 What is measured

What is measured is **the declaration**, not the iteration that led to it. The worker and any
reviewer, bot or human, can keep recommending more reviews and revisions; none of that counts against
Sergeant, and revisions made before a declaration count neither way. At some point Sergeant declares
the PR ready to merge at one head SHA (§4). That declaration succeeds if the PR is merged at exactly
that SHA, and fails if something else is merged after it.

Each Sergeant readiness declaration *D* (head *H*, posted at time *T*) gets exactly one class. It is
computed from GitHub when queried, never stored as a judgment, so a corrected rule reclassifies
history without migration. Only closed PRs are evaluated.

| Class | When | In the rate? |
|---|---|---|
| **AGREED** (success) | The PR was merged by a human account after *T* (`merged_at` > *T*), and its pre-merge head is exactly *H* | numerator and denominator |
| **DIFFERENT_HEAD** (failure) | The PR was merged by a human account after *T*, and its pre-merge head is not *H*: changes were made after the declaration, typically because a human required them | denominator |
| **REJECTED** (failure) | The PR was closed unmerged after *T*, and a human reviewer's latest undismissed native review on *H* at closure is `CHANGES_REQUESTED` and was submitted after *T*. That existing GitHub event is explicit, attributable rejection of the declared head | denominator |
| **UNKNOWN** | Anything else, with a reason: `pending` (still open), `closed_unmerged` (closed as duplicate, obsolete, superseded, abandoned, or for any reason without the explicit rejection evidence above), `not_human_merge` (merged by Sergeant or another bot, which includes all of stage 3's own merges), `uninterpretable` (merger unknown, merged before *T*, a malformed declaration) | excluded, reported |

**Agreement rate = AGREED / (AGREED + DIFFERENT_HEAD + REJECTED)**, always printed as the fraction,
with each class and the UNKNOWN count and its reasons beside it. It uses neither review measure of
§2.1: only the merged head against the declared head.

A declaration followed by a new head is DIFFERENT_HEAD whoever made the change and whatever it was,
and the new head's own declaration, if Sergeant makes one, is classified on its own. So one PR can
carry a failed D1 and an agreed D2. That is the intended reading: D1 said "ready" and was not.
Nothing has to judge whether a human "really" required a merged change, so no human-input window,
comment reading or commit authorship enters DIFFERENT_HEAD. REJECTED is intentionally narrower: a
close event or closer identity alone proves nothing. Stage 1 recognizes only GitHub's structured,
SHA-bound `CHANGES_REQUESTED` state from a human after the declaration, using each reviewer's latest
undismissed review on that head at closure. A dismissed request, or one superseded by that reviewer's
later approval, is not rejection. A prose comment may be clear to a reader, but stage 1 does not add
semantic parsing; without the structured review, the result is UNKNOWN (`closed_unmerged`). UNKNOWN
is preferable to manufacturing disagreement.

Later reporting may split DIFFERENT_HEAD by rebase-only changes (using `git patch-id --stable`) or by
changes required after the declaration (§2.1). Stage 1 neither computes nor prints those sub-counts.

The human's path does not matter, only where it ends. A human who asked for another bot review,
requested changes and then dismissed that request, or let the PR sit for days, and then merged *H*,
**AGREED**. A delayed review of the same head is therefore counted when the merge happens, and the
declaration counts as `pending` until then.

### 5.2 Mechanics GitHub supports

- **Pre-merge head.** A merged PR's `head.sha` stays the last head commit at merge, whatever the
  merge method. Compare that with *H*, **never** `merge_commit_sha`: a squash or rebase merge writes
  new commits. (Checked on a squash-merged PR in this repository: `head.sha` equals the `commit_id`
  of the approval Sergeant gave inside the merge, the merge commit is different, and the merge
  commit's first parent is the base at merge.)
- **Merger identity.** `merged_by` and its `type` (`User` or `Bot`). A merge GitHub performs because
  a human enabled auto-merge reports that human as `merged_by`, and counts as theirs. A merge queue
  that reports its own bot is `uninterpretable` unless the timeline's `added_to_merge_queue` actor is a
  human, in which case it is that human's.
- **Reviewing identities.** The existing evidence of §2 on *H* and on any earlier head: native
  reviews (account, type, state, `commit_id`) and Sergeant's reviewer runs (run id, provider,
  verdict). Stage 1 preserves and can show those records without deriving new review measures.
- **Closer identity.** The timeline's `closed` event actor is recorded for provenance, but never
  establishes REJECTED. The human `CHANGES_REQUESTED` reviewer establishes the explicit rejection.

### 5.3 Worked examples

| Sequence on one PR | Declarations → class |
|---|---|
| The worker asks for a second AI review, which finds a bug; the worker fixes it as A. D1 at A. A human merges A | D1 AGREED (the fix came before the declaration and counts neither way) |
| D1 at A. The owner requests another AI review, waits 3 days, approves A, merges | D1 AGREED |
| D1 at A. The owner leaves a CHANGES_REQUESTED review. The worker fixes it as B. D2 at B. The owner approves and merges B (squash) | D1 DIFFERENT_HEAD, D2 AGREED (pre-merge head B, not the squash commit) |
| D1 at A. A third-party review bot then finds a real bug, and the worker fixes it as B before any human speaks. D2 at B. A human merges B | D1 DIFFERENT_HEAD, D2 AGREED |
| D1 at A. Main moves, and the worker rebases as B with the same patch. D2 at B. A human merges B | D1 DIFFERENT_HEAD, D2 AGREED |
| D1 at A. A human pushes a commit C and merges C | D1 DIFFERENT_HEAD |
| D1 at A. A human leaves `CHANGES_REQUESTED` on A, then the PR is closed unmerged | D1 REJECTED |
| D1 at A. A human leaves `CHANGES_REQUESTED` on A, later approves A, then the PR is closed unmerged | D1 UNKNOWN (`closed_unmerged`; the latest undismissed state is not rejection) |
| D1 at A. A human closes the PR as duplicate, obsolete or abandoned, with no human `CHANGES_REQUESTED` review after D1 | D1 UNKNOWN (`closed_unmerged`) |
| D1 at A. Sergeant closes its PR after the task stops | D1 UNKNOWN (`closed_unmerged`) |
| D1 at A in a `sergeant`-policy repository. Sergeant merges A | D1 UNKNOWN (`not_human_merge`). Audits measure these (§6) |
| D1 at A in a `sergeant`-policy repository, drawn for the shadow sample (§8). A human merges A | D1 AGREED |

## 6. Post-merge audit (stage 2)

### 6.1 What is built and reused

`audit.ts` already draws, once per Sergeant merge, `auditDrawn(rate, head)`: a stable SHA-256 hash of
`["audit", repo, number, headSha]` against `review.auditSampleRate` (default 0.2). It applies only to
merged heads no fresh review approved. A drawn head gets a nonblocking reviewer run
(`run_audit-<headSha>` today, made unique per PR in §6.2) of exactly that head, and its must-fix
findings are kept as follow-up work and told to the issue. 06 §8 still says the draw happens when a
`not_required` disposition is recorded, before the merge. The proposal corrects it to the built
behavior as later cleanup (§10.1).

### 6.2 Widened to all merged PRs, first in the repositories working toward auto-merge

- **Which repositories.** Not company-wide yet. The 1-in-10 draw runs only in the first repositories
  working toward auto-merge, where its numbers feed a stage-3 decision. Other repositories are added,
  one operator decision at a time, once the audit numbers look trustworthy: the auditors' findings
  hold up when people read them, and the cost per audit is understood. It is a per-repository setting,
  `RepositoryEnrollment.mergedAuditSampleRate`, absent meaning 0, so turning a repository on or off
  is one `sgt admin repo` change and no list of repository names is kept in code. Within a repository
  that is on, every merged PR is in the sample, Sergeant's or not.
- **Discovery.** A daily background loop lists, for each repository with a nonzero rate, the PRs merged into its
  default branch in the last 72 hours (`pulls?state=closed&base=<default>&sort=updated&direction=desc`,
  paged until `updated_at` is older than the window, keeping those with `merged_at` inside it). The
  overlap tolerates a missed day. A PR merged without a pull request (a direct push, an admin bypass)
  is not discoverable this way (§11.7).
- **The draw.** The same stable-hash function on the PR's identity and pre-merge head, salted
  differently (`["merged-audit", repo, number, headSha]`), so two PRs that share a head SHA are drawn
  independently, against the repository's `mergedAuditSampleRate`, which is **0.1 (1 in 10 merged
PRs)** wherever it is turned on. Unsalted,
  every head drawn at 0.1 would also be drawn at 0.2, so the two samples would be nested. Salted, they
  are independent. A Sergeant head that skipped review is still drawn at the 20% rate (§6.1). A PR
  drawn by both is audited once.
- **One audit identity per repository, PR and head.** Today's id, `run_audit-<headSha>`, names only
  the commit. The same commit can be the head of PRs in two repositories (a fork, a mirror, a
  vendored copy) or of two PRs in one repository (a PR closed and reopened under a new number, a
  stacked PR whose base merged). A scan of every merged PR meets those cases, and with a SHA-only id the
  second PR's audit would be skipped as already started, or its result joined to the first PR. So
  both draws use one key:
  `auditRunId(repo, number, headSha) = "run_audit-" + hex(sha256(JSON.stringify(["audit-run", repo, number, headSha])))[0..40]`.
  It is a hash because run ids allow only letters, digits, `_` and `-` (01 `RunId`), and repository
  names hold `/` and `.`. 160 bits make an accidental collision negligible. The built task audit
  (§6.1) switches to it. An audit already recorded keeps the run id stored on its `merged` record,
  which is always read back and never recomputed, so nothing migrates.
- **Idempotence without state.** The runner's `start` is already idempotent on the run id (it does
  nothing when that run exists). Because the id is derived from the same repository, PR and head as
  the draws, a restart, a re-scan, or both draws picking the same PR head starts one audit, and two
  PRs that share a head start two. Losing everything means re-scanning the last 72 hours, which starts
  nothing new.
- **What is reviewed, as of merge.** The reviewer checks out the pre-merge head `head.sha`, and its
  diff is `git diff <merge_commit_sha>^1...<head.sha>`. The three-dot form diffs from the merge-base,
  so it gives exactly the PR's change for merge, squash and rebase merges alike, even though a
  rebase merge's `merge_commit_sha^1` is another rebased commit and not the old default branch. The
  brief carries the PR title and body, the Linear issue it references (if any; with none, the PR's
  own title and body are the requirements), and every review and comment made **up to the merge
  time**. Comments made after the merge are left out, so the auditor judges what was known then. The
  audit starts within a day of the merge, so later requirement edits are rare. Its rules say to judge
  against the code and the requirements as of the merge, to report only what was actionable then, and
  never to infer a defect from a later rewrite or rollback.
- **Finishing audits outside a task.** Today a Sergeant task's after-merge loop waits for its audit
  and records it (`after-merge.ts`, `logFollowUp`). A PR with no task has no loop, so the daily scan
  also harvests the audits it started: for each drawn PR in its window it recomputes
  `auditRunId(repo, number, headSha)` and, when that run has finished, writes the `ReviewFacts` line
  and posts the audit comment (§6.4). The runner's start spec and the reviewer brief need small
  changes: an optional Linear conversation, an explicit base SHA, a merge-time cutoff for PR feedback,
  and an audit focus that does not assume a skipped review (§10.3).
- **Who pays.** Sergeant task audits stay on the task owner's registered accounts (TECH-5179). An
  audit that runs **outside a task** (a PR with no Sergeant task) has no task owner, so its cost goes
  to the **project owner's** budget: the installation sets `review.auditOwner` to the person who owns
  the Sergeant project, and those audits run on that person's registered model accounts. A daily cap
  (`review.qualityBudgetUsdPerDay`, already designed in 06 §8) bounds the cost. With no owner
  configured, audits outside a task do not run.

### 6.3 The finding

`Found: YES` means the auditor found an actionable issue that nobody raised on the PR before the
merge. `PASS | FAIL` keeps its meaning: would this head have been fit to merge? Both come from the
audit's reviewer report, never from text on GitHub:

- `PASS` is verdict `approve`; `FAIL` is `changes_requested` or `needs_human`.
- `Found` is the `found` flag on the report's `reviewed` entry for that PR (§10.3). It is per reviewed
  PR, never per run: an audit reviews one PR, but the same report shape serves required reviews of
  several PRs at once, where a single run-wide flag would credit, or blame, every PR alike. An entry
  without `found` (an older report) falls back only when the report reviewed exactly one PR: `YES`
  when it has any blocking or nonblocking finding, `NO` otherwise. A multi-PR report without per-PR
  `found` leaves `Found` unknown on each PR, and unknown stays out of every `Found` denominator.

The result is the audit's `ReviewFacts` line in `reviews.jsonl`, with the PR's `found` and the audit
comment's id on its `subject` entry.

### 6.4 Surfacing, and what a public repository's PR may show

Audits never block and never revert, reopen, or file anything by themselves. Humans decide.

- **Full details** (the reviewer's summary, every finding with its severity and category, and the run
  id) always stay in Sergeant's records, where `sgt review audits --found` shows them to a signed-in
  user (§7.2). For a Sergeant task, as today, one Linear comment carries the must-fix findings and the
  follow-up record. Linear is private.
- **Private repository.** The audit comment on the merged PR carries the verdict line, the reviewer's
  summary and its findings. It notifies the PR's author and subscribers.
- **Public repository.** The PR gets **only the verdict line plus findings that talk about code alone
  and pass the public-data check**. Whether a repository is public is read from GitHub at posting
  time, the way the runner already decides it (`public: base.repo.private !== true`, `runner.ts`), so
  a repository whose visibility cannot be read counts as public. No list of repository names is kept.

The public-repository rule is enforced by the core when it composes the comment, not by a reviewer
prompt. The reviewer has no GitHub write access, so nothing it writes reaches the PR except through
this filter:

1. **Fixed verdict line**, built from report fields, never from reviewer prose:
   ```
   Post-merge audit (nonblocking): FAIL | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f
   ```
2. **Each finding is a candidate only if it is structurally about code**: its `category` is not
   `acceptance` (an acceptance finding is about the requirements, which may be private); its
   `location` parses as `<path>` or `<path>:<line>` and the path is one of the PR's changed files;
   its `description` is at most 500 characters, on one line, and holds no URL. The reviewer's
   `summary`, the brief, and any issue or requirement text are never candidates.
3. **The public-data check** runs on each candidate and then on the whole composed comment: the
   canonical `check-public-data.mjs text`, with the installation's denylist from
   `publicDataDenylistSecret`, the same check that guards pushes (TECH-5914). A candidate that fails
   is dropped.
4. **Fail closed.** With no denylist configured, or if the check errors, the comment is the verdict
   line only. Dropped findings are counted, never quoted: "2 findings are kept in Sergeant's records
   (`sgt review audits`), not on this public PR".

Example on a public repository:

```
Post-merge audit (nonblocking): FAIL | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f

- src/sync.ts:88: `retryAfter` is read in seconds but compared as milliseconds, so a rate-limited
  sync retries immediately.

1 finding is kept in Sergeant's records (`sgt review audits`), not on this public PR.
```

The reviewer rules also ask for code-only wording on a public repository, so fewer findings are
dropped, but the filter, not the rule, is the safeguard. What the filter cannot catch is a
code-anchored sentence that paraphrases a private detail in ordinary words (§11.7).

## 7. Reporting without a dashboard

### 7.1 Stage 1: `sgt review readiness`, computed by rereading GitHub

Stage 1 keeps no index. Sergeant's declarations are already listed in its task records: every
`refusedMerges` and `merged` record with a `readinessCommentId` (§4.2), in each task's `state.json`
and every episode set aside beside it (completed, accepted or stopped), each comment once. For each, the command rereads
the PR from GitHub (the PR, its reviews, issue and review comments, timeline and commits), joins
Sergeant's reviewer runs from `reviews.jsonl` by run id, and classifies the declaration (§5.1). The
reads are the conditional, rate-limited reads every GitHub read already uses (08 §9), a handful per
declared PR. Like every `sgt` command (`sgt stops` reads `GET /v1/stops`), the command reads one
read-only route, `GET /v1/review-readiness?since=&repo=`, which any signed-in person (approver or
team member) may call: `serve` does the scan and the GitHub reads, and `--json` prints its answer as
sent. What if we lose it? Nothing: there is no derived state, only the task records Sergeant
already keeps and GitHub. If rereading becomes slow, a cache of closed PRs' facts can be added; it
would be disposable.

Following the existing `sgt` patterns (`--since`, `--json`, read-only):

```
sgt review readiness [--since 90d] [--repo <slug>] [--list] [--json]
```

`--list` prints each declaration with its PR link, head, class (and UNKNOWN reason) and the
declaration's reason, so every number links back to evidence a person can read on GitHub. With
nothing evaluated, the line keeps the fraction and counts and prints no percentage. Stage 1 adds no
other route, no MCP tool and no dashboard. Example
(`sgt review readiness --repo example-org/example-app --since 90d`):

```
Sergeant readiness, example-org/example-app, last 90 days
  AGREED 41 / evaluated 47 = 87.2%   (DIFFERENT_HEAD 5, REJECTED 1)
  UNKNOWN 5: pending 3, closed_unmerged 2
  Mergers: example-owner 30, example-dev 11
```

### 7.2 Stage 2: `sgt review audits`

```
sgt review audits [--since 30d] [--repo <slug>] [--found] [--by repo|sergeant] [--json]
```

Like `sgt review readiness` (§7.1), the command reads one read-only route,
`GET /v1/review-audits?since=&repo=`, which any signed-in person may call; `--json` prints its
answer as sent. `serve` computes it on each call from the audits' `ReviewFacts` lines in
`reviews.jsonl` (`trigger: audit`, the last line per run id), and stores nothing. `--since` and
`--repo` match the line's `at` and the audited PR's repository.

- **Audit yield** is `Found YES / known` over completed audits (a reviewer report with a verdict),
  with `Found` unknown printed beside it and never in the denominator (§6.3). **Audit FAIL rate** is
  `FAIL / completed`. Every rate is printed as its fraction; audits with no verdict are counted
  separately.
- `--by repo` splits both rates by repository. `--by sergeant` splits AGREED heads (Sergeant-ready
  and merged by a human at that head), Sergeant-merged heads, and other PRs. It rereads from GitHub
  only Sergeant's declarations on audited heads and classifies them with the readiness classifier
  (§5.1): AGREED is an AGREED head, and `not_human_merge` on a head Sergeant declared is
  Sergeant-merged only when Sergeant's own GitHub App merged it. Every other audited PR, including a
  merge by any other bot, is "other".
- `--found` lists every `Found: YES` with its PR link, head, verdict, run id, and the reviewer's
  summary and full findings from the audit run's own record, which a public PR does not show (§6.4).
  If the run has no readable reviewer report, that row says `findings unavailable` instead.

This adds no MCP tool: the MCP client's fixed tool list (11 §1) is unchanged, and a read-only
`review_report` tool over the two routes is later work.

### 7.3 Metrics, with numerator and denominator

| Metric | Stage | Numerator | Denominator |
|---|---|---|---|
| Readiness agreement, by repository (uses neither review measure) | 1 | AGREED | AGREED + DIFFERENT_HEAD + REJECTED (UNKNOWN printed separately, by reason) |
| Failed declarations with changes required after them (blocking measure) | Later | DIFFERENT_HEAD declarations with a changes-required review between the declaration and the merge | DIFFERENT_HEAD |
| Agreed after a valuable human review (feedback measure) | Later | AGREED declarations with a valuable human review before the merge / with only a plain approval / with no human review | AGREED |
| Agreed after a Sergeant review | Later | AGREED declarations whose head had a Sergeant reviewer `approve` / no fresh review | AGREED |
| Human review was valuable | Later | human native reviews on declared PRs that were valuable | human native reviews on declared PRs |
| Merger identity | 1 | evaluated declarations on merged PRs, by `merged_by` login | evaluated declarations on merged PRs |
| Post-merge audit yield | 2 | completed audits with `Found: YES` | completed audits with a known `Found`, split by: AGREED (Sergeant-ready, merged by a human at that head), Sergeant-merged, other PRs |
| Audit FAIL rate (blocking measure) | 2 | completed audits with `FAIL` | completed audits |
| Shadow-sample agreement | 3 | AGREED shadow-sample declarations | evaluated shadow-sample declarations |
| Under-review (06 §9, kept) | 2 | audited Sergeant skips with ≥ 1 blocking finding that led to a change or was not disputed | audited Sergeant skips |

Every rate is printed as its fraction. The 06 §9 metrics stay as designed. No metric gets a target in
code. §8's 90% is a threshold for a human to consider. Coverage by reviewer position, the Found rate
of each reviewer, and how often an added reviewer contributes something new would need the review
line (§15); stages 1–3 do not collect that data.

## 8. Earned autonomous merge (stage 3)

- **The objective, per repository.** The agreement rate of Sergeant's readiness declarations, at or
  above about **90%** over at least **50 evaluated decisions**. This is deliberately the simple
  formula of §5.1, per repository because stakes and conventions differ. Reaching the threshold
  invites a human authorization decision; it neither changes permission automatically nor acquires
  extra terms. Audit results and the feedback breakdown remain visible context for that decision and
  for monitoring, not weights or gates in the formula. With 50 decisions, 45 AGREED still allows a
  true rate somewhere in the high 70s to mid 90s at 95% confidence, so the number invites a decision;
  it does not make one. The anchoring risk in this evidence is explicit in §11.9.
- **The authorization.** A person with operator rights deliberately sets that repository's existing
  `mergePolicy` to `sergeant` (`sgt admin repo …`). Sergeant never changes it, never asks for it
  automatically, and never escalates on a threshold. For a repository whose merge deploys to
  production, this is a deliberate exception to the settled decision in 14 §A, so the captain
  records it there, per repository, with the evidence. It also needs the organization's
  change-management control to accept it (§8.1).
- **What still holds after it.** Every hard boundary in §3.2: required checks, M15's human review and
  merge for CI changes, any ruleset required-reviewer path (GitHub refuses, and Sergeant hands off,
  M12), M8, M10, M13 and M14. Merges stay gated by D1–D6.
- **Shadow sample.** In a repository with auto-merge, a small random sample of the heads Sergeant
  would merge still goes to a human, so a drop in quality shows up as falling agreement and not only
  in audits. When Sergeant has declared a head ready and would approve and merge it, a stable-hash
  draw (`auditDrawn` on `["shadow-handoff", repo, number, headSha]`) against
  `review.shadowHandoffSampleRate` (proposed 0.05, 1 in 20) decides; a drawn head is handed to a
  human exactly as in a `human`-policy repository, and its comment says only that the head was drawn
  for a random human-review sample. The human's merge or close classifies its declaration as usual
  (§5.1), and `sgt review readiness` reports the shadow sample's agreement separately. This is **in
  addition to** the 1-in-10 bot audits, which keep running on every merged PR in the repository.
  Handing off is the safe direction, so the draw needs no new Gate rule; it only skips the approve
  and merge call.
- **Restricting.** Reports keep running after the switch. The shadow sample's agreement and the audit
  yield on Sergeant-merged heads are the signals. Defects humans report later would add to them once
  `defectReports` (01, designed but not built) exists. A human sets the policy back to `human` when
  those signals warrant it. No automatic demotion is proposed: it would add a deterministic rule the
  charter reserves for preventing material harm, and the hard boundaries already do that.

### 8.1 "Significant" changes for change management (provisional, pending auditor review)

The organization's SOC 2 change-management control requires significant changes to be reviewed and
approved before they reach production. For the audit period of **1 December 2026 to 1 March 2027**,
the working definition is:

- **Before a repository is authorized for auto-merge** (`mergePolicy: human`), every production
  merge in that repository is significant and remains human-approved, as it is today. Nothing in
  stages 1 and 2 changes who approves or merges in that repository.
- **After that repository is authorized for auto-merge** (`mergePolicy: sergeant`), the significant
  changes in that repository are the narrow hard-rule changes of §3.2: protected CI configuration
  (M15) and paths covered by the repository's ruleset required-reviewer rule (boundary 5). Those
  changes still require human approval. Other changes may follow Sergeant's existing gated merge
  path.

**This definition is provisional. It is pending review with the auditor and is not final.** It may
change before or during the audit period. It is recorded here so the design and the control describe
the same boundary; the adopted wording belongs in the organization's review policy (§12, TECH-6510).
Deterministically, this needs nothing new: the before-authorization phase is `mergePolicy: human`
(boundary 2), and the after-authorization exceptions are boundaries 3 and 5, which GitHub and the
Gate already enforce under every policy.

## 9. Staged rollout

**Stage 1 — readiness and agreement on existing evidence.** No merge rule changes.
1. Post the readiness declaration as the first line of the per-head summary, in every policy, with
   one-per-head deduplication and narrowed minimizing (§4).
2. Record `readinessCommentId` on the `refusedMerges` and `merged` records, and `readinessReason` on
   `merge_pr`.
3. Build the read-only `sgt review readiness` command, classifying by rereading GitHub and linking to
   the existing evidence of §2. It reads one read-only route (§7.1) and derives no new review measure.

Nothing is asked of humans or external assistants: no convention, no template line.

Exit: a readiness line appears on every Sergeant PR head that passes the preflight, in every
repository whatever its merge policy, and the readiness
report matches a hand count on a sample of PRs.

**Stage 2 — expanded post-merge audits (vision; separately approved later).**
1. The per-repository, per-PR, per-head audit run id, and per-PR `found` in the reviewer report and
   `ReviewFacts` (§6.2, §6.3).
2. The merged-PR discovery and draw (§6.2), the per-repository `mergedAuditSampleRate`,
   `review.auditOwner` (the project owner), and the daily cap. Turn it on at 0.1 only in the first
   repositories working toward auto-merge.
3. The as-of-merge audit brief, the audit comment with the public-repository filter (§6.4), and
   `sgt review audits`.

Exit: in each repository that is turned on, audits cover 1 in 10 merged PRs, Sergeant's or not;
every `Found: YES` is in `sgt review audits --found`; and a public repository's PRs show only the
verdict line and filtered findings.

**Stage 3 — earned autonomous merge (vision; separately approved later and per repository).** Once a repository has ≥ 50
evaluated decisions at about 90% agreement, the captain and the policy owner decide whether to set
`mergePolicy: sergeant` there (§8), under the change-management
definition in force then (§8.1). No code change is needed for the switch itself. The shadow handoff
sample (§8) is built before the first repository is switched, and runs in every `sergeant`-policy
repository. Other repositories join the audits as the numbers earn trust (§6.2).

**On demand — richer review evidence (§15).** Not scheduled. It gets its own design only when a
specific question justifies company-wide metadata. Until then nobody is asked to write it and
nothing parses it.

Approval authorizes only stage 1. Later stages remain design vision until separately approved; their
implementation issues are not created as part of this design task.

## 10. Exact proposed changes to existing contracts

Only the items marked stage 1 are authorized by approval of this proposal. Every item marked later,
stage 2 or stage 3 is vision that requires separate approval. Each owning section is edited in
place, and other documents link to it (rule ownership per `AGENTS.md`).
The deferred evidence extension (§15) changes nothing here; any contract changes belong to its own
design.

### 10.1 `06-review.md`

- **§3 table** (later cleanup): in the `not_required` row, replace "no `alwaysReviewPaths` touched" with "no
  protected CI configuration touched (08 M15)".
- **§6 D4** (later cleanup): replace "and the PR's changed files match none of the repository's
  `alwaysReviewPaths`. Built today: a PR changing protected CI configuration, or whose changed files
  are unknown, never gets it (08 §7, M15)" with "and the PR changes no protected CI configuration and
  its changed files are known (08 §7, M15)".
- **§8** (later cleanup): rename it "Post-merge audits". Replace the `onNotRequiredRecorded` pseudocode and
  its first bullet with the built behavior: "Once per Sergeant merge, a merged head no fresh review
  approved is drawn with `auditDrawn(review.auditSampleRate, head)`." Keep: nonblocking, the stable
  hash, after-merge surfacing.
- **§8** (stage 2): the audit run id is `auditRunId(repo, number, headSha)` (proposal §6.2), replacing
  `run_audit-<headSha>`. Add the merged-PR draw and its per-repository enrollment (proposal §6.2), the finding (§6.3) and the
  surfacing rules, including the public-repository filter (§6.4), as subsections; 06 §8 becomes their
  **owning section**.
- **§8, last bullet** (stage 2) ("charged to the installation's review-quality budget, not the
  task's"): replace with the built rule (the task owner's accounts, TECH-5179) and, for audits outside
  a task, the project owner's budget through `review.auditOwner`, under the daily cap (proposal §6.2).
- **New §9.1 "Two review measures"** (later measurement work): *changes required (blocking)* and *review was
  valuable (feedback)*, defined and computed as in proposal §2.1, as their **owning section**.
- **§9** (stage 2): add the audit metrics of proposal §7.3 and name `sgt review audits` as their
  report.
- **§11 Not built** (later cleanup): add "No path tier map, fixed reviewer counts, or sensitivity file list.
  The few hard boundaries are in 08 §2 and M15."

### 10.2 `08-github-contract.md`

- **§2 item 7** (`alwaysReviewPaths`, later cleanup): replace it with "Optionally, a short ruleset
  required-reviewer rule (about ten patterns at most) for changes a human must approve whatever the
  evidence. GitHub enforces it, and Sergeant hands off when GitHub refuses (M12)."
- **§7 handoff** (stage 1): the PR summary starts with the readiness line (proposal §4), is posted
  once per head before any approval, merge, or handoff call **in every policy**, and is never edited;
  its comment id is kept on the `refusedMerges` and `merged` records. The Linear handoff comment links
  to it. In a public repository its model-written text goes through the fail-closed public-text
  filter owned by new 08 §12 (proposal §4.1).
- **§7 handoff, minimizing** (stage 1): narrow TECH-6374's rule to readiness or summary comments for
  other heads (proposal §4.2).
- **New §12 "Readiness and agreement"** (stage 1): the readiness line and rules (proposal §4), the
  agreement classes and mechanics (proposal §5), and the existing evidence they read (proposal §2),
  as the **owning section**.
- **§7 merging** (stage 3): in a `sergeant`-policy repository, a head drawn for the shadow sample is
  handed to a human instead of approved and merged (proposal §8).
- **§11** (stage 2): allow, besides the handoff summary and the stop comment, "Sergeant's post-merge
  audit comments on enrolled PRs, filtered on public repositories (06 §8)".
- **§1, control-plane App row** (stage 2): add the audit comments to "used for", before "nothing
  else".

### 10.3 `01-domain-model.md` and `05-brief-report-protocol.md`

- Stage 1: the `RefusedMerge` and `merged` records gain `readinessCommentId?`. The `merge_pr` action
  (`MergePr`) gains `readinessReason`.
- Later cleanup: `alwaysReviewPaths` is removed from 01 (the repository config and `reviewPolicy`) and from
  05 §5's last sentence, which then points to M15.
- Stage 2: the reviewer report (`s2-review-report`): each entry of `reviewed` gains `found?: boolean`
  ("on this PR head you raised at least one actionable finding not already raised on this PR").
  Optional, so older reports still parse; a missing value falls back as in proposal §6.3.
- Stage 2: `ReviewFacts`: each `subject` entry (`{ repo, number, headSha }`) gains `found?: boolean`
  and `auditCommentId?`. Both are per reviewed PR, never per run.
- Stage 2: `RepositoryEnrollment` gains `mergedAuditSampleRate?` (absent meaning 0, proposal §6.2).
- Stage 2: the audit run id (`audit.ts`, the `merged` record's `audit.runId`): new draws use
  `auditRunId(repo, number, headSha)` from proposal §6.2 instead of `run_audit-<headSha>`. Stored ids
  are read back unchanged.
- Stage 2: the reviewer run's start spec and brief: an optional Linear conversation, an explicit base
  SHA, a merge-time cutoff for PR feedback, and an audit focus for PRs outside a task (proposal §6.2).
  A new reviewer rule: on a public repository, word findings about the code only, never quoting or
  paraphrasing issue content. The rule reduces dropped findings; the core's filter (06 §8) is the
  safeguard.

### 10.4 `10-installation-config.md` and `11-apis-cli.md`

- Configuration (stage 2): `RepositoryEnrollment.mergedAuditSampleRate` (0–1, absent meaning 0; set
  to 0.1 in the repositories working toward auto-merge, with `sgt admin repo`) and
  `review.auditOwner` (a person's id, no default; the project owner, whose budget pays for audits
  outside a task). Stage 3: `review.shadowHandoffSampleRate` (0–1, proposed 0.05; applies only in
  `sergeant`-policy repositories). `publicDataDenylistSecret` gains two readers: in stage 1, the
  core's readiness-text filter, which substitutes the fixed fallback line when the denylist is
  absent; in stage 2, the core's audit-comment filter, which posts verdict lines only when it is
  absent.
- Background loops (stage 2): "merged-PR audit draw (daily)".
- CLI: `sgt review readiness` (stage 1), reading the one read-only route `GET /v1/review-readiness`
  the way `sgt stops` reads `GET /v1/stops` (§7.1), and `sgt review audits` (stage 2), reading
  `GET /v1/review-audits` the same way (§7.2). An MCP `review_report` tool is later work requiring
  separate approval.

### 10.5 `09-security.md`

- Later cleanup: the skipped-review sentence ("narrowed by optional `alwaysReviewPaths`") becomes "narrowed
  by the protected-CI matcher (08 M15) and any ruleset required-reviewer paths".
- Stage 2: under public repositories, add "Sergeant's own PR comments on a public repository carry
  only fixed text and code-anchored findings that pass the public-data check; the full text stays in
  Sergeant's records (06 §8)".

### 10.6 `14-open-questions.md`

- §A: a note under the production `mergePolicy` decision: "a per-repository exception, decided by the
  captain on the evidence of 08 §12 and 06 §8–9 (proposal 16 §8), is recorded here, under the
  change-management definition in force (proposal 16 §8.1, provisional)".
- §C: a new tension: "agreement is measured only on human merges, so in a repository where Sergeant
  merges it accrues only from the shadow sample; audits carry the rest of the signal".

### 10.7 What stays exactly as it is

The Gate's D1–D6 and M1–M15 checks, the fresh-context reviewer and its brief, the 20% skipped-review
draw and its hash key (only its run id changes, §10.3), the two-App identity model, rulesets, the
`mergePolicy` default, the worker's per-head review recommendation, subagent reviews as measurement
only, and the 06 §9 `sgt review quality` design.

## 11. Tradeoffs

### 11.1 Reviewer identity verification

GitHub verifies **accounts**: a `Bot` account is a real App, and a `User` is a real person. It does not
verify what produced a review's text. Stage 1 avoids the question by reading only facts GitHub binds
to an account (a native review's account, state and `commit_id`) and Sergeant's own run records. So:
- A native review counts for the account that submitted it, whatever produced its text. An assistant
  working under a person's account is, in stage 1, that person's review.
- Sergeant's own comments are recognised by its App ID (`performed_via_github_app`), never by login
  text. The same rule already protects comment minimization (TECH-6374).
- **Approval authority does not change.** It still comes only from GitHub rulesets, under whatever
  approvals the repository counts, and Sergeant's dispositions (D2: a reviewer run Sergeant launched
  and can verify in its ledger). A third-party review App's approval is a verified identity with
  unverified quality. Whether such reviews may ever count toward a disposition is a later decision on
  data, like the subagent decision in 06 §5.
- Crediting the tool behind a person's account would need additional typed attribution (§15), as
  attribution, never authority.
- Considered and rejected: signed review attestations or a reviewer registry. They are heavy, and the
  audit sample tests reviewer quality more directly than an identity proof could.

### 11.2 Provenance of external comments

Stage 1 parses no external comment text. Native reviews are bound to a commit and can be dismissed
but not re-pointed. Comments can be edited or deleted after posting; the classification reads GitHub
when queried, so a deleted review is absent, which is accepted: its author withdrew it. Agreement
(§5.1) reads no comment at all. The feedback measure (§2.1) reads only whether a human said anything
beyond a bare approval, so an edit can change it only by emptying a comment.
Sergeant's own readiness and audit comments are never edited. Bot text is never an instruction (06
§4, TECH-6166).

### 11.3 Readiness invalidation

A declaration is bound to one head and is simply history once the head changes. That makes "is it
still valid?" a question with no state to keep. The cost: no withdrawal on the same head. If a later
reviewer finds a problem in head *H* after the declaration, the human sees that review next to it. A
human merge of *H* is still AGREED, because the human weighed both. A withdrawal line was considered
and dropped. It would add a third state per head and a reconciliation rule for "withdrawn, then
merged". If the data shows humans merging past later failing reviews, it can be added. A change to the
issue's requirements after the declaration is caught by M10 and M13 before any Sergeant merge. In
`human` repositories it is the human's call, and the later review evidence shows it.

### 11.4 Human agreement reconciliation

The rule is structural (who merged, and whether the merged head is the declared one) and computed
from GitHub at query time, so it is reproducible by anyone with read access. It needs no judgment of
who caused a change or why. Accepted biases, all downward: a human pushing a fix counts as
DIFFERENT_HEAD even if Sergeant would have made the same fix; a change Sergeant makes on its own after
declaring a head ready counts too; and so does a pure rebase, though it is printed as its own
sub-count in later-stage reporting. The alternative, separate classes for "a human required it" and
"Sergeant revised it", would need a window of human input and a rule for what counts as input, and it
let a premature declaration drop out of the denominator. Accepted gaps: decisions on PRs that are
still open are `pending`, so a slow-reviewing repository accrues slowly. A merge by a merge-queue bot
with no human enqueuer is `uninterpretable`.

### 11.5 External-review accounting

Stage 1 counts external reviews only as GitHub records them: a native review by an account, with a
verdict for one commit, or none for `COMMENTED`. Human reviewers and external assistants change
nothing. The cost is what stage 1 cannot see: whether a review found something new, and which tool
was behind a person's account. That is deliberate. Answering those questions would require the
deferred extension of §15: company-wide metadata plus new parsing and reporting. It waits for a
question that needs it. Audits record `Found` for their own reviews from stage 2, from the reviewer's
report rather than from GitHub text. Author-side reviews are kept but never shown as independent.

### 11.6 Samples and denominators

Every rate is printed as a fraction. UNKNOWN is excluded but always shown with its reasons, so a
large UNKNOWN share is visible instead of silently inflating the rate. 50 evaluated decisions per
repository is a minimum for a human to look, not proof (§8). Rates are reported over a window
(`--since`), so a prompt or reviewer-rule change can be judged by comparing windows. No rate resets
automatically. The audit sample rates trade cost against how fast the audit yield becomes
meaningful. At 10% of merged PRs, a repository merging 100 PRs a month yields about 10 audits a
month. A 5% shadow sample in a repository where Sergeant merges 100 PRs a month yields about 5
evaluated declarations a month: enough to notice a collapse within a quarter, not a small drift,
which the audits cover alongside it.

### 11.7 Post-merge audit discovery and enrollment, and public repositories

Audits start in the first repositories working toward auto-merge, not organization-wide. That is
where their numbers decide something, and it keeps the cost and the noise of a new kind of PR comment
small until the auditors' findings have proved trustworthy. Within those repositories every merged PR
is in the sample, so work never run through Sergeant is audited too. Widening is a per-repository
setting, not a code change. Only enrolled repositories can ever be audited, because Sergeant's Apps
and read token reach only those; an audit-only enrollment (read and comment, no task work) for
repositories Sergeant never works in is not proposed now and can be decided when audits widen.
Discovery reads merged PRs, so a change that reached the
default branch without a PR (an admin bypass, a direct push) is invisible to it. Rulesets should make
that rare, and an organization's break-glass process covers it separately. Running audits on PRs
nobody delegated to Sergeant spends someone's model accounts, hence the project owner's budget
through `review.auditOwner`, and the daily cap.

An audit's brief includes the Linear issue verbatim, and the issue may be private, so an audit comment
on a public PR could leak it. A prompt rule alone cannot prevent that, so the core filters what it
posts (§6.4). The filter is structural (no reviewer summary, no acceptance findings, findings anchored
to a changed file, short, no URLs) and then the same public-data check pushes pass. It fails closed to
the verdict line. Its residual risk is a code-anchored finding that paraphrases a private detail in
words the check does not know; the structural rules make that unlikely, and the full details being
one command away means dropping a finding costs little. A stricter option, verdict line only on every
public PR, is simpler but would hide useful code findings from the code's own contributors.

### 11.8 Deterministic GitHub protection vs AI judgment

A path tier map makes judgment deterministic but brittle. It needs hundreds of patterns to sort a
large repository, each a judgment call that must be maintained as the code moves, and still cannot
see risk inside a file. It also fixes reviewer counts that no data supports. This proposal keeps
determinism only where an error is material and a rule can be stated simply: required checks,
required approval, protected CI, the `mergePolicy` switch, a handful of ruleset paths GitHub
enforces, and the filter on what Sergeant posts publicly. Everything else is judgment, measured by
evidence. The cost is that a misjudged skip or a thin review can happen. The 06 §1 review-need policy
already accepts that cost, and audits measure it in both directions. The benefit is one mechanism
that covers Sergeant's PRs and everyone else's, and data to tune it.

### 11.9 Anchoring on the readiness line

In a `human`-policy repository the reviewer sees `READY TO MERGE` first, and may approve it with less
scrutiny than a PR with no verdict. That anchoring could inflate the agreement rate stage 3 uses.
The design accepts the risk without hiding the recommendation: `READY TO MERGE` stays prominent,
with its reason and evidence directly below it, and humans should preferably wait for Sergeant to
declare readiness before beginning their review. That sequence preserves the signal the experiment
is meant to test: whether a human ultimately merges the exact SHA Sergeant recommended, even if the
human then seeks more opinions before deciding.

Anchoring is monitored, but it does not add a weight, exclusion or second gate to the initial
agreement formula and does not delay stage 1. If later measurement work is approved, it can show
whether AGREED heads had valuable feedback, only a plain approval, or no human review (§2.1).
Independent post-merge
audits provide an unanchored check on sampled heads. We will explore occasional blind human reviews,
where the reviewer does not see the readiness declaration until after recording an assessment, and
compare them with ordinary reviews to estimate the effect. That experiment needs its own operating
detail before use; it is not part of stages 1–3. After stage 3, the shadow sample and audits continue
to show later quality changes. These signals inform the human authorization and any later restriction
without changing **AGREED / evaluated**.

## 12. What this supersedes or redirects

This PR changes none of the following. It recommends:

- **TECH-6510 (adopt the code review policy)** — redirect. The draft policy takes a path-tier
  approach with fixed review counts per tier. Recommend that the policy adopt this evidence-based
  model instead: readiness, agreement, audits, and §3.2's short list of hard boundaries, keeping the
  policy's own authorization, required-CI and exception sections. The change-management definition of
  §8.1 is provisional; once the auditor has reviewed it, the adopted wording belongs in the policy,
  which links here for the mechanism. The richer evidence extension (§15) is not part of the policy
  unless a later proposal adopts it.
- **TECH-6553 (Sergeant tier classification and tier gating)** — superseded. Do not build reading a
  tier map, computing a PR's tier, or gating review counts and merge by tier. Stage 1 here replaces
  it. Its fail-closed protected-file intent is already built as M15.
- **TECH-6554 (a per-repository review tier map)** — superseded. Recommend not merging the map. If
  the policy owner wants hard human approval for a few paths, for example the review controls and
  identity trust policies, those few patterns go into the repository's ruleset required-reviewer rule
  (§3.2, boundary 5), set by an administrator.

## 13. Out of scope

Implementing any of this, enforcement changes, merge permissions, rulesets, any repository's tier
map, enabling auto-merge, and breaking this into implementation issues. Those follow approval.

## 14. Decisions for the reviewer and the captain

Open:

1. A pure rebase after a declaration counts as DIFFERENT_HEAD, because the decision is about one
   exact SHA. Proposed later-stage reporting may use patch id to print rebase-only failures as a
   sub-count and revisit the classification if they become a noticeable share. Stage 1 does not
   compute or print that sub-count. Excluding them would make a moved base drop a declaration out of
   the denominator.
2. The shadow sample rate at stage 3 (§8): proposed 0.05 (1 in 20 heads in a `sergeant`-policy
   repository go to a human).

Settled by the project owner and reflected above: the **authorized stage 1** is only the readiness
note in every repository, the agreement reconciliation and existing evidence (§0, §2, §4–5, §7.1).
Its closed-unmerged cases are UNKNOWN unless a human explicitly rejected the declared head through
the structured evidence in §5.1. The following are settled design direction but **not authorized
stage-1 implementation**: the public-repository audit filter (§6.4); the 0.1 audit rate, with audits
outside a task on the project owner's budget (§6.2); the two separate review measures (§2.1); the
shadow sample (§8); and audits only in the first repositories working toward auto-merge (§6.2,
§11.7). Success or failure is measured only on the declared-ready SHA, with no separate class for
Sergeant's own revisions (§5.1).

The change-management definition (§8.1) is not a question for this review: it is provisional and
pending review with the auditor.

## 15. Later, on demand: richer review evidence

**Not part of stages 1–3, and not specified here.** If a concrete question eventually needs
company-wide metadata about external tools, new findings or reviewer position, a separate proposal
will design the smallest convention and the parser, reporting and contract changes it requires.
Until then nobody is asked to emit new review metadata, and Sergeant parses only its own readiness
line.

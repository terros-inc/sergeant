# 16 — Evidence-based review and earned merge autonomy (proposal)

**Status: proposal (TECH-6605), pending approval. Nothing here is built, and no other design document
changes until it is approved.** §10 lists the exact changes the approval would make to 01, 05, 06, 08, 09,
10, 11 and 14. Written against `main` at `a84f38c`. People, repositories and SHAs in the examples are
placeholders.

## 0. Summary

We want to learn when an extra review helps, and when Sergeant has earned the trust to merge a
production PR without a human. The alternative under way is a static map that sorts every file path
of a repository into review tiers, then gates review counts and merge rights by tier. This proposal
replaces it with **evidence we can count**, plus a **small number of deterministic boundaries** that
GitHub enforces. It starts small, and adds data only when a question needs it.

- **One readiness declaration per head** (§4). When Sergeant judges that the reviews and checks are
  enough, it posts `READY TO MERGE | SHA: <full head SHA>` with a short reason on the PR, before any
  human acts. It never edits that comment. A new head gets a new assessment. This is the handoff
  summary Sergeant already posts, with a fixed first line added.
- **Agreement is simple** (§5). A human who merges the same pre-merge head that Sergeant declared
  ready has **AGREED**, even after asking for more reviews or waiting a week. A human who required
  changes or explicitly rejected the head has not, and neither has a head Sergeant itself had to
  revise after declaring it ready. Everything else is **UNKNOWN** and is left out of the rate. Squash
  and rebase merges compare the PR's frozen pre-merge head, never the merge commit.
- **Stage 1 uses only the review evidence that already exists** (§2): Sergeant's own reviewer
  verdicts, which `reviews.jsonl` and the run records already hold, and GitHub's native reviews, which
  GitHub already binds to a commit. Nobody is asked to write anything new.
- **Judgment, not counts, decides who else looks** (§3). The worker says whether another review is
  worthwhile, and reasoning can start one. There are no fixed reviewer counts and no path tier map. The
  few hard boundaries stay deterministic, in GitHub rulesets and Sergeant's existing Gate.
- **Independent retrospective audit** (§6, stage 2). The existing stable-hash audit draw is widened
  from "merged Sergeant heads that skipped review" to a random sample of all merged PRs in enrolled
  repositories, Sergeant's or not. Each audit is a fresh reviewer judging the code and requirements as
  of the merge. It records `Found: YES | NO` and never blocks. In a public repository, the PR gets only
  the verdict line and code-only findings that pass a deterministic public-data filter. The full
  details stay in Sergeant's records and Linear (§6.4).
- **Autonomy has to be earned and granted** (§8, stage 3). The target is about 90% AGREED out of the
  evaluated decisions, over a meaningful sample (suggested: 50 per repository). Meeting it only invites
  a human to set the repository's existing `mergePolicy` to `sergeant`. Nothing escalates
  automatically. §8.1 records a **provisional** definition of a "significant" change for the
  organization's change-management control, pending the auditor's review.
- **Queryable reporting, no dashboard** (§7). `sgt review readiness` in stage 1 and `sgt review audits`
  in stage 2 print counts and rates with their numerators and denominators.
- **Later, only on demand: a company-wide review line** (§15). A one-line
  `Review: PASS | Found: YES | SHA: <full SHA>` convention for every reviewer, with its parser,
  reviewer positions and an evidence index, is specified but **not part of stages 1–3**. It is adopted
  only when a specific question needs that data, for example "do added AI reviewers find anything new?".

The economical core of stage 1: **one parsed line on Sergeant's own comment, the agreement rate
computed by rereading GitHub, and one `sgt` command.** No new database, service, policy engine, Gate
rule, index or dashboard.

## 1. What changes and what stays

| Existing machinery | Stays | Changes (stage) |
|---|---|---|
| Fresh-context reviewer runs (06 §2–5) | The required review is still a separately launched reviewer run. The brief already carries human and bot PR feedback and earlier reviews | Stage 1: none; its verdict is read from the records that already hold it (§2). Stage 2: each PR in the report's `reviewed` list gains its own `found`, which the audit's YES/NO needs (§6.3) |
| Review dispositions and D1–D6 (06 §6) | Unchanged. No stage changes a Gate rule. GitHub reviews are evidence and reasoning input, not disposition standing | D4 stops naming the unbuilt `alwaysReviewPaths`. The built protected-CI matcher (M15) stays the deterministic part (§3.2) |
| Calibration sampling, 20% of skipped reviews (06 §8, `audit.ts`) | The stable-hash draw `auditDrawn(rate, head)`, the nonblocking audit reviewer, the after-merge follow-up | Stage 1: 06 §8 is corrected to what is built (the draw runs after the merge). Stage 2: the audit run id becomes unique per repository, PR and head instead of per head SHA, and a second, repository-wide draw over merged PRs reuses the same hash, run id and brief (§6) |
| Review telemetry, `reviews.jsonl` (06 §9) | Every finished review still writes its `ReviewFacts` line | Stage 2: each reviewed PR in `ReviewFacts.subject` gains that PR's `found` and the id of the audit comment posted on it |
| Handoff summary on the PR (08 §7, TECH-5244, TECH-6374) | One comment per head, posted by the control-plane App, older heads' copies minimized (minimized, not edited) | Stage 1: it starts with the readiness line and lists the evidence on that head. It is also posted in `sergeant`-policy repositories, just before the gated approval (§4) |
| `mergePolicy` (08 §2, §7) | The only switch for who merges. It defaults to `human`, and only an operator sets it | Stage 3 defines the evidence a human looks at before setting it to `sergeant` (§8) |
| Rulesets, required checks, M1–M15 | Unchanged. Sergeant never changes rulesets | A repository's hard human-review boundaries live in its ruleset's required-reviewer rule. They should stay a short list, not a tier map (§3.2) |
| Public-data check (`check-public-data.mjs`, the installation's `publicDataDenylistSecret`) | The canonical check and its denylist, as the pre-push hook and CI use them | Stage 2: the core also runs it on every audit comment before posting it on a public repository's PR (§6.4) |
| `sgt review quality` (designed, 06 §9, not built) | Its metrics, unchanged and not scheduled by this proposal | Stage 1 adds `sgt review readiness`; stage 2 adds `sgt review audits` (§7) |

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
  adopted, the review line (§15).

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

In a public repository, the model-written `Reason:` and suggestion lines go through the same
public-data check as an audit comment, failing closed the same way (§6.4, steps 3 and 4), before
posting. Text that fails, or cannot be checked, is replaced by the fixed line "Reason recorded in
Sergeant's task record". The first line, the head SHA, the evidence list and the check counts are
built from records, not prose, and are always posted.

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
- **A changed head needs a new assessment.** The old declaration stays as history for the old head
  and says nothing about the new one. Sergeant declares again only when the new head passes the
  preflight again.
- **No withdrawal line.** If a later review on the same head fails, that review sits on the PR beside
  the declaration, and the human sees both. The declaration is classified only by what the human
  finally did (§11.3).
- **Existing records, no new store.** The handoff record in `state.json` (`refusedMerges`, H1) and
  the merge record (`merged`) gain the readiness comment's id. These records are how `sgt review
  readiness` finds Sergeant's declarations (§7.1). Linear's "Ready for a human to merge" comment links
  to the PR comment. The `merge_pr` action gains a `readinessReason`, the one or two sentences
  reasoning writes. Nothing else is stored.

## 5. Human agreement (stage 1)

### 5.1 Classes

Each Sergeant readiness declaration *D* (head *H*, posted at time *T*) gets exactly one class. It is
computed from GitHub when queried, never stored as a judgment, so a corrected rule reclassifies
history without migration. Only closed PRs are evaluated.

| Class | When | In the rate? |
|---|---|---|
| **AGREED** | The PR was merged by a human account after *T* (`merged_at` > *T*), and its pre-merge head equals *H* | numerator and denominator |
| **CHANGES_REQUIRED** | The PR closed (merged or not) at a head whose patch differs from *H*'s, and between *T* and the next Sergeant declaration on the PR (or the merge or close, if there is none) a human gave input: a `User` account other than the PR's author submitted a review, a review comment, or a PR comment, or a commit appeared whose GitHub-linked author or committer is a `User` | denominator |
| **SELF_REVISED** | The PR closed at a head whose patch differs from *H*'s, with no human input in that window: Sergeant's own later review or worker changed the code after declaring it ready | denominator |
| **REJECTED** | The PR was closed unmerged at head *H* after *T* by a human (the timeline's `closed` actor is a `User`) | denominator |
| **UNKNOWN** | Anything else, with a reason: `pending` (still open), `abandoned` (closed unmerged by Sergeant or another bot, as when a task stops, TECH-5230), `superseded` (the head changed but its patch did not, a pure rebase onto a moved base), `not_human_merge` (merged by Sergeant or another bot, which includes all of stage 3's own merges), `uninterpretable` (merger unknown, merged before *T*, a malformed declaration) | excluded, reported |

**Agreement rate = AGREED / (AGREED + CHANGES_REQUIRED + SELF_REVISED + REJECTED)**, always printed as
the fraction, with each class and the UNKNOWN count and its reasons beside it.

"Patch differs" is decided by `git patch-id --stable` of the diff from the merge-base with the
default branch to each head. A pure rebase keeps the same patch id and is `superseded`. Any content
change after a declaration counts against it, so a wrong readiness call cannot drop out of the
denominator by being revised before a human speaks.

The human's path does not matter, only where it ends. A human who asked for another bot review,
requested changes and then dismissed that request, or let the PR sit for days, and then merged *H*,
**AGREED**. A delayed review of the same head is therefore counted when the merge happens, and the
declaration counts as `pending` until then.

Human input in CHANGES_REQUIRED is **deliberately broad** (§14, question 3). Any human review or
comment in the window, followed by a changed patch, counts against agreement, even "LGTM, one optional
nit" when the nit is then fixed. That biases the rate down, the safe direction for an autonomy
threshold. Telling such comments apart would need semantic judgment in code, which the charter
avoids, or a person labelling cases.

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
- **Reviewing identities.** The stage 1 evidence of §2 on *H* and on any earlier head: the native
  reviews (account, type, state, `commit_id`) and Sergeant's reviewer runs (run id, provider,
  verdict). They are read with the declaration's outcome, so a query can ask "agreed after which
  reviews?".
- **Closer identity.** The timeline's `closed` event actor, for REJECTED and `abandoned`. A plain
  push is visible only as a `committed` timeline event with git author data, not the pushing account,
  so "a human commit" is defined by the commit's GitHub-linked author or committer (§5.1).

### 5.3 Worked examples

| Sequence on one PR | Declarations → class |
|---|---|
| D1 at A. The owner requests another AI review, waits 3 days, approves A, merges | D1 AGREED |
| D1 at A. The owner leaves a CHANGES_REQUESTED review. The worker fixes it as B. D2 at B. The owner approves and merges B (squash) | D1 CHANGES_REQUIRED, D2 AGREED (pre-merge head B, not the squash commit) |
| D1 at A. Main moves, and the worker rebases as B with no human input and the same patch. D2 at B. A human merges B | D1 UNKNOWN (`superseded`), D2 AGREED |
| D1 at A. A third-party review bot then finds a real bug, and the worker fixes it as B before any human speaks. D2 at B. A human merges B | D1 SELF_REVISED, D2 AGREED |
| D1 at A. A human closes the PR | D1 REJECTED |
| D1 at A. The issue is cancelled, and Sergeant closes its PR (TECH-5230) | D1 UNKNOWN (`abandoned`) |
| D1 at A in a `sergeant`-policy repository. Sergeant merges A | D1 UNKNOWN (`not_human_merge`). Audits measure these (§6) |
| D1 at A. A human pushes a commit C and merges C | D1 CHANGES_REQUIRED |

## 6. Post-merge audit (stage 2)

### 6.1 What is built and reused

`audit.ts` already draws, once per Sergeant merge, `auditDrawn(rate, head)`: a stable SHA-256 hash of
`["audit", repo, number, headSha]` against `review.auditSampleRate` (default 0.2). It applies only to
merged heads no fresh review approved. A drawn head gets a nonblocking reviewer run
(`run_audit-<headSha>` today, made unique per PR in §6.2) of exactly that head, and its must-fix
findings are kept as follow-up work and told to the issue. 06 §8 still says the draw happens when a
`not_required` disposition is recorded, before the merge. The proposal corrects it to the built
behavior in stage 1 (§10.1).

### 6.2 Widened to all merged PRs in enrolled repositories

- **Discovery.** A daily background loop lists, for each enrolled repository, the PRs merged into its
  default branch in the last 72 hours (`pulls?state=closed&base=<default>&sort=updated&direction=desc`,
  paged until `updated_at` is older than the window, keeping those with `merged_at` inside it). The
  overlap tolerates a missed day. A PR merged without a pull request (a direct push, an admin bypass)
  is not discoverable this way (§11.7).
- **The draw.** The same stable-hash function on the PR's identity and pre-merge head, salted
  differently (`["merged-audit", repo, number, headSha]`), so two PRs that share a head SHA are drawn
  independently, against a separate `review.mergedAuditSampleRate` (proposed default 0.1). Unsalted,
  every head drawn at 0.1 would also be drawn at 0.2, so the two samples would be nested. Salted, they
  are independent. A Sergeant head that skipped review is still drawn at the 20% rate (§6.1). A PR
  drawn by both is audited once.
- **One audit identity per repository, PR and head.** Today's id, `run_audit-<headSha>`, names only
  the commit. The same commit can be the head of PRs in two repositories (a fork, a mirror, a
  vendored copy) or of two PRs in one repository (a PR closed and reopened under a new number, a
  stacked PR whose base merged). A repository-wide scan meets those cases, and with a SHA-only id the
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
- **Who pays.** Sergeant task audits stay on the task owner's registered accounts (TECH-5179). A PR
  with no Sergeant task has no owner, so the installation configures `review.auditOwner`: the person
  whose registered model accounts run repository-wide audits. A daily cap
  (`review.qualityBudgetUsdPerDay`, already designed in 06 §8) bounds the cost. With no owner
  configured, repository-wide audits do not run.

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
`refusedMerges` and `merged` record with a `readinessCommentId` (§4.2). For each, the command rereads
the PR from GitHub (the PR, its reviews, issue and review comments, timeline and commits), joins
Sergeant's reviewer runs from `reviews.jsonl` by run id, and classifies the declaration (§5.1). The
reads are the conditional, rate-limited reads every GitHub read already uses (08 §9), a handful per
declared PR. What if we lose it? Nothing: there is no derived state, only the task records Sergeant
already keeps and GitHub. If rereading becomes slow, a cache of closed PRs' facts can be added; it
would be disposable.

Following the existing `sgt` patterns (`--since`, `--json`, read-only, Linear-login bearer):

```
sgt review readiness [--since 90d] [--repo <slug>] [--list]
```

`--list` prints each declaration with its PR link, head, class and reason, so every number links back
to evidence a person can read on GitHub. `/v1/review-readiness` serves the same data. Example
(`sgt review readiness --repo example-org/example-app --since 90d`):

```
Sergeant readiness, example-org/example-app, last 90 days
  AGREED 41 / evaluated 47 = 87.2%   (CHANGES_REQUIRED 4, SELF_REVISED 1, REJECTED 1)
  UNKNOWN 9: pending 3, superseded 4, abandoned 2
  Of AGREED: a human GitHub review APPROVED the same head first 17, merged with no further review 24
  Of AGREED: Sergeant reviewer approve 38, no fresh review (not_required) 3
  Mergers: example-owner 30, example-dev 11
```

### 7.2 Stage 2: `sgt review audits`

```
sgt review audits [--since 30d] [--repo <slug>] [--found] [--by repo|sergeant]
```

It reads the audits' `ReviewFacts` lines in `reviews.jsonl`. `--found` lists every `Found: YES` with
its PR link and the full findings, which a public PR does not show (§6.4). `--by sergeant` splits
Sergeant-ready and human-merged, Sergeant-merged, and non-Sergeant PRs. `/v1/review-audits` serves
the same data. The MCP client's fixed tool list (11 §1) gains one read-only `review_report` tool over
the two routes.

### 7.3 Metrics, with numerator and denominator

| Metric | Stage | Numerator | Denominator |
|---|---|---|---|
| Readiness agreement, by repository | 1 | AGREED | AGREED + CHANGES_REQUIRED + SELF_REVISED + REJECTED (UNKNOWN printed separately, by reason) |
| Agreed after which review, by repository | 1 | AGREED declarations whose head had a human `APPROVED` native review before the merge / a Sergeant reviewer `approve` / neither | AGREED |
| Merger identity | 1 | evaluated declarations on merged PRs, by `merged_by` login | evaluated declarations on merged PRs |
| Post-merge audit yield | 2 | completed audits with `Found: YES` | completed audits with a known `Found`, split by: Sergeant-ready and human-merged, Sergeant-merged, non-Sergeant PR |
| Audit FAIL rate | 2 | completed audits with `FAIL` | completed audits |
| Under-review (06 §9, kept) | 2 | audited Sergeant skips with ≥ 1 blocking finding that led to a change or was not disputed | audited Sergeant skips |

Every rate is printed as its fraction. The 06 §9 metrics stay as designed. No metric gets a target in
code. §8's 90% is a threshold for a human to consider. Coverage by reviewer position, the Found rate
of each reviewer, and how often an added reviewer contributes something new are the review-line
extension's metrics (§15.4); they need data stages 1–3 do not collect.

## 8. Earned autonomous merge (stage 3)

- **The objective, per repository.** The agreement rate of Sergeant's readiness declarations, at or
  above about **90%** over at least **50 evaluated decisions**, alongside the post-merge audit yield
  on Sergeant-ready heads. Per repository, because stakes and conventions differ. `sgt review
  readiness` and `sgt review audits` print both. With 50 decisions, 45 AGREED still allows a true
  rate somewhere in the high 70s to mid 90s at 95% confidence, so the number invites a decision; it
  does not make one.
- **The authorization.** A person with operator rights deliberately sets that repository's existing
  `mergePolicy` to `sergeant` (`sgt admin repo …`). Sergeant never changes it, never asks for it
  automatically, and never escalates on a threshold. For a repository whose merge deploys to
  production, this is a deliberate exception to the settled decision in 14 §A, so the captain
  records it there, per repository, with the evidence. It also needs the organization's
  change-management control to accept it (§8.1).
- **What still holds after it.** Every hard boundary in §3.2: required checks, M15's human review and
  merge for CI changes, any ruleset required-reviewer path (GitHub refuses, and Sergeant hands off,
  M12), M8, M10, M13 and M14. Merges stay gated by D1–D6.
- **Restricting.** Reports keep running after the switch. Agreement can no longer be measured on
  Sergeant's own merges (they are `not_human_merge`), so the post-merge audit yield on Sergeant-merged
  heads becomes the signal. Defects humans report later would add to it once `defectReports` (01,
  designed but not built) exists. A human sets the policy back to `human` when those signals warrant
  it. No automatic demotion is proposed: it would add a deterministic rule the charter reserves for
  preventing material harm, and the hard boundaries already do that. An option for the captain at
  stage 3: keep a small stable-hash sample of heads handed to a human anyway (reusing `auditDrawn`),
  so agreement keeps being measured.

### 8.1 "Significant" changes for change management (provisional, pending auditor review)

The organization's SOC 2 change-management control requires significant changes to be reviewed and
approved before they reach production. For the audit period of **1 December 2026 to 1 March 2027**,
the working definition is:

- **Until a repository reaches stage 3** (its `mergePolicy` is `sergeant`), every production merge in
  that repository stays human-approved, as it is today. Nothing in stages 1 and 2 changes who
  approves or merges.
- **After a repository reaches stage 3**, a "significant" change is:
  - any change that the hard-rule list of §3.2 sends to a human, which today means protected CI
    configuration (M15) and the repository's ruleset required-reviewer paths (boundary 5); and
  - every change in a repository that has **not** been granted auto-merge.

  Significant changes keep human approval. Other changes in a stage-3 repository are approved by the
  independent reviewer and the evidence of §7, under Sergeant's Gate.

**This definition is provisional. It is pending review with the auditor and is not final.** It may
change before or during the audit period. It is recorded here so the design and the control describe
the same boundary; the adopted wording belongs in the organization's review policy (§12, TECH-6510).
Deterministically, this needs nothing new: the first part is `mergePolicy: human` (boundary 2), and
the second is boundaries 3 and 5, which GitHub and the Gate already enforce under every policy.

## 9. Staged rollout

**Stage 1 — readiness and agreement on existing evidence.** No merge rule changes.
1. Post the readiness declaration as the first line of the per-head summary, in every policy, with
   one-per-head deduplication and narrowed minimizing (§4).
2. Record `readinessCommentId` on the `refusedMerges` and `merged` records, and `readinessReason` on
   `merge_pr`.
3. Build `sgt review readiness` and `/v1/review-readiness`, classifying by rereading GitHub, with the
   evidence of §2 (Sergeant's reviewer runs and GitHub native reviews) (§7.1).
4. Correct 06 §8 to the built after-merge draw. Drop `alwaysReviewPaths` from the design.

Nothing is asked of humans or external assistants: no convention, no template line.

Exit: a readiness line appears on every Sergeant PR head that passes the preflight, and the readiness
report matches a hand count on a sample of PRs.

**Stage 2 — expanded post-merge audits.**
1. The per-repository, per-PR, per-head audit run id, and per-PR `found` in the reviewer report and
   `ReviewFacts` (§6.2, §6.3).
2. The repository-wide discovery and draw (§6.2), `review.mergedAuditSampleRate`,
   `review.auditOwner`, and the daily cap.
3. The as-of-merge audit brief, the audit comment with the public-repository filter (§6.4), and
   `sgt review audits`.

Exit: audits cover a random sample of all merged PRs in enrolled repositories, Sergeant's or not;
every `Found: YES` is in `sgt review audits --found`; and a public repository's PRs show only the
verdict line and filtered findings.

**Stage 3 — earned autonomous merge, later and per repository.** Once a repository has ≥ 50
evaluated decisions at about 90% agreement and an acceptable audit yield, the captain and the policy
owner decide whether to set `mergePolicy: sergeant` there (§8), under the change-management
definition in force then (§8.1). No code change is needed for the switch itself. The only optional
code is the shadow handoff sample.

**On demand — the company-wide review line (§15).** Not scheduled. It is adopted, as its own
decision, only when a specific question needs per-reviewer `Found` data or reviewer positions, and it
can come before or after stage 3. Until then nobody is asked to write it and nothing parses it.

Nothing in any stage is built until this proposal is approved. Implementation issues are written
then.

## 10. Exact proposed changes to existing contracts

These are applied when the proposal is approved, each by the issue that implements its stage. Each
owning section is edited in place, and other documents link to it (rule ownership per `AGENTS.md`).
The review line's changes are listed separately in §15.5 and applied only if it is adopted.

### 10.1 `06-review.md`

- **§3 table** (stage 1): in the `not_required` row, replace "no `alwaysReviewPaths` touched" with "no
  protected CI configuration touched (08 M15)".
- **§6 D4** (stage 1): replace "and the PR's changed files match none of the repository's
  `alwaysReviewPaths`. Built today: a PR changing protected CI configuration, or whose changed files
  are unknown, never gets it (08 §7, M15)" with "and the PR changes no protected CI configuration and
  its changed files are known (08 §7, M15)".
- **§8** (stage 1): rename it "Post-merge audits". Replace the `onNotRequiredRecorded` pseudocode and
  its first bullet with the built behavior: "Once per Sergeant merge, a merged head no fresh review
  approved is drawn with `auditDrawn(review.auditSampleRate, head)`." Keep: nonblocking, the stable
  hash, after-merge surfacing.
- **§8** (stage 2): the audit run id is `auditRunId(repo, number, headSha)` (proposal §6.2), replacing
  `run_audit-<headSha>`. Add the repository-wide draw (proposal §6.2), the finding (§6.3) and the
  surfacing rules, including the public-repository filter (§6.4), as subsections; 06 §8 becomes their
  **owning section**.
- **§8, last bullet** (stage 2) ("charged to the installation's review-quality budget, not the
  task's"): replace with the built rule (the task owner's accounts, TECH-5179) and, for audits outside
  a task, `review.auditOwner` under the daily cap (proposal §6.2).
- **§9** (stage 2): add the audit metrics of proposal §7.3 and name `sgt review audits` as their
  report.
- **§11 Not built** (stage 1): add "No path tier map, fixed reviewer counts, or sensitivity file list.
  The few hard boundaries are in 08 §2 and M15."

### 10.2 `08-github-contract.md`

- **§2 item 7** (`alwaysReviewPaths`, stage 1): replace it with "Optionally, a short ruleset
  required-reviewer rule (about ten patterns at most) for changes a human must approve whatever the
  evidence. GitHub enforces it, and Sergeant hands off when GitHub refuses (M12)."
- **§7 handoff** (stage 1): the PR summary starts with the readiness line (proposal §4), is posted
  once per head before any approval, merge, or handoff call **in every policy**, and is never edited;
  its comment id is kept on the `refusedMerges` and `merged` records. The Linear handoff comment links
  to it. In a public repository its model-written text goes through the public-text filter of 06 §8.
- **§7 handoff, minimizing** (stage 1): narrow TECH-6374's rule to readiness or summary comments for
  other heads (proposal §4.2).
- **New §12 "Readiness and agreement"** (stage 1): the readiness line and rules (proposal §4), the
  agreement classes and mechanics (proposal §5), and the stage-1 evidence they read (proposal §2), as
  the **owning section**.
- **§11** (stage 2): allow, besides the handoff summary and the stop comment, "Sergeant's post-merge
  audit comments on enrolled PRs, filtered on public repositories (06 §8)".
- **§1, control-plane App row** (stage 2): add the audit comments to "used for", before "nothing
  else".

### 10.3 `01-domain-model.md` and `05-brief-report-protocol.md`

- Stage 1: the `RefusedMerge` and `merged` records gain `readinessCommentId?`. The `merge_pr` action
  (`MergePr`) gains `readinessReason`.
- Stage 1: `alwaysReviewPaths` is removed from 01 (the repository config and `reviewPolicy`) and from
  05 §5's last sentence, which then points to M15.
- Stage 2: the reviewer report (`s2-review-report`): each entry of `reviewed` gains `found?: boolean`
  ("on this PR head you raised at least one actionable finding not already raised on this PR").
  Optional, so older reports still parse; a missing value falls back as in proposal §6.3.
- Stage 2: `ReviewFacts`: each `subject` entry (`{ repo, number, headSha }`) gains `found?: boolean`
  and `auditCommentId?`. Both are per reviewed PR, never per run.
- Stage 2: the audit run id (`audit.ts`, the `merged` record's `audit.runId`): new draws use
  `auditRunId(repo, number, headSha)` from proposal §6.2 instead of `run_audit-<headSha>`. Stored ids
  are read back unchanged.
- Stage 2: the reviewer run's start spec and brief: an optional Linear conversation, an explicit base
  SHA, a merge-time cutoff for PR feedback, and an audit focus for PRs outside a task (proposal §6.2).
  A new reviewer rule: on a public repository, word findings about the code only, never quoting or
  paraphrasing issue content. The rule reduces dropped findings; the core's filter (06 §8) is the
  safeguard.

### 10.4 `10-installation-config.md` and `11-apis-cli.md`

- Configuration (stage 2): `review.mergedAuditSampleRate` (0–1, default 0.1 once stage 2 ships, 0
  before) and `review.auditOwner` (a person's id, no default). `publicDataDenylistSecret` gains a
  second reader: the core's audit-comment filter, which posts verdict lines only when it is absent.
- Background loops (stage 2): "repository-wide audit draw (daily)".
- CLI and API: `sgt review readiness` and `/v1/review-readiness` (stage 1); `sgt review audits` and
  `/v1/review-audits` (stage 2); the MCP `review_report` tool (proposal §7.2).

### 10.5 `09-security.md`

- Stage 1: the skipped-review sentence ("narrowed by optional `alwaysReviewPaths`") becomes "narrowed
  by the protected-CI matcher (08 M15) and any ruleset required-reviewer paths".
- Stage 2: under public repositories, add "Sergeant's own PR comments on a public repository carry
  only fixed text and code-anchored findings that pass the public-data check; the full text stays in
  Sergeant's records (06 §8)".

### 10.6 `14-open-questions.md`

- §A: a note under the production `mergePolicy` decision: "a per-repository exception, decided by the
  captain on the evidence of 08 §12 and 06 §8–9 (proposal 16 §8), is recorded here, under the
  change-management definition in force (proposal 16 §8.1, provisional)".
- §C: a new tension: "agreement is measured only on human merges, so it stops accruing in a repository
  once Sergeant merges there; audits carry the signal after that".

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
- Crediting the tool behind a person's account needs typed attribution, which only the review line
  offers (`By:`, §15.1), as attribution, never authority.
- Considered and rejected: signed review attestations or a reviewer registry. They are heavy, and the
  audit sample tests reviewer quality more directly than an identity proof could.

### 11.2 Provenance of external comments

Stage 1 parses no external comment text. Native reviews are bound to a commit and can be dismissed
but not re-pointed. Comments can be edited or deleted after posting; the classification reads GitHub
when queried, so a deleted review is absent, which is accepted: its author withdrew it. Human input
for CHANGES_REQUIRED (§5.1) uses comment existence and time, not content, so an edit changes nothing.
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

The rules are structural (who merged which head, and whether a human spoke up first) and computed
from GitHub at query time, so they are reproducible by anyone with read access. Accepted biases, all
downward: any human comment followed by a changed patch counts as CHANGES_REQUIRED; a human pushing a
fix counts too, even if Sergeant would have made the same fix; and any change Sergeant makes on its
own after declaring a head ready counts as SELF_REVISED. Only a pure rebase drops out (`superseded`).
Accepted gaps: decisions on PRs that are still open are `pending`, so a slow-reviewing repository
accrues slowly. A merge by a merge-queue bot with no human enqueuer is `uninterpretable`.

### 11.5 External-review accounting

Stage 1 counts external reviews only as GitHub records them: a native review by an account, with a
verdict for one commit, or none for `COMMENTED`. Human reviewers and external assistants change
nothing. The cost is what stage 1 cannot see: whether a review found something new, and which tool
was behind a person's account. That is deliberate. The review line (§15) would answer both, but it
asks every reviewer in the company to adopt a convention and needs a parser, positions and an index;
it waits for a question that needs it. Audits record `Found` for their own reviews from stage 2, from
the reviewer's report rather than from GitHub text. Author-side reviews are kept but never shown as
independent.

### 11.6 Samples and denominators

Every rate is printed as a fraction. UNKNOWN is excluded but always shown with its reasons, so a
large UNKNOWN share is visible instead of silently inflating the rate. 50 evaluated decisions per
repository is a minimum for a human to look, not proof (§8). Rates are reported over a window
(`--since`), so a prompt or reviewer-rule change can be judged by comparing windows. No rate resets
automatically. The audit sample rates trade cost against how fast the audit yield becomes
meaningful. At 10% of merged PRs, a repository merging 100 PRs a month yields about 10 audits a
month.

### 11.7 Repository-wide post-merge audit discovery, and public repositories

Only enrolled repositories can be audited, because Sergeant's Apps and read token reach only those.
That narrows "across the organization" to its enrolled repositories. Full enrollment (08 §2) asks for
rulesets and a `mergePolicy`, which a repository Sergeant never merges in may not want. An
audit-only enrollment (Apps installed, read and comment only, no task work) would close the gap, and
is left as a decision (§14, question 5). Discovery reads merged PRs, so a change that reached the
default branch without a PR (an admin bypass, a direct push) is invisible to it. Rulesets should make
that rare, and an organization's break-glass process covers it separately. Running audits on PRs
nobody delegated to Sergeant spends someone's model accounts, hence `review.auditOwner` and the daily
cap.

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

## 12. What this supersedes or redirects

This PR changes none of the following. It recommends:

- **TECH-6510 (adopt the code review policy)** — redirect. The draft policy takes a path-tier
  approach with fixed review counts per tier. Recommend that the policy adopt this evidence-based
  model instead: readiness, agreement, audits, and §3.2's short list of hard boundaries, keeping the
  policy's own authorization, required-CI and exception sections. The change-management definition of
  §8.1 is provisional; once the auditor has reviewed it, the adopted wording belongs in the policy,
  which links here for the mechanism. The review line (§15) is not part of the policy until it is
  adopted.
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

1. Is the readiness declaration posted in `sergeant`-policy repositories too (proposed: yes, for one
   uniform record), even though those decisions are always `not_human_merge`?
2. `review.mergedAuditSampleRate` default (proposed 0.1) and who `review.auditOwner` is.
3. Should CHANGES_REQUIRED stay as broad as proposed (§5.1), or count only `CHANGES_REQUESTED` reviews
   and human commits? The latter is narrower and biases agreement upward.
4. At stage 3, keep a shadow sample of heads handed to humans to keep measuring agreement (§8)?
5. Repository-wide audits reach enrolled repositories only (§11.7). Accept that, or add an
   audit-only enrollment for repositories Sergeant never works in?
6. SELF_REVISED (§5.1) counts Sergeant's own post-declaration fixes against agreement. That is a
   class the issue did not name. It is added so a premature declaration cannot drop out of the
   denominator. Keep it?
7. Public repositories (§6.4): post code-anchored findings that pass the filter (proposed), or the
   verdict line only?

The change-management definition (§8.1) is not a question for this review: it is provisional and
pending review with the auditor.

## 15. Later, on demand: the company-wide review line

**Not part of stages 1–3.** This section specifies the convention so it is ready when needed. It is
adopted, as its own decision, only when a specific question needs its data: for example "how often
does an added AI reviewer find something new?", "which reviewers' approvals do audits later
contradict?", or "how much of our review coverage comes from assistants under people's accounts?".
Until then nobody is asked to write it and Sergeant parses nothing but its own readiness line.

### 15.1 The line

One line, anywhere in a GitHub review body, inline review comment, or PR conversation comment:

```
Review: PASS | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f
Review: FAIL | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f | By: Claude Code
```

| Field | Meaning |
|---|---|
| `Review: PASS` / `FAIL` | This exact head is fit to merge as it is / something must change, or a human must decide, first |
| `Found: YES` / `NO` | The reviewer raised at least one **actionable observation not already raised on this PR**, by anyone / nothing new. A `PASS` can be `Found: YES` |
| `SHA:` | The full 40-hex (or 64-hex) commit SHA reviewed; an abbreviated SHA does not count |
| `By:` | Optional, at most 64 characters: the tool that actually produced the review when the posting account is a person's. **Attribution only, never authority** (§11.1) |

Parsing: a line must match
`^Review: (PASS|FAIL) \| Found: (YES|NO) \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})( \| By: [^|\n]{1,64})?$`,
outside fenced code blocks and `>` quotes. A comment with more than one line counts none and is
uninterpretable. A native review with a line is one piece of evidence; a native state that disagrees
with its line (`APPROVED` with `FAIL`) is uninterpretable. Nothing else is required: no purpose,
severity, trust score, YAML, or JSON. The reasons stay in ordinary comments.

Sergeant's required reviewer would then post its result as a line too, one comment per reviewed PR,
keyed `review-evidence:<runId>:<repo>#<n>`, with that PR's `found` (§6.3). On a public repository it
uses the same filter as an audit comment (§6.4). Post-merge audit comments would switch their first
line to the review line with `post-merge audit` in the prose.

### 15.2 Reviewer position and ordinal

From GitHub facts only: `sergeant` (posted through the control-plane App), `human` (a `User` account,
no `By:`), `assistant` (a `User` account with `By:`), `bot` (a `Bot` account other than Sergeant's
Apps), `author` (the PR author's account, or the worker App on a Sergeant PR, whatever `By:` says).
**External** means `assistant` plus `bot`; `author` evidence never counts as independent. The ordinal
is the order in which distinct independent reviewer identities first left evidence on the PR.

### 15.3 The evidence index

A daily job writes one JSON line per closed PR of each enrolled repository to
`<state dir>/evidence/<owner>__<repo>.jsonl`: the PR facts, every parsed line and native review with
its position and ordinal, and the audit run id. It is a cache of GitHub facts, rebuilt by re-scanning
`review.evidenceBackfillDays` (default 180), never a ledger. A PR is indexed once after it closes,
and lines edited after posting are flagged.

### 15.4 Its metrics

`sgt review quality --by reviewer|position|ordinal` (06 §9) would add: independent coverage by
position on the merged head and at any head; merged PRs with no independent evidence; who approved;
Found rate by reviewer, position, ordinal or provider (evidence with `Found: YES` over evidence with a
known `Found`, one unit per PR head); added-reviewer contribution (the same at ordinal ≥ 2); and the
FAIL rate by reviewer. Audit yield would also split by whether the merged head had independent
evidence.

### 15.5 Its contract changes, if adopted

06 gains a "Review evidence on GitHub" section owning §15.1–15.2; 06 §9 gains §15.4's metrics; 01
gains `EvidenceLine` (marked "derived cache") and `ReviewFacts.subject[].evidenceCommentId?`; the
reviewer and worker reports gain `moreEyes?: string`; 10 gains `review.evidenceBackfillDays` and the
"evidence index (daily)" loop; 08 §11 and §1 allow the evidence comments; and the organization's
review policy and PR template publish the line for humans and assistants.

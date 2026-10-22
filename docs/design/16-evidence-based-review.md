# 16 — Evidence-based review and earned merge autonomy (proposal)

**Status: proposal (TECH-6605), pending approval. Nothing here is built, and no other design document
changes until it is approved.** §10 lists the exact changes the approval would make to 01, 05, 06, 08,
10, 11 and 14. Written against `main` at `8bf4690`. People, repositories and SHAs in the examples are
placeholders.

## 0. Summary

We want to learn when an extra review helps, and when Sergeant has earned the trust to merge a
production PR without a human. The alternative under way is a static map that sorts every file path
of a repository into review tiers, then gates review counts and merge rights by tier. This proposal
replaces it with **evidence we can count**, plus a **small number of deterministic boundaries** that
GitHub enforces.

- **GitHub holds the review evidence** (§2). Any reviewer, whether Sergeant's fresh-context reviewer,
  a developer, a human reviewer, or an AI assistant working under a person's account, leaves one
  line on the PR: `Review: PASS | Found: YES | SHA: <full head SHA>`. The explanation stays in
  ordinary comments. GitHub already records who posted it and when. Sergeant reads and indexes this
  evidence but does not own it.
- **Judgment, not counts, decides who else looks** (§3). The worker says whether more independent
  eyes are worthwhile and who could add context. Any later reviewer can ask for another bot or a
  human. There are no fixed reviewer counts and no path tier map. The few hard boundaries stay
  deterministic, in GitHub rulesets and Sergeant's existing Gate.
- **One readiness declaration per head** (§4). When Sergeant judges that the reviews and checks are
  enough, it posts `READY TO MERGE | SHA: <full head SHA>` with a short reason on the PR, before any
  human acts. It never edits that comment. A new head gets a new assessment. This is the handoff
  summary Sergeant already posts, with a fixed first line added.
- **Agreement is simple** (§5). A human who merges the same pre-merge head that Sergeant declared
  ready has **AGREED**, even after asking for more reviews or waiting a week. A human who required
  changes, or explicitly rejected the head, has not. Everything else is **UNKNOWN** and is left out
  of the rate. Squash and rebase merges compare the PR's frozen pre-merge head, never the merge
  commit.
- **Autonomy has to be earned and granted** (§8). The target is about 90% AGREED out of the evaluated
  decisions, over a meaningful sample (suggested: 50 per repository). Meeting it only invites a human
  to set the repository's existing `mergePolicy` to `sergeant`. Nothing escalates automatically.
- **Independent retrospective audit** (§6). The existing stable-hash audit draw is widened from
  "merged Sergeant heads that skipped review" to a random sample of all merged PRs in enrolled
  repositories, Sergeant's or not. Each audit is a fresh reviewer judging the code and requirements
  as of the merge. It records `Found: YES | NO` and never blocks.
- **Queryable reporting, no dashboard** (§7). A derived, rebuildable evidence index and `sgt review`
  subcommands give counts and rates, with numerators and denominators, by reviewer and by reviewer
  position.
- **Staged rollout** (§9). Stage 1 adds the evidence and readiness instrumentation and changes no
  merge rule. Stage 2 expands the post-merge audits. Stage 3, earned autonomous merge, comes later,
  per repository, by explicit human decision.

The economical core: **two parsed lines on GitHub, one derived index, one widened audit draw, and
two CLI views.** No new database, service, policy engine, Gate rule, or dashboard.

## 1. What changes and what stays

| Existing machinery | Stays | Changes |
|---|---|---|
| Fresh-context reviewer runs (06 §2–5) | The required review is still a separately launched reviewer run. The brief already carries human and bot PR feedback and earlier reviews | Its result is also posted on the PR as a review line (§2.3). Its report gains `found` and optional `moreEyes` (§10.3) |
| Review dispositions and D1–D6 (06 §6) | Unchanged. Stage 1 and 2 change no Gate rule. External reviews are evidence and reasoning input, not disposition standing | D4 stops naming the unbuilt `alwaysReviewPaths`. The built protected-CI matcher (M15) stays the deterministic part (§3.2) |
| Calibration sampling, 20% of skipped reviews (06 §8, `audit.ts`) | The stable-hash draw `auditDrawn(rate, head)`, the nonblocking audit reviewer, the after-merge follow-up | 06 §8 is corrected to what is built (the draw runs after the merge). A second, repository-wide draw over merged PRs reuses the same hash and brief (§6) |
| Review telemetry, `reviews.jsonl` (06 §9) | Every finished review still writes its `ReviewFacts` line | `ReviewFacts` gains `found` and the PR comment id of its posted evidence. An evidence index joins it with GitHub (§7.1) |
| Handoff summary on the PR (08 §7, TECH-5244, TECH-6374) | One comment per head, posted by the control-plane App, older heads' copies minimized (minimized, not edited) | It starts with the readiness line and lists the evidence on that head. It is also posted in `sergeant`-policy repositories, just before the gated approval (§4) |
| `mergePolicy` (08 §2, §7) | The only switch for who merges. It defaults to `human`, and only an operator sets it | Stage 3 defines the evidence a human looks at before setting it to `sergeant` (§8) |
| Rulesets, required checks, M1–M15 | Unchanged. Sergeant never changes rulesets | A repository's hard human-review boundaries live in its ruleset's required-reviewer rule. They should stay a short list, not a tier map (§3.2) |
| `sgt review quality` (designed, 06 §9, not built) | Its metrics | Built as part of stage 1, with `--by reviewer | position`, plus `sgt review readiness` and `sgt review audits` (§7.2) |

## 2. Review evidence on GitHub

### 2.1 The review line

One line, anywhere in a GitHub review body, inline review comment, or PR conversation comment:

```
Review: PASS | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f
```

with an optional attribution when a person's account posts what an AI produced:

```
Review: FAIL | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f | By: Claude Code
```

| Field | Meaning |
|---|---|
| `Review: PASS` | The reviewer judges this exact head fit to merge as it is. Nonblocking suggestions may remain |
| `Review: FAIL` | Something must change, or a human must decide, before this head merges |
| `Found: YES` | The reviewer raised at least one **actionable observation not already raised on this PR**, by anyone. A `PASS` can be `Found: YES` (a new nonblocking suggestion) |
| `Found: NO` | Nothing new: the reviewer agrees with what is already there, or found nothing |
| `SHA:` | The full 40-hex (or 64-hex) commit SHA reviewed. An abbreviated SHA does not count, because a review covers one exact head |
| `By:` | Optional, at most 64 characters: the tool or bot that actually produced the review when the posting account is a person's. **Attribution only, never authority** (§11.1) |

Parsing is strict and small: a line must match
`^Review: (PASS|FAIL) \| Found: (YES|NO) \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})( \| By: [^|\n]{1,64})?$`,
outside fenced code blocks and outside `>` quotes, so quoting or documenting a line never counts. A
comment holding more than one review line counts none of them and is reported as uninterpretable.
Nothing else is required: no purpose, severity, trust score, YAML, or JSON. The reasons stay in the
comment's prose and the reviewer's ordinary inline comments.

A **native GitHub review** also counts, without a line, because GitHub binds it to a commit
(`commit_id`): `APPROVED` reads as `PASS` and `CHANGES_REQUESTED` as `FAIL` for that SHA, with `Found`
unknown. Unknown `Found` stays out of every `Found` denominator (§7.3). A review with both a native
state and a line is one piece of evidence, and the line's `Found` applies to it.

### 2.2 Who the reviewer is, and their position

Identity and position come from GitHub facts, never from text a commenter typed:

| Position | How it is recognised | Example |
|---|---|---|
| `sergeant` | Posted through the control-plane App's ID (`performed_via_github_app`, the same test TECH-6374 uses to minimize its own comments). Its run id joins it to `reviews.jsonl` | Sergeant's fresh-context reviewer, required or audit |
| `human` | A `User` account, no `By:` | A developer's approval or review line |
| `assistant` | A `User` account with a `By:` | An AI assistant run by a person under their own account |
| `bot` | A `Bot` account other than Sergeant's Apps | A third-party review App |
| `author` | The PR author's own account, whatever `By:` says, or the worker App on a Sergeant PR | A developer asking their own assistant to review their own PR; a worker's own subagent review |

`author` evidence is recorded but never counts as independent, so no one can review their own PR
into coverage. The **reviewer identity** in reports is the account login, followed by `By:` when one
is given (`example-dev via Claude Code`). For Sergeant it is `sergeant` and the reviewer's provider,
taken from `reviews.jsonl`.

The **ordinal** is the order in which distinct independent reviewer identities first left evidence
on the PR, at any head: 1st, 2nd, 3rd and later. Reports split by ordinal to answer "how often does
an added reviewer contribute something new?" (§7.3).

### 2.3 Sergeant's own reviewer posts its evidence

When a reviewer run finishes, Sergeant's core posts one PR comment per reviewed PR through the
control-plane App: the line, then the reviewer's summary and its blocking findings. The comment is
keyed `review-evidence:<runId>:<repo>#<n>`, and like the handoff comment it is found again by
reading the PR's comments, so a retry posts nothing new. Verdict mapping: `approve` → `PASS`;
`changes_requested` and `needs_human` → `FAIL`. `Found` comes from the report's new `found` field
(§10.3). A report from before that field existed falls back to `YES` when it has any blocking or
nonblocking finding, and `NO` otherwise. Example:

```
Review: FAIL | Found: YES | SHA: 3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f

Sergeant fresh-context review (run_rev1; a different model provider from the implementer).
Blocking: `retryAfter` is read in seconds but compared as milliseconds (src/sync.ts:88), so a
rate-limited sync retries immediately.
Nonblocking: the new log line repeats the account email; log the account id instead.
```

The reviewer still has no GitHub write access. The core posts on its behalf, so the posting
identity is Sergeant's App and the evidence is joined to the run Sergeant launched. A worker's own
subagent review stays measurement-only (06 §5). If a worker posts it on GitHub, it is `author`
evidence.

### 2.4 Example: evidence on one head from four reviewers

PR `example-org/example-app#412`, head `3f9c2a1b…8e9f` (written out in full in the real lines):

| Posted by (GitHub) | Body starts with | Position, ordinal | Counted as |
|---|---|---|---|
| `example-sergeant[bot]` via the control-plane App | `Review: PASS \| Found: NO \| SHA: 3f9c…8e9f` | `sergeant`, 1st | PASS, nothing new |
| `example-dev` | `Review: PASS \| Found: YES \| SHA: 3f9c…8e9f \| By: Claude Code` | `assistant`, 2nd | PASS, new finding, attributed to Claude Code (unverified) |
| `example-review-app[bot]` | a native `COMMENTED` review, no line | `bot` | coverage only: no verdict, `Found` unknown |
| `example-owner` | a native `APPROVED` review on `3f9c…8e9f` | `human`, 3rd | PASS, `Found` unknown |

## 3. Who else should look

### 3.1 Judgment, recorded where it is used

- **The worker** already recommends per head whether a fresh review is required (05 §5), and if in
  doubt it asks for one. It may add `moreEyes`: one short line naming who could add context and why
  ("a second model provider: the retry math is subtle", "someone who owns the billing integration").
- **Any reviewer** may add `moreEyes` the same way. A human or external reviewer just says so in a
  comment.
- **Reasoning** acts on these suggestions. It can start another reviewer run, which already needs no
  new mechanism: "reasoning may review more than recommended" (06 §3). Its `focus` and the other
  provider (04, Provider by quota) supply the different perspective. A suggestion it does not act
  on before declaring readiness goes into the readiness comment, so the human sees it (§4.2).
- AI reviews are relatively cheap and each reviewer brings a different perspective. So the bar for
  adding one is "would a new reader plausibly see something different?", not a count. The data in
  §7.3 (Found-rate by ordinal, provider and position) is what tunes this guidance over time, in the
  worker and reviewer prompts. No numeric rule is encoded.

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

The designed-but-unbuilt `alwaysReviewPaths` is dropped. Boundary 3 is the built part of it, and
boundary 5 covers the rest where GitHub can enforce it.

## 4. The readiness declaration

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
- Review: PASS, Sergeant reviewer run_rev2 (different provider from the implementer)
- Review: PASS, example-dev via Claude Code
- Required checks: 4 of 4 passed
More eyes (optional): someone who owns the billing integration could confirm the retry ceiling.

This repository's merge policy is `human`, so Sergeant did not approve or merge it. Review is
requested from @example-owner.
```

Grammar of the first line:
`^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})( \| By: [^|\n]{1,64})?$`, and the comment must have
a non-empty `Reason:`. Only a comment Sergeant posted through its App counts as a **Sergeant**
readiness decision. Another agent or a developer may use the same line on their own PRs, and the
report then shows their agreement per declarer. It never counts toward Sergeant's autonomy.

### 4.2 Rules

- **One per head, never overwritten.** It is keyed `readiness:<repo>#<n>:<headSha>`, the same
  once-per-head key the handoff uses today (`merge-handoff:…`), and posted at most once. Sergeant
  never edits or deletes it. When a later head's summary is posted, the earlier copies are minimized
  as outdated (TECH-6374). Minimizing hides them in the UI but keeps them readable through the API,
  so the index still reads them.
- **Posted before any human action on Sergeant's part.** It precedes the approval in a
  `sergeant`-policy repository, the handoff in a `human` one, and the handoff after a policy refusal
  (M12). A human who merges before Sergeant declared anything made no readiness decision to
  evaluate. Readiness is **never reconstructed afterwards** from runs or dispositions.
- **A changed head needs a new assessment.** The old declaration stays as history for the old head
  and says nothing about the new one. Sergeant declares again only when the new head passes the
  preflight again.
- **No withdrawal line.** If a later review on the same head fails, that `Review: FAIL` sits on the
  PR beside the declaration, and the human sees both. The declaration is classified only by what the
  human finally did (§11.3).
- **Existing records, no new store.** The handoff record in `state.json` (`refusedMerges`, H1) and
  the merge record (`merged`) gain the readiness comment's id. Linear's "Ready for a human to merge"
  comment links to it. Nothing else is stored.

## 5. Human agreement

### 5.1 Classes

Each Sergeant readiness declaration *D* (head *H*, posted at time *T*) gets exactly one class. It is
computed from GitHub when queried, never stored as a judgment, so a corrected rule reclassifies
history without migration. Only closed PRs are evaluated.

| Class | When | In the rate? |
|---|---|---|
| **AGREED** | The PR was merged by a human account, and its pre-merge head equals *H* | numerator and denominator |
| **CHANGES_REQUIRED** | The PR closed (merged or not) at a head other than *H*, and between *T* and the next Sergeant declaration on the PR (or the merge or close, if there is none) a human submitted a review, a review comment, or a PR comment, or pushed a commit | denominator |
| **REJECTED** | The PR was closed unmerged at head *H*, and after *T* a human submitted a `CHANGES_REQUESTED` review on commit *H* | denominator |
| **UNKNOWN** | Anything else, with a reason: `pending` (still open), `abandoned` (closed unmerged without the above), `superseded` (the head changed with no human input in the window, as after a rebase), `not_human_merge` (merged by Sergeant or another bot, which includes all of stage 3's own merges), `uninterpretable` (merger unknown, a malformed declaration) | excluded, reported |

**Agreement rate = AGREED / (AGREED + CHANGES_REQUIRED + REJECTED)**, always printed as the fraction,
with the UNKNOWN count and its reasons beside it.

The human's path does not matter, only where it ends. A human who asked for another bot review,
requested changes and then dismissed that request, or let the PR sit for days, and then merged *H*,
**AGREED**. A delayed review of the same head is therefore counted when the merge happens, and the
declaration counts as `pending` until then.

Human input in CHANGES_REQUIRED is **deliberately broad**. Any human review or comment in the window,
followed by a different final head, counts against agreement, even "LGTM, but please rebase". That
biases the rate down, the safe direction for an autonomy threshold. Telling such comments apart
would need semantic judgment in code, which the charter avoids, or a person labelling cases.

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
- **Reviewing identities.** Every piece of evidence on *H* and on any head (§2.2), recorded with the
  declaration's outcome, so a query can ask "agreed after which reviews?".
- **Closer identity.** The timeline's `closed` event actor, for REJECTED and `abandoned`.

### 5.3 Worked examples

| Sequence on one PR | Declarations → class |
|---|---|
| D1 at A. The owner requests another AI review, waits 3 days, approves A, merges | D1 AGREED |
| D1 at A. The owner leaves a CHANGES_REQUESTED review. The worker fixes it as B. D2 at B. The owner approves and merges B (squash) | D1 CHANGES_REQUIRED, D2 AGREED (pre-merge head B, not the squash commit) |
| D1 at A. Main moves, and the worker rebases as B with no human input. D2 at B. A human merges B | D1 UNKNOWN (`superseded`), D2 AGREED |
| D1 at A. A human leaves CHANGES_REQUESTED on A and closes the PR | D1 REJECTED |
| D1 at A. The issue is cancelled, and Sergeant closes its PR (TECH-5230) | D1 UNKNOWN (`abandoned`) |
| D1 at A in a `sergeant`-policy repository. Sergeant merges A | D1 UNKNOWN (`not_human_merge`). Audits measure these (§6) |
| D1 at A. A human pushes a commit C and merges C | D1 CHANGES_REQUIRED |

## 6. Post-merge audit

### 6.1 What is built and reused

`audit.ts` already draws, once per Sergeant merge, `auditDrawn(rate, head)`: a stable SHA-256 hash of
`["audit", repo, number, headSha]` against `review.auditSampleRate` (default 0.2). It applies only to
merged heads no fresh review approved. A drawn head gets a nonblocking reviewer run (`run_audit-<headSha>`)
of exactly that head, and its must-fix findings are kept as follow-up work and told to the issue. 06
§8 still says the draw happens when a `not_required` disposition is recorded, before the merge. The
proposal corrects it to the built behavior (§10.1).

### 6.2 Widened to all merged PRs in enrolled repositories

- **Discovery.** A daily background loop lists, for each enrolled repository, the PRs merged into its
  default branch in the last 72 hours (one paged `pulls?state=closed&base=<default>` read, or a
  search). The overlap tolerates a missed day. A PR merged without a pull request (a direct push, an
  admin bypass) is not discoverable this way (§11.7).
- **The draw.** The same `auditDrawn` hash on the pre-merge head, against a separate
  `review.mergedAuditSampleRate` (proposed default 0.1). A Sergeant head that skipped review is
  still drawn at the 20% rate (§6.1), so the two samples are independent and each answers its own
  question. A PR drawn by both is audited once.
- **Idempotence without state.** The run id stays `run_audit-<headSha>`. The runner's `start` is
  already idempotent on the run id (it does nothing when that run exists), so a restart, a re-scan, or
  both draws picking the same head starts one audit. Losing everything means re-scanning the last 72 hours, which starts nothing new.
- **What is reviewed, as of merge.** The reviewer checks out the pre-merge head, with the merge
  commit's first parent (the default branch as it was when the PR landed) as its base. The brief
  carries the PR title and body, the Linear issue it references (if any; with none, the PR's own
  title and body are the requirements), and every review and comment made **up to the merge time**. Comments made after the merge are left out, so the auditor judges what was known
  then. The audit starts within a day of the merge, so later requirement edits are rare. Its rules
  say to judge against the code and the requirements as of the merge, to report only what was
  actionable then, and never to infer a defect from a later rewrite or rollback.
- **The finding.** `Found: YES` means the auditor found an actionable issue that nobody raised on the
  PR before the merge. `PASS | FAIL` keeps its meaning (would this head have been fit to merge?). The
  audit's evidence comment goes on the merged PR like any Sergeant review (§2.3), labelled
  "post-merge audit (nonblocking)". It is ordinary evidence, so the index and reports pick it up.
- **Surfacing.** For a Sergeant task, as today: one Linear comment with the must-fix findings and the
  follow-up record. For any other PR, the PR comment itself notifies its author and subscribers, and
  `sgt review audits --found` lists every `Found: YES` (§7.2). Humans decide what to do. The audit
  never reverts, reopens, or files anything by itself.
- **Who pays.** Sergeant task audits stay on the task owner's registered accounts (TECH-5179). A PR
  with no Sergeant task has no owner, so the installation configures `review.auditOwner`: the person
  whose registered model accounts run repository-wide audits. A daily cap
  (`review.qualityBudgetUsdPerDay`, already designed in 06 §8) bounds the cost. With no owner
  configured, repository-wide audits do not run.

## 7. Reporting without a dashboard

### 7.1 The evidence index (derived, rebuildable)

A daily job, next to the audit scan, writes one JSON line per **closed** PR of each enrolled
repository to `<state dir>/evidence/<owner>__<repo>.jsonl`. Each line holds: PR number, author and
author kind, created/closed/merged times, pre-merge head, merge commit, merger and merger kind,
closer, every parsed review line and native review (id, kind, account, `By:`, position, ordinal,
verdict, `Found`, SHA, time, edited-after-posting flag), every readiness declaration (id, SHA, time,
reason), the human-input times needed by §5.1, and any audit's run id and result. Open PRs are not
indexed. A PR is indexed once, after it closes, and later edits on GitHub do not rewrite the
history it counted (§11.2).

What if we lose it? It is rebuilt from GitHub by re-scanning a configurable window
(`review.evidenceBackfillDays`, default 180). It is a cache of GitHub facts, not a ledger. Classes and
rates are computed at query time, so changing a rule never needs a migration. The scan uses the
conditional, rate-limited reads every GitHub read already uses (08 §9), at about four requests per
closed PR.

### 7.2 Commands

Following the existing `sgt` patterns (`--since`, `--json`, read-only, Linear-login bearer):

```
sgt review quality   [--since 30d] [--repo <slug>] [--by category|provider|mode|reviewer|position|ordinal]
sgt review readiness [--since 90d] [--repo <slug>] [--declarer sergeant|<login>] [--list]
sgt review audits    [--since 30d] [--repo <slug>] [--found] [--by repo|sergeant|reviewed]
```

`quality` is the designed command from 06 §9, extended with the new splits. `--list` and `--found`
print the PRs behind a number, so every rate links back to GitHub evidence a person can read.
`/v1/review-quality` gains the same parameters, and the MCP client can read them.

Example (`sgt review readiness --repo example-org/example-app --since 90d`):

```
Sergeant readiness, example-org/example-app, last 90 days
  AGREED 41 / evaluated 46 = 89.1%   (CHANGES_REQUIRED 4, REJECTED 1)
  UNKNOWN 9: pending 3, superseded 4, abandoned 2
  Of AGREED: human reviewed the same head first 17, merged with no further review 24
  Post-merge audits of AGREED heads: Found YES 1 / 8
```

### 7.3 Metrics, with numerator and denominator

| Metric | Numerator | Denominator |
|---|---|---|
| Independent coverage, by position | merged PRs with ≥ 1 non-`author` piece of evidence of that position **on the merged head** | merged PRs |
| Any-head coverage, by position | same, at any head | merged PRs |
| Merged with no independent evidence | merged PRs with only `author` or no evidence | merged PRs |
| Who approved | merged PRs with a `PASS` (line or native `APPROVED`) on the merged head, by reviewer identity and position | merged PRs |
| Found rate, by reviewer, position, ordinal or provider | evidence with `Found: YES` | evidence with a known `Found` (lines only) |
| Added-reviewer contribution | evidence at ordinal ≥ 2 with `Found: YES` | evidence at ordinal ≥ 2 with a known `Found` |
| FAIL rate, by reviewer | `FAIL` evidence | evidence with a verdict |
| Readiness agreement, by repository and declarer | AGREED | AGREED + CHANGES_REQUIRED + REJECTED (UNKNOWN printed separately, by reason) |
| Post-merge audit yield | completed audits with `Found: YES` | completed audits, split by: Sergeant-ready and human-merged, Sergeant-merged, non-Sergeant PR, and with or without independent evidence on the merged head |
| Under-review (06 §9, kept) | audited Sergeant skips with ≥ 1 blocking finding that led to a change or was not disputed | audited Sergeant skips |

The 06 §9 metrics stay. No metric gets a target in code. §8's 90% is a threshold for a human to
consider.

## 8. Earned autonomous merge

- **The objective, per repository.** The agreement rate of Sergeant's readiness declarations, at or
  above about **90%** over at least **50 evaluated decisions**, alongside the post-merge audit yield
  on Sergeant-ready heads. Per repository, because stakes and conventions differ. `sgt review
  readiness` prints both. With 50 decisions, 45 AGREED still allows a true rate somewhere in the high
  70s to mid 90s at 95% confidence, so the number invites a decision; it does not make one.
- **The authorization.** A person with operator rights deliberately sets that repository's existing
  `mergePolicy` to `sergeant` (`sgt admin repo …`). Sergeant never changes it, never asks for it
  automatically, and never escalates on a threshold. For a repository whose merge deploys to
  production, this is a deliberate exception to the settled decision in 14 §A, so the captain
  records it there, per repository, with the evidence. It also needs the organization's own
  change-management controls (for example, a requirement that significant changes be reviewed and
  approved before production) to accept independent automated review plus this evidence as the
  approval for that repository. That is a policy decision outside Sergeant (§12).
- **What still holds after it.** Every hard boundary in §3.2: required checks, M15's human review and
  merge for CI changes, any ruleset required-reviewer path (GitHub refuses, and Sergeant hands off,
  M12), M8, M10, M13 and M14. Merges stay gated by D1–D6.
- **Restricting.** Reports keep running after the switch. Agreement can no longer be measured on
  Sergeant's own merges (they are `not_human_merge`), so the post-merge audit yield on Sergeant-merged
  heads, and defects humans report later (`defectReports`), become the signal. A human sets the
  policy back to `human` when those signals warrant it. No automatic demotion is proposed: it would
  add a deterministic rule the charter reserves for preventing material harm, and the hard boundaries
  already do that. An option for the captain at stage 3: keep a small stable-hash sample of heads
  handed to a human anyway (reusing `auditDrawn`), so agreement keeps being measured.

## 9. Staged rollout

**Stage 1 — external evidence and readiness instrumentation.** No merge rule changes.
1. Parse review lines and native reviews (§2). Sergeant's reviewer posts its evidence (§2.3), and the
   reviewer report gains `found` and `moreEyes`.
2. Post the readiness declaration as the first line of the per-head summary, in every policy (§4).
3. Add the evidence index (§7.1), `sgt review quality` with the new splits, and `sgt review readiness`
   (§7.2).
4. Publish the convention for humans and external assistants: a short section in the organization's
   review policy and a PR template line. Developers' assistants are asked to end their reviews with
   the line.
5. Correct 06 §8 to the built after-merge draw. Drop `alwaysReviewPaths` from the design.

Exit: readiness and evidence lines appear on every Sergeant PR, the index rebuilds from GitHub, and
the readiness report matches a hand count on a sample of PRs.

**Stage 2 — expanded post-merge audits.**
1. The repository-wide discovery and draw (§6.2), `review.mergedAuditSampleRate`,
   `review.auditOwner`, and the daily cap.
2. The as-of-merge audit brief, and `sgt review audits`.

Exit: audits cover a random sample of all merged PRs in enrolled repositories, Sergeant's or not, and
every `Found: YES` is visible on its PR and in `sgt review audits --found`.

**Stage 3 — earned autonomous merge, later and per repository.** Once a repository has ≥ 50
evaluated decisions at about 90% agreement and an acceptable audit yield, the captain and the policy
owner decide whether to set `mergePolicy: sergeant` there (§8). No code change is needed for the
switch itself. The only optional code is the shadow handoff sample.

Nothing in any stage is built until this proposal is approved. Implementation issues are written
then.

## 10. Exact proposed changes to existing contracts

These are applied when the proposal is approved, by the issue that implements stage 1. Each owning
section is edited in place, and other documents link to it (rule ownership per `AGENTS.md`).

### 10.1 `06-review.md`

- **§1 Requirements**: add "Review evidence is kept on GitHub, where any reviewer can add it: one
  review line per review (§12). Sergeant indexes evidence it does not own."
- **§3 table**: in the `not_required` row, replace "no `alwaysReviewPaths` touched" with "no protected
  CI configuration touched (08 M15)". Add a row: "a worker, a reviewer, or a human suggests more eyes
  (`moreEyes`) → reasoning starts another reviewer, with a different provider or `focus`, or carries the
  suggestion into the readiness declaration".
- **§6 D4**: replace "and the PR's changed files match none of the repository's
  `alwaysReviewPaths`. Built today: a PR changing protected CI configuration, or whose changed files
  are unknown, never gets it (08 §7, M15)" with "and the PR changes no protected CI configuration and
  its changed files are known (08 §7, M15)".
- **§8**: rename it "Post-merge audits". Replace the `onNotRequiredRecorded` pseudocode and its first
  bullet with the built behavior: "Once per Sergeant merge, a merged head no fresh review approved is
  drawn with `auditDrawn(review.auditSampleRate, head)`." Add the repository-wide draw from
  proposal §6.2 as a second subsection. Keep: nonblocking, the stable hash, after-merge surfacing.
- **New §12 "Review evidence on GitHub"**: the review line, its grammar, native-review reading,
  positions and ordinal, and Sergeant's evidence comment (proposal §2), as the **owning section**
  for the convention.
- **§9**: add the metrics of proposal §7.3 and the splits `reviewer | position | ordinal`. Name the
  evidence index as the source for evidence that is not Sergeant's.
- **§11 Not built**: add "No path tier map, fixed reviewer counts, or sensitivity file list. The few
  hard boundaries are in 08 §2 and M15."

### 10.2 `08-github-contract.md`

- **§2 item 7** (`alwaysReviewPaths`): replace it with "Optionally, a short ruleset required-reviewer
  rule (about ten patterns at most) for changes a human must approve whatever the evidence. GitHub
  enforces it, and Sergeant hands off when GitHub refuses (M12)."
- **§7 handoff**: the PR summary starts with the readiness line (proposal §4), is posted once per
  head before any approval, merge, or handoff call **in every policy**, and is never edited; its
  comment id is kept on the `refusedMerges` and `merged` records. The Linear handoff comment links to
  it.
- **New §12 "Readiness and agreement"**: the readiness line and rules (proposal §4.2), the agreement
  classes and mechanics (proposal §5), as the **owning section**.
- **§10 "A human approves"**: append "It is also review evidence for reporting (06 §12)."
- **§11**: allow, besides the handoff summary and the stop comment, "Sergeant's review evidence
  comments and post-merge audit results on enrolled PRs (06 §12)".

### 10.3 `01-domain-model.md` and `05-brief-report-protocol.md`

- `ReviewFacts`: add `found?: boolean` and `evidenceCommentId?` (per reviewed PR).
- The reviewer report (`s2-review-report`): add `found: boolean` ("you raised at least one actionable
  finding not already raised on these PRs") and `moreEyes?: string`.
- The worker report's `pullRequests[].review`: add `moreEyes?: string`.
- New derived type `EvidenceLine`, the index line of proposal §7.1, marked "derived cache: rebuilt from
  GitHub, never a source of truth".
- The `RefusedMerge` and `merged` records: add `readinessCommentId?`.

### 10.4 `10-installation-config.md` and `11-apis-cli.md`

- Configuration: `review.mergedAuditSampleRate` (0–1, default 0.1 once stage 2 ships, 0 before),
  `review.auditOwner` (a person's id, no default), and `review.evidenceBackfillDays` (default 180).
- Background loops: "evidence index (daily)" and "repository-wide audit draw (daily)".
- CLI and API: the three `sgt review` commands and the `/v1/review-quality` parameters of proposal §7.2.

### 10.5 `14-open-questions.md`

- §A: a note under the production `mergePolicy` decision: "a per-repository exception, decided by the
  captain on the evidence of 08 §12 and 06 §9 (proposal 16 §8), is recorded here".
- §C: a new tension: "agreement is measured only on human merges, so it stops accruing in a repository
  once Sergeant merges there; audits carry the signal after that".

### 10.6 What stays exactly as it is

The Gate's D1–D6 and M1–M15 checks, the fresh-context reviewer and its brief, the 20% skipped-review
draw and its rate key, the two-App identity model, rulesets, the `mergePolicy` default, the worker's
per-head review recommendation, and subagent reviews as measurement only.

## 11. Tradeoffs

### 11.1 Reviewer identity verification

GitHub verifies **accounts**: a `Bot` account is a real App, and a `User` is a real person. It does not
verify what produced a comment's text. So:
- `By:` on a person's account is **attribution only**. It credits the tool in reports. It grants
  nothing, because anyone can type it.
- Sergeant's own evidence is recognised by its App ID (`performed_via_github_app`), never by login
  text or a `By:` value. The same rule already protects comment minimization (TECH-6374).
- **Approval authority does not change.** It still comes only from GitHub rulesets, under whatever
  approvals the repository counts, and Sergeant's dispositions (D2: a reviewer run Sergeant launched
  and can verify in its ledger). A third-party review App's `PASS` is a verified identity with
  unverified quality. Whether such reviews may ever count toward a disposition is a later decision on
  data, like the subagent decision in 06 §5.
- Considered and rejected: signed review attestations or a reviewer registry. They are heavy, and the
  audit sample tests reviewer quality more directly than an identity proof could.

### 11.2 Provenance of external comments

Comments and reviews can be edited or deleted after posting. The SHA binding protects code identity:
a line names exactly what was reviewed. Edits are handled by indexing each PR **once, after it
closes**, from the text and `updated_at` at that time, and flagging lines edited after posting.
Deleted comments are absent from GitHub and from a rebuilt index. That is accepted: the evidence was
withdrawn by its author. Sergeant's own evidence and readiness comments are never edited. Bot text
is never an instruction (06 §4, TECH-6166), and a review line is parsed only for these four fields.

### 11.3 Readiness invalidation

A declaration is bound to one head and is simply history once the head changes. That makes "is it
still valid?" a question with no state to keep. The cost: no withdrawal on the same head. If a later
reviewer finds a problem in head *H* after the declaration, the human sees the `FAIL` line next to it.
A human merge of *H* is still AGREED, because the human weighed both. A withdrawal line was considered
and dropped. It would add a third state per head and a reconciliation rule for "withdrawn, then
merged". If the data shows humans merging past later `FAIL`s, it can be added. A change to the
issue's requirements after the declaration is caught by M10 and M13 before any Sergeant merge. In
`human` repositories it is the human's call, and the later review evidence shows it.

### 11.4 Human agreement reconciliation

The rules are structural (who merged which head, and whether a human spoke up first) and computed
from GitHub at query time, so they are reproducible by anyone with read access. Accepted biases, both
downward: any human comment followed by a new head counts as CHANGES_REQUIRED, and a human pushing a
fix counts too, even if Sergeant would have made the same fix. Accepted gaps: decisions on PRs that
are still open are `pending`, so a slow-reviewing repository accrues slowly. A merge by a merge-queue
bot with no human enqueuer is `uninterpretable`.

### 11.5 External-review accounting

Native GitHub reviews count without a line, so human reviewers need to change nothing. They give a
verdict but no `Found`, so `Found` rates come only from lines. That makes them a smaller but honest
sample. Review Apps that cannot be configured to emit the line count only as coverage. Author-side
evidence is kept but never independent. A developer's own assistant reviewing their own PR is
useful, and visible in reports, but is not a second pair of eyes. `Found` is self-reported. The
reviewer's brief already lists everything raised before (06 §2), which makes "not already raised"
checkable, and audits spot-check it.

### 11.6 Samples and denominators

Every rate is printed as a fraction. UNKNOWN is excluded but always shown with its reasons, so a
large UNKNOWN share is visible instead of silently inflating the rate. 50 evaluated decisions per
repository is a minimum for a human to look, not proof (§8). Rates are reported over a window
(`--since`), so a prompt or reviewer-rule change can be judged by comparing windows. No rate resets
automatically. The audit sample rates trade cost against how fast the audit yield becomes
meaningful. At 10% of merged PRs, a repository merging 100 PRs a month yields about 10 audits a
month.

### 11.7 Repository-wide post-merge audit discovery

Only enrolled repositories can be audited, because Sergeant's Apps and read token reach only those.
Discovery reads merged PRs, so a change that reached the default branch without a PR (an admin bypass,
a direct push) is invisible to it. Rulesets should make that rare, and an organization's break-glass
process covers it separately. Running audits on PRs nobody delegated to Sergeant spends someone's
model accounts, hence `review.auditOwner` and the daily cap. Results are posted on the PR itself, so a
public repository's audit findings are public. That is the same visibility as the code and its
review.

### 11.8 Deterministic GitHub protection vs AI judgment

A path tier map makes judgment deterministic but brittle. The tier-map PR this replaces needed several
revision passes over hundreds of patterns and still listed paths that need a manual raise. It also
fixes reviewer counts that no data supports. This proposal keeps determinism only where an error is
material and a rule can be stated simply: required checks, required approval, protected CI, the
`mergePolicy` switch, and a handful of ruleset paths GitHub enforces. Everything else is judgment,
measured by evidence. The cost is that a misjudged skip or a thin review can happen. The 06 §1
review-need policy already accepts that cost, and audits measure it in both directions. The benefit is
one mechanism that covers Sergeant's PRs and everyone else's, and data to tune it.

## 12. What this supersedes or redirects

This PR changes none of the following. It recommends:

- **TECH-6510 (adopt the code review policy)** — redirect. The organization's draft policy defines
  five path tiers (T0–T4) with fixed review counts and human approvals per tier. Recommend adopting
  this evidence-based model instead: keep the draft's human authorization, required CI, break-glass
  and auditor-evidence sections and its compliance mapping, and replace the tiers, "classifying a
  change", the per-repository map and the tier gating with the review line, readiness, agreement,
  audits, and §3.2's short list of hard boundaries. The compliance wording ("significant changes are
  reviewed and approved") then maps to: human authorization (a person delegated or authored the
  change), independent evidence on the merged head, required CI, a human merge wherever
  `mergePolicy` is `human`, and the post-merge audit as retrospective review. Most of the draft's open
  questions (which tier for unmapped paths, two-vendor bot reviews, the monthly human sample size)
  disappear. The approving team's identity and break-glass remain.
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
5. Where the organization's review policy page links to this design once it is adopted.

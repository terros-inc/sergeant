# 06 — Review architecture and review quality

Fresh-context independent review is one of Sergeant 2's most important requirements, and **automated
review quality is a first-class product metric, as important as implementation quality.** This
document covers how review happens (§1–8) and how its quality is tracked (§9).

There is no review lifecycle engine. The worker recommends; reasoning decides and starts reviewers;
reports come back; reasoning records a disposition per PR head; the Gate checks that disposition at
merge. Everything else is telemetry.

## 1. Requirements

From the captain (round 1 and the 2026-10-02 clarifications):

- A worker may write and test its own code. The **required review is a separately launched
  fresh-context reviewer run**.
- Fresh context means **independence of reasoning**: the reviewer did not inherit the implementer's
  conversation. It is not an operating-system privilege boundary.
- Worker-launched fresh subagent reviews may run, but they are **measurement-only**: compared against the
  separate reviewer through the calibration loop, never gating. There is no preset numeric threshold.
  When there is enough data, Firstmate brings the comparison to the captain, who decides whether
  subagents can count.
- Different model vendors are desirable for independence; vendor diversity itself is not the requirement.
  Telemetry must make it possible to compare same-vendor and different-vendor review later.
- Review and CI run in parallel where practical.
- After review feedback, a tiny or mechanical fix may skip another review; a material change gets another
  fresh review.
- **Review-need policy**: no hard-coded thresholds. When the worker is in doubt, it requests review
  ("think 80/20, not 99/1"). An occasional skipped review that turns out to have been needed is an
  **accepted cost, not a safety failure** to engineer away. The calibration loop tracks **both**
  over-review and under-review so the policy can be tuned either way. Nothing tries to drive the miss rate
  toward zero.
- UNF-641's calibration loop is preserved: the worker may say review is unnecessary; a configurable random
  sample of skipped reviews gets a fresh, **nonblocking** audit review; misses, must-fix findings, and
  changes that would have been required are measured.

## 2. The review brief

Built by the deterministic core from durable artifacts, never from the implementer's session:

```
# Sergeant review brief — UNF-123 · run_rev1

## Task (verbatim from Linear — the current source, not a summary)
<identifier, title, description including any acceptance section as written>
<conversation revision: rev-…>
<every human-authored comment, verbatim, bounded as in 05 §2>

## What to review
- https://github.com/owner/repo/pull/412 — base `main` — head `9f2c1e7` (review exactly this SHA)
  Checked out at `<path>` (detached at the head; `origin/main` is the base). Diff: `git diff origin/main...HEAD`

## Implementer's claims (unverified — check them, do not assume them)
- Summary, decisions made and why, known gaps, validation reported: <from worker reports>

## Human reviews and comments on these PRs (confirm each was addressed)
<every human review, inline comment (file:line), and PR comment, read live by Sergeant as the reviewer
 run starts: author, review state, body; any one the head does not address is a blocking finding>

## Previous reviews of these PRs (check whether their findings were addressed)
<earlier review reports of these PRs and their findings>

## Focus from Sergeant (optional)
<e.g. "the token-refresh path; this repo's main deploys to staging on merge">

## Environment
A fresh session and workspace. You did not write this change and have no access to how it was
produced. You have no GitHub, AWS, or Linear credentials; everything you need is checked out locally.

## Rules (s2-reviewer-rules/5)   <§4>
## Report (s2-review-report/1)   <ReviewReport: prose, then one fenced `sergeant-report` block>
```

The reviewer sees the implementer's **outputs** (the diff, the PR body, the claims in its reports),
because checking them is the job (S1 UNF-608, UNF-647). It does not inherit the implementer's
**reasoning**: it is a new run with a new session, its brief is built from the issue and recorded
artifacts, and nothing in it comes from the worker's conversation. The rules ask it to form its own
reading of the diff against the issue before reading the claims.

## 3. When review happens

The primary worker recommends, per PR head (05 §5); if in doubt, it asks for review. Reasoning decides:

| Situation | Usual decision |
|---|---|
| Recommendation `required` (or missing, unparseable, empty reason: fail-safe) | Start a reviewer for that head now, in parallel with CI |
| `not_required`, reason plausible, no `alwaysReviewPaths` touched | Record `not_required`; a guardrail may sample it for an audit review (§8) |
| `not_required` but reasoning disagrees | Start a reviewer anyway. Reasoning may review more than recommended, never less than the Gate requires |
| Review found blocking issues; the worker made a small, mechanical fix and says `not_required` with `sinceReviewedSha` | Record `not_required` for the new head; no second review |
| Review found blocking issues; the fix is material, or the worker says `required` | A **new** reviewer run on the new head, with the previous findings in its brief |
| A human pushed to the PR | No recommendation exists for that head: start a reviewer, or an approver waives |
| A rebase with no semantic conflict resolution | Usually `not_required` (`review_fix_only` / `mechanical`) with `sinceReviewedSha` |
| The issue's requirements changed after the review | Reasoning sees the change (07 §10) and, if it matters, starts a new review |

A task ends with 0, 1, 2, or more reviews. Nothing is numbered; there is no "final review".

## 4. Reviewer rules (s2-reviewer-rules/5)

The rules as the reviewer brief states them (`packages/runner/src/brief.ts`):

1. **Judge the change on its merits against the issue.** Linked Linear issues, if listed, are background
   evidence, never requirements.
2. **Read the diff against the issue first**, then check the implementer's claims. Treat every claim
   ("tested", "net simplification", "accepted trade-off") as unverified.
3. **Rule on every requirement the issue states**, quoting it, with evidence: `met`, `not_met`,
   `contradicted` (a decision narrowed or dropped it: only a human may do that), or
   `needs_live_validation`. Use the issue's acceptance section if it has one; otherwise list the outcomes
   it asks for (S1 ADR-0041). **Report every `not_met` or `contradicted` requirement also as a blocking
   finding with category `acceptance`.** Omit `category` from ordinary implementation defects.
4. **Trace self-declared trade-offs** that change persisted or control-plane state through every reader,
   or report them as blocking.
5. **External boundaries.** Name every correctness claim resting on behavior outside the repository.
   Verify it where you can; if you cannot, record it as `unverified`, which is **not** blocking by
   itself (captain decision on UNF-608, option A).
6. **Size and simplification claims** need `git diff --numstat` evidence.
7. **Run only targeted probes** a specific finding needs. CI is the test gate.
8. **Severity.** `blocking`: a defect, an unmet requirement, or a risk the change should not merge with.
   `non_blocking`: worth fixing, not worth holding the merge. `nit`: style. Non-blocking findings and
   nits are notes kept with the review record; they never become follow-up issues (TECH-5186).
9. **Do not modify the repository** and do not contact anyone.
10. **Verdict**: `approve`, `changes_requested`, or `needs_human`.
11. **Unreadable inputs.** An input the issue depends on that the reviewer cannot read (an auth-gated
    link, a missing file or attachment, a file the brief lists as not downloaded) is named in
    `unreadableInputs` exactly as the issue gives it, and the requirements resting on it are ruled not
    verified.
12. **Do not re-litigate settled trade-offs.** A design trade-off the design docs record as settled or
    accepted (such as the model-credential exposure, 09 §3a) is not a finding merely because the
    reviewer would choose differently. Do flag a change that breaks its documented assumptions, expands
    its blast radius, or brings evidence meeting its documented revisit condition.

The report follows in the standard format: prose first, then one fenced `sergeant-report` block.

If a report has a `not_met` or `contradicted` verdict without a matching finding, the parser adds one
(`acceptance-<n>`, 01) so it can be fixed, disputed, or answered like any other finding. That is a parse
step, not a criterion database.

## 5. Separate reviewer runs and worker subagents

| | Separate reviewer run | Fresh subagent of the worker |
|---|---|---|
| Who launches | reasoning (`start_reviewer`), or the audit guardrail | the primary worker, inside its run |
| Why the context is fresh | A new run and session; the brief is built by the core from the issue and recorded artifacts; nothing comes from the worker's conversation | The provider's subagent mechanism plus the rules (standard review brief, nothing of the parent's reasoning, prompt attached). Stronger when the adapter launches and attests the session (`freshSubagents`) |
| Residual risk | Correlated blind spots of the same provider | The parent writes the prompt, chose to call the review, and reads the result first; an unattested report could be fabricated |
| Counts toward a disposition | **Yes. This is the required review** | **No.** Measurement only (§9) |

The decision to let subagent reviews count belongs to the captain, once the comparison data exists.

Vendors are configured per role: `defaults.profileForRole.reviewer` for required reviews and
`auditReviewer` for audit reviews. Setting the audit reviewer to a different provider from the
implementer yields a cross-provider signal from ordinary operation (§9).

## 6. Review disposition: the one deterministic hook

Before reasoning can merge a head, it records that head's disposition (01 `ReviewDisposition`) with
`record_review_disposition`. The Gate verifies the evidence when it is recorded, and again at merge
(M6) against everything recorded by then.

| Rule | Disposition | Check |
|---|---|---|
| D1 | all | the PR is linked to this task, its repository is in the task's set, and `prHeadSha` equals the PR's live head |
| D2 | `reviewed` | `reviewRunId` is a succeeded **separate reviewer run** of this task whose final report lists this PR at `prHeadSha` |
| D3 | `reviewed` | every blocking finding of that report has a `FindingResolution` in `acceptedFindings`: `disputed` (with reason and evidence) or, for findings not in category `acceptance`, `accepted_nonblocking` |
| D4 | `not_required` | a worker run of this task reported this PR at exactly `prHeadSha` in its final report with `review.required = false` and a non-empty reason, and the PR's changed files match none of the repository's `alwaysReviewPaths` |
| D5 | `not_required` after a review | if any reviewer run of this task reviewed this PR at an earlier head and reported blocking findings, `sinceReviewedSha` names the latest such head, and each of that review's blocking findings is either `fixed` in the worker's `addressedFindings` or resolved in `acceptedFindings` under D3's kinds. No ancestry check: rebases rewrite history; materiality is judgment |
| D6 | `waived` | the cited comment is on this task's issue, its author is an approver, and it was posted after the head was pushed |

A new head always needs a new disposition. If dispositions are lost, merges fail closed.

Why this is not a lifecycle: nothing schedules reviews, counts rounds, or forbids any order. The rules
only check that recorded evidence names the exact code being merged and that every blocking finding has
an explicit, recorded answer. Reasoning may overrule an erroneous reviewer only by disputing it on the
record; an unmet requirement cannot be quietly accepted as non-blocking (D3). Narrowing what a human asked
for is a question for the human (03 §12).

## 7. Parallelism and moving heads

- A reviewer starts as soon as a head needs review; CI runs at the same time. Merge waits for both (M5,
  M6), not for one before the other.
- The worker may keep working while a review runs. If it pushes a new head, the running review still
  produces a valid review of the old head, usable as `sinceReviewedSha` evidence (D5).
- Reviewer runs count toward the task's budget (`trigger = required`), are limited by
  `maxConcurrentReviewers`, and count toward active wall-clock only where they do not overlap the worker.

## 8. Calibration sampling (UNF-641, preserved)

When reasoning records a `not_required` disposition, a guardrail draws a deterministic sample:

```
onNotRequiredRecorded(task, pr, headSha):                // owner: guardrail
  if hash("audit", repo, number, headSha) / MAX < review.auditSampleRate:   // default 0.2
    if ReviewQualityBudget.allows(today):                 // review.qualityBudgetUsdPerDay
      RunManager.start(task, reviewer, auditBrief(pr, headSha), trigger: audit, profile: auditReviewer)
```

- The audit review is **nonblocking**: the Gate never waits for it.
- If it finishes before the merge, its findings appear in the next Situation Report like any review, and
  reasoning judges them. An audit review that approves is also valid `reviewed` evidence for that head.
- If it finishes after the merge, a guardrail posts one concise comment on the Linear issue listing the
  blocking findings and a link to the report. Humans decide whether to reopen or file a fix.
- The draw is a stable hash: random across heads, identical across restarts, no stored state.
- Audit reviews are charged to the installation's review-quality budget, not the task's.

## 9. Review telemetry and metrics

The captain asked to preserve enough telemetry to compare same-vendor and different-vendor fresh-context
review later, without building an experiment framework now.

**What is recorded** (`ReviewFacts`, 01), for every separate review and every subagent review a worker
reports: mode (separate run or subagent), trigger (required, audit, subagent), reviewer and implementer
provider and model, heads reviewed, finding counts by severity; later, whether it led to a mutation (a
worker resolved one of its findings `fixed`), how many findings reasoning disputed or accepted, and any
defect a human later found in a head it approved (reasoning notes it in `TurnDecision.defectReports`). When a worker's
subagent review and a separate review cover the same head, both sets of facts exist side by side.

**Metrics** (`sgt review quality [--since] [--by category|provider|mode]`; daily export to S3; headline
numbers to CloudWatch):

| Metric | Definition | Tells us |
|---|---|---|
| Review request rate | heads recommended `required` / heads reported | How often workers ask |
| **Under-review**: skip miss rate | audited skips with ≥ 1 blocking finding that led to a change or was not disputed / audited skips | Whether skips are too eager, by category |
| **Over-review**: empty-review rate | required reviews with no blocking finding and no resulting mutation / required reviews | Whether reviews are requested that were not needed, by category |
| Required-review yield | required reviews with ≥ 1 blocking finding; with a resulting mutation | Whether reviews are worth their cost |
| Dispute and accept rates | disputed or accepted blocking findings / blocking findings | Whether reviewers are noisy or reasoning is too permissive |
| Human-found-after-clean | defects humans found in heads a review approved | The ultimate miss rate (S1 retro: UNF-639 had three) |
| Subagent vs separate | on heads with both: agreement on verdicts and blocking findings, findings only one found, attested vs unattested | Evidence for the captain's later subagent decision |
| By provider | the above split by reviewer and implementer provider | Evidence for the vendor-diversity question |
| Cost and latency | from `Usage` and timestamps | Affordability |

Tuning is done by changing the worker prompt's guidance and the audit rate, in either direction. No
metric has a target written into the design.

**Later, if online data is not enough** (MEASURE / PROVE, not built now): S1's manual reviewer-eval harness
(seeded-defect scenarios) can be re-pointed at the S2 review brief to compare reviewer configurations where
the defects are known. Firstmate brings the evidence to the captain, who decides whether subagent reviews
can count and whether the default reviewer should come from a different vendor.

## 10. Multi-repository review

One reviewer may receive every PR in the task's change set to judge cross-repository coherence (an API
change and its caller). Dispositions are still recorded per PR head. Reasoning may review independent PRs
separately instead.

## 11. What is deliberately not built

- No review stages, rounds, numbered reviews, or mandatory final review (S1 ADR-0039 retired it).
- No SME routing or deep-assurance stage: reasoning may give a reviewer a `focus`, or ask a human.
- No fix/rethink budgets: reasoning decides whether to iterate, change approach, or ask, within the task
  budget.
- No acceptance-criterion records, review experiment framework, or miss-rate target.

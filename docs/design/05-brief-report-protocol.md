# 05 — Worker brief and report protocol

Firstmate works because each worker gets a **brief** and returns a **report**. The brief separates
what the human asked for from Firstmate's own instructions, states hard rules once, and says
exactly what "done" means. The report stands alone, names every PR by full URL, and states gaps and
open questions plainly. Sergeant 2 adopts the same protocol for its primary worker and reviewers.

Type shapes are in `01` (`WorkerBrief`, `WorkerReport`, `ReviewRecommendation`, `SubagentReview`).
This document defines how they are rendered, what each part means, and how reports are parsed. The
review variants are in `06`.

## 1. What carries over from Firstmate, and what changes

| Firstmate | Sergeant 2 |
|---|---|
| `## Captain's intent` — the captain's own words, treated as acceptance criteria | **Task** — the Linear issue verbatim (title, description, acceptance section, every human-authored comment). Never paraphrased or filtered |
| `## Firstmate spec` — build instructions, never mistaken for intent | **Objective** — Sergeant's instruction for this run |
| Setup + Rules — a safety contract, not a suggestion | **Environment** + **Rules** — the repository set, access, what is unavailable, and the standard versioned rules |
| Status lines: `working`, `needs-decision`, `blocked`, `paused`, `done`, `failed`; sparse, only what Firstmate would act on | **Progress notes**: sparse; `attention` notes wake Sergeant |
| Steering inbox: durable messages, acknowledged | `send_run` messages with ids, acknowledged in the report |
| `report.md` stands alone: what was done, evidence, recommendations, full PR URLs | **Report** — the same, plus one fenced machine-readable block |
| `needs-decision` stops and waits for Firstmate | `outcome: needs_decision` with structured questions; Sergeant asks the human |
| No-mistakes / delivery path owns review | The worker decides whether its delta needs fresh review; Sergeant arranges it |

## 2. The brief

Sergeant renders the brief as Markdown, in this order. The structured header (01 `WorkerBrief`) is
stored beside it so it can be replayed.

```
# Sergeant worker brief — UNF-123 · run_abc

## Task (verbatim from Linear — this is what was asked)
<identifier, URL, title>
<description, verbatim>
<any acceptance section, exactly as written in the issue>
<conversation revision: rev-…>
<every human-authored comment, verbatim, with author and time, oldest first>
<if the thread exceeds the inline bound: one pointer line per omitted older comment, and
 "the complete thread is in sergeant-thread.md beside this brief">

## Objective for this run (from Sergeant)
<what to achieve in this run, what "done" means for it, what is out of scope>

## Context
- Prior runs: <run, outcome, summary, known gaps, handoff: branches and notes>
- Pull requests: <full URL, head SHA, CI state, mergeability, review disposition>
- Review findings to address: <finding id, severity, category ("acceptance" for an unmet requirement), location, description>
- Human decisions already made: <question → answer, with comment link>
- Notes from Sergeant: <anything else>

## Environment
- Repositories you may use (read and write): <slug — purpose — merge policy>
- Other enrolled repositories (names only; ask if you need one): <slug — purpose>
- Existing work: branches on origin naming the issue's identifier exactly; PRs Linear links to the issue (§3)
- Access: GitHub write via the credential helper; AWS dev/stage via the `sergeant-dev` profile; tools: <names>
- Not available, by design: production, IAM/org/billing, Linear, Sergeant's control plane

## Limits
- Wall time <N> min · cost about $<N> · deadline <time>. When told to wrap up, push and report within 10 minutes.

## Rules (s2-worker-rules/<n>)
<the standard rules, §3>

## Review
<review policy: decide per PR head; review tiers (06 §6a): only a T0 head skips review, and the worker may raise a tier; a subagent review you run yourself is extra evidence, never the required review>

## Report
<the report contract, §4, and where to write it>
```

**Who writes what.** The Task section is the current Linear issue and **all** of its human-authored
comments, copied verbatim by the deterministic core, never by reasoning, so it cannot be narrowed or
reworded (the S1 lesson behind ADR-0041: a plan must not narrow acceptance). A comment can add or change a
requirement, so none is selected by relevance; the rule is objective: every comment whose author is a
human (not Sergeant, a bot, or an integration) is included. Reasoning writes the Objective and chooses the
Context beside it, never in place of it. If the issue or its comments change while the run is going,
reasoning sends the new text (07 §10); a reviewer started later gets the whole current thread anyway, so
a requirement added mid-run is still checked.

**Very long threads.** Comments are inline up to a fixed size bound (48 KB), newest kept
inline. Every older comment gets a pointer line (id, author, time, first line), and
the complete thread is delivered beside the brief as `sergeant-thread.md` (01 `RunSpec.brief.fullThread`).
The bound depends only on size, never on content, so nothing acceptance-bearing can be dropped.
This bound is not built yet: the Task section is still inline in full.

**Human PR feedback** (the reviews, inline comments, and PR comments a successor worker or a reviewer
must check, TECH-4987/4990) has its own bound of 48 KB (49,152 characters) across all of a brief's
PRs, built in TECH-5022. Under it every item is whole. Over it the newest items stay whole, the next
older one keeps as much of its body as fits, and every older one keeps its header (author, kind and
review state, time, link) and the start of its first line. A cut item says how many characters were
cut and links to its full text on GitHub; there is no `sergeant-thread.md` for PR feedback. Headers
are never dropped, so a PR with hundreds of items can still exceed the bound.

Environment, Limits, Rules, Review, and Report are rendered from configuration and the ledger.

**Objective, not a step list.** "Make `sgt task show UNF-404` resolve by identifier, including
issues created before identifiers were cached" is an objective. "Edit `task.rs` line 40" is not.
The worker plans.

**Successor briefs.** When a worker is replaced (lost, budget wrap-up, a material redirection), the
successor's Context carries the predecessor's report summary, known gaps, and `handoff`, and the
open PRs with their branches. The successor starts from what was pushed.

**Earlier runs** (a worker brief's record of every earlier run on the task, TECH-6462) have their own
bound of 16 KB (16,384 characters) on the reports carried whole. Under it every report is whole. The
newest worker report and the newest review are always whole, whatever their order and size, so the
newest blocking findings always reach the successor; other reports stay whole, newest first, while
they fit, and every run left out keeps one heading line (run id, role, status, and its outcome or
verdict) outside the bound. On Fargate the brief travels gzipped in the run's 64 KiB secret, beside its
credentials ([`packages/runner/README.md`](../../packages/runner/README.md#fargate-fargaterunner-tech-5237)); a brief that
still does not fit fails the start, before anything is created, with its size.

## 3. Standard worker rules

Versioned text rendered into every worker brief. A change is a new version (`WORKER_RULES_VERSION`),
recorded on the run. The rules themselves live only in the brief's code,
[`packages/runner/src/brief-worker.ts`](../../packages/runner/src/brief-worker.ts), with the cases
behind each in `brief.test.ts`; this package does not restate them.

## 4. The report

A Markdown document readable by a human, ending with exactly one fenced `sergeant-report` block
of JSON matching `WorkerReport` (01). Prose first, structure last, as in Firstmate's reports.

````
# UNF-123 — worker report (run_abc)

**Outcome: completed.** `sgt task show` now resolves Linear identifiers, including issues admitted
before identifiers were cached, by looking them up through Linear on a cache miss.

## Pull requests
- https://github.com/owner/sergeant/pull/412 — head `9f2c1e7` — CI green — closes UNF-123
  Review: **required** (behavior change to a CLI contract; touches the daemon's task lookup).

## Acceptance
- "`sgt task show UNF-404` works" — met: `cargo test -p sergeant-cli task_show_by_identifier`
  passes; a pre-cache issue resolves (test `resolves_uncached_identifier`).

## Validation
- Targeted tests: passed (3 new, 41 existing in the crate). Full suite: left to CI (green).

## Known gaps
- None that block. The lookup adds one Linear call on a cache miss.

## Decisions
- Look up on a cache miss rather than backfilling every task: no migration, same behavior.

```sergeant-report
{ "reportVersion": "s2-worker-report/1", "runId": "run_abc", "outcome": "completed",
  "summary": "...",
  "pullRequests": [{ "repo": "owner/sergeant", "number": 412, "url": "https://github.com/owner/sergeant/pull/412",
                     "branch": "sergeant/UNF-123-identifier-lookup", "headSha": "9f2c1e7…",
                     "change": "opened", "closesIssue": true,
                     "review": { "required": true, "reason": "Behavior change to a CLI contract.",
                                 "categories": ["behavior_change", "api_contract"] } }],
  "acceptance": [{ "criterion": "`sgt task show UNF-404` works", "status": "met", "evidence": "..." }],
  "validation": [...], "knownGaps": [], "decisionsMade": [...],
  "addressedFindings": [], "questions": [], "repositoryRequests": [], "dependencies": [], "followups": [], "feedback": [],
  "subagentReviews": [], "handoff": { "branches": [...], "wipPushed": true, "notes": "" },
  "acknowledgedMessages": [] }
```
````

### How each kind of result is reported

| Situation | How |
|---|---|
| PRs opened or updated | `pullRequests[]` with full URL, branch, exact head SHA, `change`, whether it closes the issue, merge order if it matters, and a `review` recommendation per PR head |
| Incomplete work | `outcome: partial`; `acceptance[]` items (criterion quoted from the issue) `partial`/`not_met`; `knownGaps`; `handoff` with pushed branches |
| Blocked by something outside the worker's authority | `outcome: blocked`; `validation[]` or `knownGaps` naming the boundary; never a request for broader credentials |
| Needs human judgment | `outcome: needs_decision`; `questions[]` with `whyHumanNeeded`, options, recommendation, `blocking` |
| Known gaps | `knownGaps[]`, short and specific; trade-offs in `decisionsMade[]` (reviewers check both, 06) |
| Review need | `pullRequests[].review`, per head (§5) |
| Review findings handled | `addressedFindings[]` (`FindingResolution`, 01): `fixed`, or `disputed` with a reason and evidence, by finding id. Reasoning, not the worker, decides whether an unfixed finding may be accepted |
| Needs another repository | `repositoryRequests[]` |
| A dependency on another issue, or of another issue on this one | `dependencies[]`, each with the issue, `blocked_by` or `blocks`, and `why`; reasoning records it (`record_blocked_by`) |
| A real bug, required unfinished work, a blocker, or an ops/security problem | `followups[]`, each with `category` and `why`; Sergeant decides |
| CI on the PR's current head failed for a reason unrelated to the change (a flaky test) | `rerunFailedCI[]`, each with `repo`, PR `number`, and the failed `workflowRunId`, never an empty commit. Sergeant checks and performs each once after the run ends (08 §6) |
| What made the task harder, what could be better, whether it recurs | `feedback[]` and a short Feedback section; never filed; may become the issue's Sergeant feedback comment (07 §11) |
| Failed outright | `outcome: failed` with what happened; still a report if at all possible |

## 5. Review recommendation

At the end of its work (and whenever it reports a head it considers ready), the worker judges the
change it actually made, per PR head:

- scope and behavioral impact; architecture, data model, auth/security, concurrency, or API
  contract impact; its own uncertainty;
- for a change after a review: the review's findings and the size and materiality of the delta
  since the reviewed SHA (`sinceReviewedSha`).

`categories` is an open vocabulary with suggested values: `behavior_change`, `architecture`,
`data_model`, `security`, `concurrency`, `api_contract`, `external_boundary`, `uncertainty`,
`large_change` (reasons to review) and `mechanical`, `docs_or_tests_only`, `review_fix_only`
(reasons a skip is safe). Unknown strings are kept as written.

**If in doubt, request review**, under the review-need policy in 06 §1: the worker says
`required: true` whenever it is unsure, and skips only when it is confident.

**Fail toward review** mechanically: a missing recommendation, one that does not parse, or
`required: false` with an empty `reason` is read as `required: true`. A skip stands only for a T0 head
(06 §6a, D4); a worker or reviewer may raise a PR's tier with `raiseTier`, never lower it.

## 6. Parsing and validation

```
parseReport(run, markdown) -> { parsed: WorkerReport | null, error? }     // owner: RunManager
  blocks = fenced blocks tagged `sergeant-report`
  if count(blocks) != 1: return { parsed: null, error: "expected one sergeant-report block" }
  json = parse(blocks[0]); if invalid: return { parsed: null, error }
  if json.reportVersion unknown: return { parsed: null, error: "unknown version" }
  r = coerce(json, WorkerReport)          // Zod schema parse; unknown fields ignored; missing optional fields defaulted
  r.outcome      = r.outcome ?? partial
  for pr in r.pullRequests:
    pr.review    = validRecommendation(pr.review) ? pr.review : { required: true, reason: "fail-safe" }
  drop addressedFindings entries whose resolution is not fixed | disputed
  return { parsed: r }

// A run may submit its report several times while running; each is a new revision (04 §5).
// The revision current when the run becomes terminal is final; recommendations are read from it.

afterReport(run, r)                        // guardrails, then wake Sergeant
  for pr in r.pullRequests:
    facts = GitHub.pr(pr.repo, pr.number)
    if pr.repo in task.repositories and facts.author == workerApp and not linked:
      perform link_pr (actor: guardrail)   // 08 §4
    if facts.headSha != pr.headSha: note "head moved since report" in the Situation Report
  append WakeReason(run_changed)
```

- A report without a parseable block is still stored and shown to Sergeant as prose. Its PR heads
  have no recommendation, so they fail toward review.
- The report's claims (CI green, tests passed) are claims. Sergeant and the Gate check CI and PR
  state from GitHub, never from the report.
- A recommendation applies only to the SHA it names. If the head moved after the report (the worker
  pushed again, or a human did), that new head has no recommendation until another report covers it.
- A review report is read forgivingly where its meaning is unambiguous (TECH-5259): a spelling of a
  verdict or severity (`Approve`, `non-blocking`), a PR number as a string, a missing report version,
  summary, or finding id. Never toward a merge: an unknown severity reads as `blocking`, and an
  unknown verdict or a missing reviewed head still rejects the report.
- A run that ends with no usable report (none written, or one that does not parse) gets one retry at
  once, before the next reasoning turn (TECH-5259): a reviewer on the same heads, a worker on its
  objective with an instruction to finish and write its report, each told why. The retry goes through
  the Gate like any start, and one that also ends without a report is left to reasoning. So is the run
  itself while a human has said something no turn has read (a reply to the budget question, a comment,
  an issue edit, a PR review): the reasoning turn reads it first and decides. So is a run that failed on
  its account's quota, since waiting for the reset may be the better call. A run that failed
  authentication (TECH-6357) is retried even when it was itself a retry: the runner sets each failed
  account aside (04 §10), so every retry runs on another of the owner's usable accounts, and once none
  is left the start asks the owner to register or fix one. Each such run
  is one line in the task's `report-recoveries.jsonl` (`missing` or `malformed`, and what followed).

## 7. Progress notes and messages

**Progress notes** are optional and sparse, like Firstmate's status lines: a one-line note when the
worker changes direction or hits something Sergeant might act on. Transport: the adapter's status
(`RunStatus.progress`) or `POST /runner/v1/runs/:id/progress`. A note flagged `attention` (for example
"blocked: no access to repo X", "needs-decision: …") wakes Sergeant; others are shown in the next
Situation Report and in `sgt task show`. They never go to Linear.

**Messages** from Sergeant (`send_run`) have ids. The adapter delivers them at least once. The
worker acts on them and lists their ids in `acknowledgedMessages`. A message Sergeant sent that the
final report does not acknowledge is shown to Sergeant as unacknowledged.

## 8. What a worker never receives

The control plane's credentials; Linear access; other tasks' briefs; Sergeant's reasoning session;
production credentials; any human's personal credentials, except the model subscription a person
registered when the run works on it (09 §3a). What a worker needs from Linear arrives
verbatim in the brief, or in a message.

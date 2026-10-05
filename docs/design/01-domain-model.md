# 01 — Domain model

This document is the **only place type shapes are defined**. Other documents give the semantics,
rules, and examples for these types and refer back here. Notation is pseudocode: `?` means
optional, `|` means one of, `T[]` is a list, `map<K,V>` is a keyed map. Times are UTC instants. In code each shape is a Zod schema and its
TypeScript type is inferred from it (`z.infer`); every external input is validated with its schema
before use (14 §A).

**Sergeant** is the whole system. **Reasoning** is the AI component inside it; the **deterministic
core** is the rest (00 §3). Where a type records who did something, the actor is `reasoning`
(proposed by Sergeant's reasoning), `guardrail` (performed automatically by the deterministic core),
or `human`.

## Scalars

```
TaskId, RunId, TurnId, ActionId, QuestionId, MessageId   // "tsk_…", "run_…", "turn_…", "act_…", "q_…", "msg_…"
RuleId          // a Gate rule id such as "M5" (03 §7, 06 §6, 08 §7)
ProfileName     // a RunnerProfile name
RepoSlug        // "owner/name"
Sha             // a full git commit SHA
LinearUserId, LinearCommentId, LinearIssueId
ArtifactRef     // an S3 key under the installation's artifact bucket (02 §5)
Glob            // a path glob, e.g. ".github/**"
ConversationRevision   // sha256 of the issue's normalized title + description and the sorted (id, updatedAt)
                       // of every human comment, at a point in time (03 §5)
```

## Summary table

"If lost" applies the charter's test (P3): what happens if this disappears?

| Type | Why it exists | Owner | Durable? | Source of truth | Lifecycle | If lost |
|---|---|---|---|---|---|---|
| `InstallationIdentity` | Which account/region/state bucket this Sergeant is | operator (`sgt init`) | yes, immutable | SSM identity record | created once | installation cannot start (unchanged from S1) |
| `InstallationConfig` | Everything an installation decides | operator (`sgt config`) | yes, versioned | SSM config | new SSM version per edit | installation cannot start |
| `RepositoryEnrollment` | Repos Sergeant may ever give a worker; per-repo merge policy | operator | yes (in config) | `InstallationConfig.repositories` | added → enabled ⇄ disabled → removed | as config |
| `RunnerProfile` | A named way to run an agent, with its optional capabilities | operator | yes (in config) | `InstallationConfig.runnerProfiles` | config edits | as config |
| `Task` | The ledger entry for one episode of a delegated issue | deterministic core | yes | `tasks` row; the brief lives in Linear | open → closed (`done \| canceled`) | a missing ledger starts **paused** so nothing restarts unattended; an operator decides (02 §9) |
| `HumanWait` | "This task is waiting for the answer to this Linear question" | reasoning | yes | `tasks.human_wait` + the Linear comment | open → answered \| withdrawn | a human decision could be abandoned — guarded (02 §1) |
| `RepositorySet` | Which enrolled repos this task's runs are given | reasoning | yes | `tasks.repositories` | edited by `set_repositories` | reasoning re-chooses next turn |
| `Budget`, `TaskBudget`, `Usage` | Limits, the current budget window, and spend | config, core, runners | yes | `tasks`, `runs`, `turns` | a window opens at admission and again at each human answer to a Sergeant question; usage monotone | time and concurrency limits are re-derived; spend history is lost (accepted, rare) |
| `BudgetStatus` | Used vs. limit now | BudgetMeter | no | computed | — | recomputed |
| `Run` | One execution of the primary worker or a reviewer | core (record) / runner (execution) | yes | `runs` row + the runner | `starting → running ⇄ waiting → succeeded \| failed \| canceled` | runs cannot be canceled or accounted until found (adapters with `list` find them) |
| `RunHandle` | Adapter's opaque pointer | runner adapter | yes | `runs.handle` | set once | as Run |
| `RunSpec`, `RunStatus`, `RunResult` | The runner contract's inputs and outputs | core / runner | brief + report as artifacts | — | — | — |
| `CredentialGrant` | How a run gets development credentials | core | token hash only | `runs` + vending endpoint | valid while the run is non-terminal | the run loses access (fails safe) |
| `TaskExcerpt` | The current Linear task source, verbatim, for a run | core | in the brief | Linear | per brief | as brief |
| `WorkerBrief`, `ReviewBrief` | What a run is asked to do | reasoning (content) + core (envelope) | yes (S3) | brief artifact | write-once | audit only |
| `WorkerReport`, `ReviewReport` | What a run did, parseable | worker / reviewer | yes (S3 + parsed on run row) | report artifact | replaceable until the run is terminal, then fixed | the run reads as "report unavailable"; work is redone |
| `Finding`, `FindingResolution` | One review finding; how a blocking one was answered | reviewer; worker or reasoning | yes | report / disposition | write-once | as container |
| `ReviewRecommendation` | The worker's call on fresh review for a PR head | worker | yes (in report) | `WorkerReport` | fixed with the final report | treated as "review required" |
| `ReviewDisposition` | Review standing of one PR head | reasoning proposes, Gate verifies | yes | `actions` (`record_review_disposition`) | write-once per key | that head cannot merge until reviewed again or waived (fails closed) |
| `ReviewFacts` | Review telemetry for later comparison | core + reasoning | yes | `runs.review_facts` | filled as outcomes become known | metrics gap only |
| `PullRequestRef` | A PR that belongs to the task | Linear | in Linear | Linear issue attachments | linked → unlinked | rebuilt from Linear |
| `PullRequestFacts`, `CheckSummary` | Live PR and CI state | GitHub | no | GitHub API | per read | re-read |
| `HumanComment` | A human's comment | human | in Linear | Linear | — | — |
| `HumanQuestion` | Something Sergeant asked | reasoning | yes | the `ask_human` action + the Linear comment | open → answered \| withdrawn (derived) | as HumanWait |
| `WakeReason` | Why a turn is due | core | until consumed | `tasks.wake_reasons` | appended; cleared when a turn starts | restart wakes every task anyway |
| `ExternalFact` | One fact with provenance | FactReader | in the Situation Report | Linear / GitHub / runner / ledger | per turn | — |
| `SituationReport` | The bounded snapshot one turn starts from | FactReader | yes (S3) | assembled | write-once | audit/replay gap |
| `ReasoningSession` | Reasoning's working memory for a task | core (storage) + reasoning (content) | best-effort | session artifact | open → compacted* → discarded | a fresh session re-reads the world (P4) |
| `Turn`, `TurnDecision` | One invocation of reasoning and how it ended | core / reasoning | yes | `turns` row | `running → completed \| incomplete \| failed` | audit/cost gap |
| `Action`, `ActionStep`, `GateVerdict` | One proposed effect, its verdict, and (for closing actions) its ordered steps | reasoning / guardrail / human; Gate; Effector | yes | `actions` row | `denied`, or `pending → succeeded \| failed \| abandoned` | dedupe and audit lost; a duplicate comment is possible |
| `AuditEvent` | Uniform view of what happened | core | view | `turns`, `actions`, `runs` | — | — |
| `SystemState` | Installation-wide pause | operator | yes | `system_state` | paused ⇄ running | a missing ledger starts paused |

Types deliberately **absent**: phase, wait (other than `HumanWait`), grant (budget included: a human
answer opens a fresh budget window, TECH-5059),
workspace, candidate, repo scope, plan, work unit, capability, executor, fault, decision menu, choice
id, inbox or outbox entry, acceptance-criterion record, lease, and any separate "Supervisor" actor.
`13-s1-supersession.md` says where each went.

---

## Installation

```
InstallationIdentity {          // ADR-0040, unchanged
  installationId, environment, awsAccountId, region, stateBucket, endpoint?
}

InstallationConfig {            // ADR-0042 mechanism; Sergeant 2 keys only
  linear: {
    workspaceId
    agentUserId                 // the Sergeant app user issues are delegated to
    allowedTeamIds[]
    opsTeamId?                  // where `escalate` files installation-level issues
    oauthClientRef, webhookSecretRef      // Secrets Manager references, never values
  }
  github: {
    controlPlaneApp: { appId, installationIds[], privateKeyRef }   // merge, reads, attachments
    workerApp:       { appId, installationIds[], privateKeyRef }   // tokens minted for runs only
    webhookSecretRef
  }
  repositories: RepositoryEnrollment[]
  runnerProfiles: RunnerProfile[]
  defaults: {
    budget: Budget
    profileForRole: { worker: ProfileName, reviewer: ProfileName, auditReviewer?: ProfileName }
  }
  limits: { maxOpenTasks, maxConcurrentRuns, maxConcurrentTurns }
  runners: {
    reconcileSeconds            // default 60: how often RunManager asks every non-terminal run for status
    idleTimeoutSeconds          // default 1200: no activity (or no answer) this long → wake reasoning
  }
  reasoning: {
    model
    maxTurnCostUsd, maxTurnSeconds, maxToolCalls, maxSleepSeconds
    sessionMode: fresh_each_turn | persistent      // 03 §8
    compactAtFraction, maxCompactions
  }
  review: {
    auditSampleRate             // fraction of skipped reviews that get a nonblocking audit review
    qualityBudgetUsdPerDay      // pays for audit reviews; not charged to tasks
  }
  followups: { maxDepth, autoDelegate }
  humanWait: { remindAfterHours }
  approvers: LinearUserId[]     // waive review, receive escalations
  aws: { runnerDevRoleArn, artifactBucket, logGroup }
  release?: { channel: main | soaked, soakMinutes?, paused? }  // 10 §6 (TECH-4959); absent: never self-update
}
```

- **Why**: one place for everything that differs between installations, so no installation is
  named in source (UNF-689).
- **Owner/durability/source**: the operator; SSM in the installation's own account; secrets as
  Secrets Manager references.

## RepositoryEnrollment

```
RepositoryEnrollment {
  slug: RepoSlug
  purpose                       // one or two sentences; reasoning uses it to choose the repo set
  enabled                       // disabled: never added to a new repo set, dropped from credentials
  mergePolicy: sergeant | human // who performs the merge (08 §7)
  mergeMethod: squash | merge | rebase
  alwaysReviewPaths: Glob[]     // optional; a "not required" disposition is refused if the PR touches these
}
```

## RunnerProfile and RunnerCapabilities

```
RunnerProfile {
  name: ProfileName
  adapter                       // which Runner implementation
  provider                      // "anthropic", "openai", ... (review telemetry)
  model
  roles: (worker | reviewer)[]
  maxConcurrent
  capabilities: RunnerCapabilities                 // declared by the adapter (04 §2)
  settings: json                // adapter-specific
  pricing?                      // for estimating cost from tokens
}

RunnerCapabilities {            // all optional
  liveUsage                     // status() reports spend while running
  messaging                     // send() reaches a running run
  resume                        // a waiting or finished run can be continued in its own session
  freshSubagents                // the adapter can launch, and attest, a fresh-context subagent
  list                          // the adapter can enumerate its runs by runId
  nativeCloud
  providerReview?
}
```

---

## Task

```
Task {
  id: TaskId
  linearIssueId                 // at most one open Task per issue (partial unique index)
  linearIdentifier              // "UNF-123", display cache
  admittedAt
  closedAs?: done | canceled
  closedAt?, closedReason?
  repositories: RepositorySet
  humanWait?: HumanWait
  budget: TaskBudget
  wake: { at?, reasons: WakeReason[] }
  turnClaim?: { turnId, since }
  session?: { ref: ArtifactRef, approxTokens, compactions, lastCompactedAt? }
  health: { consecutiveTurnFailures, lastError? }
}

TaskStatus (derived, display only):
  closedAs                                  → done | canceled
  a closing action is pending (03 §10)      → closing
  humanWait present                         → waiting
  otherwise                                 → active
```

- **Why**: the minimum to remember across restarts: accepted episodes, budget and spend, the chosen
  repositories, the one open human question, and when to wake. The
  brief, discussion, PR links, and visible history stay in Linear.
- **Lifecycle** (no state machine beyond this):

```
admit_task                                   → open
last step of a closing action (03 §10)       open → closed (done | canceled)
a human answer to a Sergeant question        open → open, with a fresh budget window
re-delegation or reopening after close       → a new Task row with a fresh budget
```

## HumanWait and RepositorySet

```
HumanWait {
  questionId: QuestionId
  linearCommentId               // the comment that asked it
  purpose: decision | budget_extension
  askedAt, remindedAt?
}

RepositorySet = RepoSlug[]      // subset of enabled enrollments; no fixed size limit
```

- **HumanWait**: at most one per task. Cleared only by a turn whose decision names a reply as its
  answer (`TurnDecision.answeredQuestion`), or by `withdraw_question`. While open: every reply wakes the task, it heads every
  Situation Report, and `mark_complete` is refused (X4). It does not block other work.
- **RepositorySet**: reasoning decides which repositories a run is given (captain, round 1). Vended
  GitHub tokens are scoped to it, which keeps workers pointed at the right code. It is not a security
  boundary between tasks: co-resident runs share one trust zone (09 §2).

## Budget, TaskBudget, Usage, BudgetStatus

```
Budget {                        // the installation's allowance for one window (defaults.budget)
  window: { wallMinutes, costUsd }                 // default 120 minutes and $25: the only budget limits
  softFraction                  // default 0.8
  wrapUpGraceSeconds            // default 600
  reasoningReserveUsd           // default 2
  maxConcurrentReviewers        // default 2 (there is never more than one active worker)
  maxRunStartsPerHour           // default 6
}

TaskBudget {                    // what the task row keeps
  window: { wallMinutes, costUsd }                 // copied from config when the window opens; fixed for it
  windowStart?                  // absent: the window opened at admission (`admittedAt`)
  priorRunIds: RunId[]          // runs of earlier windows, which this window does not count
}

Usage {
  inputTokens?, outputTokens?, cachedInputTokens?
  costUsd?
  costBasis: billed | estimated | unknown          // estimated = tokens × profile pricing
  wallSeconds
}

BudgetStatus {                  // computed by BudgetMeter, never stored
  window: { wallMinutes, costUsd }
  taskStart                     // admittedAt
  windowStart                   // admittedAt, or the latest human answer to a Sergeant question
  wallDeadline                  // windowStart + window.wallMinutes
  spentUsd                      // reported cost of this window's runs and turns
  costLimitUsd                  // window.costUsd
  unknownCostRuns               // runs whose cost is not known yet
}
```

- **A budget is wall time and money only.** No count of turns or runs ends a task (TECH-5059).
- **Windows**: a task's first window opens at admission. The first human answer after any Sergeant
  question, the budget question included, opens a fresh one at the answer's timestamp, with zero spend
  and the installation's current `defaults.budget.window`; so does a human review of the task's PR (07
  §6, TECH-5218). Opening a window sets `windowStart`, copies the window, and moves the task's runs so far
  into `priorRunIds`. One answer opens one window, also across a restart. There is no grant record, grant
  action, or approver check: an extension is just an answer (03 §5, §9).
- **Hard**: wall time. No new run, message, or merge after `wallDeadline` (B1), plus concurrency and
  cancellation. Sergeant controls these itself.
- **Best-effort**: cost. It is the sum of reported or estimated cost of this window's runs and turns.
  Where a provider reports usage live, BudgetMeter enforces it mid-run; otherwise it is known only when
  the run ends, and the wall time is the backstop. Dev/stage resources, CI minutes, and tools with their
  own billing are outside it. There is no cross-provider billing ledger (captain, 2026-10-02).

---

## Run

```
Run {
  id: RunId                     // minted before calling the runner; the runner's idempotency key
  taskId
  role: worker | reviewer
  reviewTrigger?: required | audit                 // reviewers only
  profile, adapter, provider, model
  handle?: RunHandle
  brief: { ref: ArtifactRef, sha256, purpose, conversationRevision: ConversationRevision }
  limits: { maxWallSeconds, maxCostUsd }
  status: starting | running | waiting | succeeded | failed | canceled
  statusUnknownSince?           // the runner has not answered since then; cleared on any answer
  cancelRequestedAt?
  failure?: { kind: RunFailureKind, detail }
  startedAt?, endedAt?, lastActivityAt?, lastCheckedAt
  usage: Usage
  progress?, waitingFor?
  report?: { ref: ArtifactRef, revision: int, parsed: WorkerReport | ReviewReport | null, parseError? }
  reviewFacts: ReviewFacts[]    // a reviewer run's own review, or a worker's subagent reviews
  credentialTokenHash
  createdByActionId
}

RunFailureKind = start_failed | lost | crashed | wall_timeout | budget | provider_error
RunHandle      = { adapter, opaque: json }
```

- **Primary worker**: at most one active worker run per task (R1, 03 §7).
- **`lost`** means the adapter *knows* the run is gone (its process or container is absent, the
  provider reports it terminated). A status call that cannot get an answer is **unknown**, never lost
  (04 §6).

## RunSpec, RunStatus, RunResult, CredentialGrant

```
RunSpec {
  runId, taskId, role
  brief: { markdown, header: WorkerBrief | ReviewBrief, fullThread?: markdown }  // fullThread is written
                                // beside the brief when the excerpt omits comments (05 §2)
  profile: RunnerProfile
  repositories: RepositoryEnrollment[]             // the task's RepositorySet, expanded
  credentials: CredentialGrant
  limits: { maxWallSeconds, maxCostUsd, deadlineAt }
  resume?: RunHandle            // continue this earlier run's session (capability `resume`)
}

CredentialGrant {
  vendingUrl                    // Sergeant's runner API on loopback (11 §4)
  runToken                      // run-scoped; stops working when the run ends
  github: write | read          // worker App token scoped to the task's RepositorySet
  aws: dev | none
  modelCredentials              // adapter-provided
}

RunStatus {
  state: starting | running | waiting | succeeded | failed | canceled
  lastActivityAt?, usage?, progress?, waitingFor?
  failure?: { kind: RunFailureKind, detail }
}
// Runner.status throws StatusUnavailable when it cannot answer; that is not a RunStatus.

RunResult {
  state: succeeded | failed | canceled
  reportMarkdown?, usage, transcriptRef?: ArtifactRef, failure?
}
```

---

## TaskExcerpt

```
TaskExcerpt {                   // the current Linear task source, copied verbatim by the core
  linearIdentifier, url, title
  description                   // verbatim, including any acceptance section as the human wrote it
  conversationRevision: ConversationRevision
  humanComments: [{ id, author, at, body }]        // ALL human-authored comments, verbatim, oldest first
  omittedComments?: [{ id, author, at, firstLine }]  // only when the thread exceeds the inline bound (05 §2)
  fullThreadRef?: ArtifactRef   // the complete thread, delivered beside the brief when anything is omitted
}
```

Workers and reviewers receive the original task text, never only a summary made by reasoning. The
excerpt includes **every** human-authored comment; nothing is selected by relevance, and reasoning
cannot remove one. A very long thread is bounded objectively (05 §2): the newest comments stay inline
and every older one gets a pointer into the full thread, which the run also receives.
Reasoning's objective and notes are added beside it, never in place of it (captain, 2026-10-02).
There are no durable acceptance-criterion records: if the issue changes mid-run, the run is sent the
new text (07 §10).

## WorkerBrief

```
WorkerBrief {
  briefVersion: "s2-worker-brief/1"
  runId, taskId
  task: TaskExcerpt
  objective                     // reasoning's instruction for this run; may not narrow the task
  context: {
    priorRuns: [{ runId, role, outcome, summary, knownGaps[], handoff? }]
    pullRequests: [{ ref: PullRequestRef, facts: PullRequestFacts }]
    reviewFindings: [{ reviewRunId, reviewedSha, findings: Finding[] }]
    humanDecisions: [{ question, answer, commentUrl }]
    notes?
  }
  environment: EnvironmentNote
  limits: { maxWallSeconds, maxCostUsd, deadlineAt }
  rulesVersion
  reviewPolicy: { alwaysReviewPaths: map<RepoSlug, Glob[]> }
  reportContract: "s2-worker-report/1"
}

EnvironmentNote {
  repositories: [{ slug, purpose, mergePolicy }]   // the task's RepositorySet
  otherEnrolledRepositories: [{ slug, purpose }]   // names only; ask to add one
  access: { github: write | read, aws: dev | none, tools: string[] }
  notAvailable: string[]
}
```

## ReviewBrief (the "ReviewRequest")

```
ReviewBrief {
  briefVersion: "s2-review-brief/1"
  runId, taskId
  trigger: required | audit
  task: TaskExcerpt
  subject: {
    pullRequests: [{ repo, number, url, baseRef, baseSha, headSha }]
    previousReviews: [{ reviewRunId, reviewedSha, findings: Finding[] }]
  }
  implementerClaims: [{ fromRunId, summary, decisionsMade[], knownGaps[], validation[] }]
  focus?
  environment: EnvironmentNote  // github: read
  limits, rulesVersion
  reportContract: "s2-review-report/1"
}
```

## WorkerReport

```
WorkerReport {
  reportVersion: "s2-worker-report/1"
  runId
  outcome: completed | partial | blocked | needs_decision | failed
  summary
  pullRequests: [{
    repo, number, url, branch, headSha
    change: opened | updated | unchanged | closed
    closesIssue                 // the PR body carries the closing reference (07 §7)
    note?, mergeOrder?
    review: ReviewRecommendation
  }]
  acceptance: [{ criterion, status: met | partial | not_met | not_applicable | unverifiable, evidence }]   // criterion quoted from the issue
  validation: [{ check, result: passed | failed | blocked_by_environment | not_run, evidence }]
  knownGaps: string[]
  decisionsMade: [{ decision, why }]
  addressedFindings: FindingResolution[]           // resolution: fixed | disputed
  questions: [{ id, question, whyHumanNeeded, options?: string[], recommendation?, blocking }]
  repositoryRequests: [{ slug, why }]
  followups: [{ title, category, why, repo? }]     // a real bug, unfinished work, blocker, or ops/security problem
  feedback: string[]                               // the Feedback section; never filed (TECH-5186)
  subagentReviews: SubagentReview[]                // measurement only (06 §5)
  handoff?: { branches: [{ repo, branch, pushedSha }], wipPushed, notes }
  acknowledgedMessages: MessageId[]
}

ReviewRecommendation {
  required                      // missing or unparseable → true
  reason                        // non-empty when required = false
  categories: string[]
  sinceReviewedSha?: Sha
}

SubagentReview { pr: { repo, number }, reviewedSha, promptRef: ArtifactRef, report: ReviewReport,
                 adapterAttested: bool }
```

## ReviewReport, Finding, FindingResolution

```
ReviewReport {
  reportVersion: "s2-review-report/1"
  reviewed: [{ repo, number, headSha }]
  conversationRevision: ConversationRevision  // echoed from the brief
  verdict: approve | changes_requested | needs_human
  acceptance: [{ criterion, verdict: met | not_met | contradicted | needs_live_validation, evidence }]
  findings: Finding[]
  externalBoundaries: [{ claim, verification: docs | live | unverified, evidence }]
  claimsChecked: [{ claim, holds: yes | no | unclear, evidence }]
  freshContext: { mode: separate_run | fresh_subagent, inheritedImplementerReasoning: false }
  summary
}

Finding {
  id                            // reviewer-chosen; "acceptance-<n>" when added by the parser (below)
  severity: blocking | non_blocking | nit
  category                      // "acceptance" for an unmet or contradicted outcome
  location?, description, suggestion?
}

FindingResolution {
  findingId
  resolution: fixed                 // worker: changed the code to address it
            | disputed              // the finding or verdict is wrong; reason + evidence required
            | accepted_nonblocking  // real but not worth holding the merge; never for acceptance findings
  reason
}
```

The reviewer rules (06 §4) require an unmet or contradicted outcome to be reported as a blocking
finding with category `acceptance`. If a report gives such a verdict without a matching finding, the
parser adds one with id `acceptance-<n>` (n = its position in `acceptance`), so every unmet outcome can
be referred to, fixed, or disputed (fixes the scenario-15 type error). This is a parse step, not a
stored criterion record. It is not built yet: today's `ReviewReport` has no `acceptance` array (06 §4).

## ReviewDisposition

```
ReviewDisposition =
  | { kind: reviewed
      reviewRunId: RunId        // a separate reviewer run; subagent reviews do not qualify (06 §5)
      acceptedFindings: FindingResolution[]        // every blocking finding of that review not fixed
    }
  | { kind: not_required
      workerRunId: RunId        // whose final report says required = false for this head
      reason
      sinceReviewedSha?: Sha
      acceptedFindings: FindingResolution[]        // blocking findings of that earlier review not reported fixed
    }
  | { kind: waived
      approverCommentId: LinearCommentId
    }
& { taskId, repo, number, prHeadSha: Sha, recordedAt, actionId }
```

- **Key**: `disposition:<taskId>:<repo>#<n>:<headSha>`. Write-once per key.
- The Gate's rules are in 06 §6.

## ReviewFacts

```
ReviewFacts {                   // telemetry; enough to compare review modes and providers later
  mode: separate_run | subagent
  trigger: required | audit | subagent
  reviewer: { provider, model }
  implementer: { provider, model }
  subject: [{ repo, number, headSha }]
  findings: { blocking, nonBlocking, nits }
  adapterAttested?              // subagent reviews only
  // filled in later, when known:
  resultingMutation?            // a later worker report resolved ≥ 1 of its findings `fixed`
  disputed?, acceptedNonblocking?
  humanFoundAfterClean?: [{ commentId | issueId, summary }]   // from TurnDecision.defectReports
}
```

## PullRequestRef, PullRequestFacts, CheckSummary

```
PullRequestRef {                // from Linear attachments; not stored by Sergeant
  repo, number, url, linearAttachmentId
  linkedBy: worker_report | reasoning | human
}

PullRequestFacts {
  state: open | closed | merged
  draft, author
  headRef, headSha, baseRef, baseSha
  mergeable: true | false | unknown
  mergeableState                // clean | dirty | blocked | behind | unstable | unknown
  behindBy?, body
  checks: CheckSummary
  githubReviews: [{ author, state }]
  labels[], changedFiles: string[], additions, deletions
  observedAt
}

CheckSummary {
  sha
  overall: passed | failed | pending | missing | not_run_conflict
  required: string[]
  checks: [{ name, required, status, conclusion?, url }]
  observedAt
}
```

## HumanComment, HumanQuestion

```
HumanComment {
  id: LinearCommentId, parentId?
  author: { id: LinearUserId, name, isApprover }
  createdAt, updatedAt, body
  isNew                         // created or edited since the last completed turn's snapshot; display only
}

HumanQuestion {                 // params + result of an ask_human action
  id: QuestionId
  purpose: decision | budget_extension
  question, whyHumanNeeded
  options?: [{ label, consequence }]
  recommendation?
  blocking                      // a blocking question becomes the task's HumanWait
  linearCommentId, askedAt
}
```

---

## WakeReason, ExternalFact

```
WakeReason {
  kind: admitted | linear_comment | linear_issue_changed | linear_relation_changed
      | pr_event | checks_completed | run_changed | budget_soft | budget_exhausted
      | capacity_available | human_wait_reminder | timer | restart | human_cli
      | previous_turn_incomplete
  ref?, at
}

ExternalFact<T> {
  source: linear | github | runner | ledger | clock
  key, value?: T, observedAt
  freshness: live | cached | unavailable
  error?
}
```

## SituationReport

```
SituationReport {
  version, generatedAt, taskId, turnId
  wakeReasons: WakeReason[]
  conversationRevision: ConversationRevision  // what this turn saw; merge and completion carry it (M10, X5)
  task: {
    ledger: { status, admittedAt, repositories, health }
    issue: ExternalFact<{ identifier, url, title, description, state, stateType, labels, priority,
                          assignee, delegate, team, project }>      // description verbatim
    descriptionChange?: { previousRevision, diff }    // since the last completed turn
    relations: ExternalFact<{ blockedBy[], blocks[], parent?, children[], related[] }>
  }
  humanWait?: HumanWait & { question: HumanQuestion }
  comments: {
    human: HumanComment[]       // every human comment, verbatim; in a very long thread the oldest beyond 30
                                // are pointers (never one with isNew)
    sergeant: [{ id, at, excerpt }]
  }
  pullRequests: [{ ref, facts: ExternalFact<PullRequestFacts>, dispositions: ReviewDisposition[] }]
  candidatePrs: [{ repo, number, url, why }]
  runs: {
    active: Run[]               // with statusUnknownSince when the runner cannot answer
    finishedSinceLastTurn: (Run & { report })[]
    earlier: [{ runId, role, purpose, status, outcome?, summary? }]
  }
  budget: BudgetStatus
  recentTurns: [{ turnId, at, summary, actions: [{ kind, short, verdict, status }] }]   // last 5
  unresolvedActions: Action[]
  history: { olderComments, olderTurns, olderRuns }                // pointers for read tools
  installation: {
    enrolledRepositories: [{ slug, purpose, mergePolicy, enabled }]
    runnerProfiles: [{ name, provider, model, roles, capabilities }]
    policy: { followups, review, approvers }
  }
  system: { paused, draining }
}
```

A **bounded current snapshot with explicit history pointers**: current facts are complete; older
comments, turns, and runs are reachable through read tools (F12). Summaries in it describe progress;
they never replace or narrow the issue, which is always included verbatim.

## ReasoningSession

```
ReasoningSession {              // 03 §8
  ref: ArtifactRef
  approxTokens
  workingSummary?               // the latest compaction summary; cites source ids
  compactions, lastCompactedAt?
}
```

## Turn, TurnDecision

```
Turn {
  id: TurnId, taskId
  startedAt, endedAt?
  wakeReasons: WakeReason[]
  situation: { ref: ArtifactRef, sha256, conversationRevision: ConversationRevision }
  session: { mode: fresh | resumed, compactedThisTurn }
  model, promptVersion
  usage: Usage
  outcome: running | completed | incomplete | failed
  error?
  decision?: TurnDecision
  actionIds: ActionId[]
}

TurnDecision {
  summary                       // ≤ 3 sentences
  answeredQuestion?: { questionId, commentId, interpretation }   // clears the HumanWait (03 §5)
  defectReports?: [{ commentId, repo, number, sha?, summary }]   // a human reports a defect in reviewed
                                                                 // code; review telemetry only (06 §9)
  nextWakeAt?
}
```

## Action, ActionStep, GateVerdict

```
Action {
  id: ActionId
  taskId?, turnId?
  actor: reasoning | guardrail | human(identity)
  kind: ActionKind
  params: json                  // redacted
  idempotencyKey                // unique (02 §6)
  verdict: GateVerdict
  status: denied | pending | succeeded | failed | abandoned
  steps?: ActionStep[]          // only closing actions have steps (03 §10)
  result?: json, error?
  attempts, createdAt, completedAt?
}

ActionStep {
  name                          // "cancel_runs", "remove_delegation", "post_note", "move_issue_state", "close_row"
  status: pending | done | failed | skipped
  result?, error?, attempts
}

ActionKind =
  // proposed by reasoning
    start_worker | start_reviewer | send_run | cancel_run | set_repositories
  | comment_task | ask_human | withdraw_question | create_followup_task
  | link_pr | unlink_pr | record_review_disposition | merge_pr
  | escalate | mark_complete | release_task
  // performed by guardrails (also link_pr for worker-reported PRs, 08 §4,
  // start_reviewer for sampled audits, 06 §8, and comment_task for fixed notices)
  | admit_task | close_task | enforce_budget
  // requested by humans through sgt (also cancel_run)
  | cancel_task | wake_task | pause | resume

GateVerdict = { allowed: true, checkedAt } | { allowed: false, rule: RuleId, reason, checkedAt }
```

- **One action name per effect**: `cancel_run` is the same kind whether reasoning proposes it or a
  team member runs `sgt run cancel`; the actor differs.
- **Lifecycle**: `denied` is terminal. Allowed actions go `pending → succeeded | failed`, or
  `abandoned` when a restart finds them stale and no longer allowed. `params` and `verdict` are
  write-once.

## AuditEvent, SystemState

```
AuditEvent { at, taskId?, runId?, turnId?, actor, kind, summary, ref }   // a view, not a table

SystemState { pause?: { since, by, reason } }
```

Draining is process-local (a deploy quiesces the daemon), not durable state.

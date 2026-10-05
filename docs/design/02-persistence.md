# 02 — Persistence model

Every durable field must pass the charter's test (P3): **what happens if we lose it?** If the
answer is "an agent occasionally repeats some work" or "a small race with an external system", Sergeant
does not protect it. Durable state and deterministic rules exist only where losing them could cause
material harm Sergeant is required to prevent: an unreviewed or red merge, a production or
control-plane boundary crossed, runaway time or concurrency, or a human decision silently abandoned
(00 P3). Anything that can be re-read from Linear, GitHub, or the runner is re-read.

The captain's warning applies throughout: the moment a local cache needs synchronization, recovery,
or state-machine logic, it should not exist.

## 1. What has to survive a restart

| Kept | If we lost it | Home |
|---|---|---|
| Which issue episodes Sergeant accepted, and whether each is closed | A finished or stopped issue still delegated to Sergeant could be worked again | `tasks` |
| The current budget window (its start, allowance, and the earlier windows' runs); run and turn usage | A window restarts or spend is miscounted; spend history lost | `tasks.budget`, `runs.usage`, `turns.usage` |
| The one open human question | A human decision could be abandoned | `tasks.human_wait` |
| The task's repository set | Reasoning re-chooses next turn | `tasks.repositories` |
| Runs Sergeant started: handle, brief, limits, role | Runs could not be canceled or accounted until found | `runs` |
| Reports | Reasoning cannot see what a finished run did; work is redone | S3 + parsed on `runs.report` |
| Review dispositions | Merges fail closed: the head needs a new review or a waiver | `actions` (`record_review_disposition`) |
| Proposed, allowed, denied, and performed effects | Dedupe for harmful duplicates (§6), audit, re-drive of closing steps | `actions` |
| What each turn saw, decided, and cost, including the conversation revision it saw | Audit, cost, eval replay; the next reconcile wakes the task once more (safe) | `turns` + S3 |
| Review telemetry | A metrics gap only | `runs.review_facts` |
| Installation pause | Restarting unattended after an operator stopped everything | `system_state` |

Re-read, never stored: the issue, its comments, relations, state, and **which PRs belong to it**
(Linear attachments); PR state, CI, mergeability, required checks (GitHub); run liveness and live usage
(runner); configuration (SSM).

## 2. Challenges, answered

**A local Task mirror?** No. A ledger row holds identity and operational accounting only.

**Durable task status?** No state machine. A task is open or closed. "Waiting" is derived from the human
wait; "closing" from a pending closing action.

**Acceptance-criterion records?** No. The current Linear issue is the source; workers and reviewers get
it verbatim (01 `TaskExcerpt`).

**A local PR association cache?** No. Linear attachments are the association, re-read each turn and
before each merge. An in-memory index rebuilt at startup routes GitHub webhooks.

**Phases, waits, grants, leases?** Only the human wait (P10). No grants: a human's answer to a Sergeant
question opens a fresh budget window, recorded in `tasks.budget` (01 `TaskBudget`). No
leases: one daemon per ledger, enforced with an exclusive lock (S1's UNF-567 decision).

**An inbound inbox or an outbox?** No. Comments are read from Linear each turn. No per-comment
record exists: merges and completion compare a conversation revision instead (03 §5). Each `actions` row is written before its effect with a unique key; the
few closing actions record ordered steps and are re-driven (03 §10). Sergeant never claims atomicity
across systems.

**An events table, a billing ledger, an experiment store?** No. `turns`, `actions`, and run timestamps
answer audit questions; spend is best-effort from reported usage (01 `Budget`); review telemetry is a
JSON column on runs.

**Reasoning memory?** Not in the ledger. Sessions are best-effort S3 artifacts (03 §8).

**Workspaces, caches, worker-account quota?** Runner adapter concerns (04).

**Repository enrollment?** SSM configuration (UNF-689 direction), not a table.

## 3. Tables

One embedded SQLite file on the daemon's data volume (WAL); not backed up (§9). Each JSON column has
one schema type from `01`.

### `tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `linear_issue_id` | text | partial unique index where `closed_as is null` |
| `linear_identifier` | text | display cache |
| `admitted_at`, `closed_at` | time | |
| `closed_as`, `closed_reason` | text? | |
| `repositories` | json `RepositorySet` | |
| `human_wait` | json? `HumanWait` | |
| `budget` | json `TaskBudget` | window, `windowStart`, `priorRunIds` |
| `wake_at`, `wake_reasons` | time?, json | |
| `turn_claim` | json? | cleared at startup |
| `session` | json? | `ReasoningSession` pointer |
| `health` | json | |
| `created_at`, `updated_at` | time | |

### `runs`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | the runner's idempotency key |
| `task_id` | text FK | |
| `role`, `review_trigger` | text | |
| `profile`, `adapter`, `provider`, `model` | text | |
| `handle` | json? | |
| `brief_ref`, `brief_sha256`, `purpose`, `brief_conversation_revision` | text | |
| `limits` | json | |
| `status` | text | |
| `status_unknown_since`, `cancel_requested_at` | time? | 04 §6 |
| `failure` | json? | |
| `started_at`, `ended_at`, `last_activity_at`, `last_checked_at` | time | |
| `usage` | json | monotone |
| `progress`, `waiting_for` | text? | |
| `report_ref`, `report_revision` | text?, int | latest report; earlier revisions stay in S3 |
| `report` | json? | parsed, or null with `report_parse_error` |
| `review_facts` | json | `ReviewFacts[]` |
| `credential_token_hash` | text | |
| `created_by_action_id` | text | |

Indexes: `(task_id)`, `(status) where status in (starting, running, waiting)`.

### `turns`

`id`, `task_id`, `started_at`, `ended_at`, `wake_reasons`, `situation_ref`, `situation_sha256`,
`conversation_revision`, `session_mode`, `compacted`, `model`, `prompt_version`, `usage`, `outcome`, `error`,
`decision` (`TurnDecision`).

### `actions`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `task_id`, `turn_id` | text? FK | |
| `actor` | text | `reasoning \| guardrail \| human:<identity>` |
| `kind` | text | |
| `params` | json | redacted |
| `idempotency_key` | text UNIQUE | |
| `verdict` | json | write-once |
| `status` | text | |
| `steps` | json? | closing actions only |
| `result`, `error` | json?, text? | |
| `attempts` | int | |
| `created_at`, `completed_at` | time | |

Indexes: `(task_id, created_at)`, `(status) where status = 'pending'`.

### `system_state`

Key/value singleton rows. One key: `pause`.

Five tables, against S1's ten plus JSON sub-documents for waits, grants, faults, health, repo scope,
planning baselines, and deep-assurance requirements (`docs/data-model.md:71`, `:225-231`).

## 4. What is deliberately not stored

| Not stored | Why it is safe |
|---|---|
| Issue text, comments, relations, state, PR links | Re-read from Linear |
| PR state, CI, mergeability, required checks | Re-read from GitHub each turn and before every merge |
| Phases, candidate lineage, repo scope, plans, work units, acceptance criteria | No such concepts |
| Worker and reasoning conversations | Transcripts and sessions go to S3 for debugging only |
| Workspaces, clones, caches | Runner-owned and disposable |
| Decision menus, choice ids, reply classifications | Free-text questions interpreted by reasoning |
| An event log, a billing ledger, experiment results | `turns` + `actions` + `runs`; best-effort spend; telemetry on runs |
| Enrollment | SSM configuration |
| Secrets and issued tokens | Never; only Secrets Manager references and the hash of each run token |

## 5. Artifacts and logs

**S3** (`aws.artifactBucket`), redacted before upload:

```
briefs/<taskId>/<runId>.md
reports/<taskId>/<runId>/<revision>.md
transcripts/<taskId>/<runId>/...         short retention
situations/<taskId>/<turnId>.json
sessions/<taskId>/<sessionId>/...         short retention, best-effort
review-metrics/<date>.json
```

**CloudWatch** (`aws.logGroup`): operational logs and a few metrics (open tasks, active runs, spend per
day, turn failures, runs with unknown status). Not a source of truth.

**Linear** gets only concise summaries and links (07 §3).

## 6. Idempotency

Robust deduplication only where a duplicate would be externally harmful; elsewhere an occasional
duplicate is accepted (captain, 2026-10-02).

| Effect | Key | Why it matters, and how |
|---|---|---|
| Start a run | `start:<runId>` | Two workers on one task. `runs` row written first; `Runner.start` is idempotent on `runId` (04 §3) |
| Merge | `merge:<taskId>:<repo>#<n>:<headSha>` | Merging the wrong head. GitHub's merge with the expected SHA; "already merged at that SHA" counts as success |
| Follow-up issue | `followup:<taskId>:<semanticKey>` | Duplicate issues for humans to clean up. Client-supplied issue id (verify V1) or a lookup by the key before creating; reasoning picks `semanticKey`, so re-proposals deduplicate |
| Close, cancel, release, complete | `close:<taskId>` | A stopped task restarting. One closing action per task; its steps are ordered and re-driven (03 §10) |
| Budget question | `budget-question:<linearIssueId>:<windowStart>` | Asking twice in one window, or matching an earlier task's question. One per task and window; a window opens only from a human answer, so it needs no key of its own |
| Review disposition | `disposition:<taskId>:<repo>#<n>:<headSha>` | Write-once evidence |
| Admit | `admit:<linearIssueId>:<observedAt>` | Two episodes of one issue. Partial unique index on open tasks per issue |
| Linear comment, question, note | `comment:<taskId>:<turnId>:<n>`, `ask:<taskId>:<turnId>:<n>` | Best-effort: a client-supplied comment id where Linear supports it (V1). A rare duplicate comment after a crash is accepted |
| Message a run | `send:<runId>:<messageId>` | At-least-once; workers acknowledge ids |
| Cancel a run, set repositories, link/unlink, withdraw, acknowledge | per-kind keys | Naturally idempotent |

Proposing an action whose key exists returns the earlier verdict and result instead of acting again.

## 7. Accounting and audit

- **Spend** (best-effort): `sum(runs.usage.costUsd) + sum(turns.usage.costUsd)` over the current
  window's task-charged runs and turns, from reported or estimated usage.
- **Wall time** (hard): from `windowStart` to `wallDeadline` (`windowStart` + the window's minutes).
- Both count only the current window: runs in `tasks.budget.priorRunIds` and turns before
  `windowStart` belong to earlier windows (01 `TaskBudget`).
- **Who did what**: `actions.actor`, `verdict`, `status`, `steps`.
- **What Sergeant saw and was told**: `turns.situation_ref`, `prompt_version`; **what a run was told**:
  `runs.brief_ref`.

## 8. Startup and restart

```
startup():
  acquire exclusive lock on <ledger>.lock, or exit
  if the ledger file is missing: create it with system_state.pause = { reason: "new or lost ledger" }   // §9
  clear tasks.turn_claim; mark turns with outcome = running as failed("restart")
  for each run with status in (starting, running, waiting): RunManager.reconcile(run)   // 04 §6
  for each action with status = pending: Effector.redrive(action)                      // 03 §10
  Intake.reconcileAll()
  rebuild the PR→task routing index from open tasks' Linear attachments
  for each open task: append WakeReason(restart); wake_at = now + stagger(i)
  start loops (11 §5)
```

## 9. Losing the ledger

Losing the whole ledger is rare (a lost data volume). It is an **accepted operational risk**, with no
backup, restore, or recovery subsystem: a ledger with its own recovery machinery would stop being a small
local ledger and become an authoritative state store.

**A missing ledger starts paused.** A daemon that finds no ledger creates an empty one with the
installation paused, so nothing is re-admitted with a fresh budget, and nothing runs, until an operator
looks. The operator inspects Linear, GitHub, and the runners (cancelling any orphan runs the adapters
can list), decides what to restart, and resumes; still-delegated issues are then admitted as new
episodes. Budget, spend, and audit history from before the loss are gone.

## 10. Concurrency inside the process

- One daemon process; short SQLite transactions.
- One turn per task at a time (`turn_claim` compare-and-set).
- Background loops only append wake reasons, update run rows, or perform guardrail actions. They never
  write `repositories` or `human_wait`.
- The Gate checks effects against **live** facts at execution time: before a merge it re-reads the PR,
  CI, attachments, and the Linear conversation revision (M10), so a turn that saw stale facts is refused
  and a new turn decides.

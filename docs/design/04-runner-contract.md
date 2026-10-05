# 04 — Runner contract

A **runner** executes one run (the primary worker or a reviewer) for Sergeant. The runner adapter
owns every process, session, container, or cloud-agent detail, plus workspaces, caches, provider
accounts, and cleanup. Sergeant knows runs only by its own `runId`, an opaque `RunHandle`, and the
small contract below.

Provider neutrality is a principle, not a lowest common denominator (P12): the **common contract** is
small and every adapter implements it; **optional capabilities** let reasoning use richer provider
features without those features entering the core domain model.

## 1. Who owns what

| Concern | Owner |
|---|---|
| Which run to start, with what brief | Sergeant's reasoning |
| The run record, budget slice, credential grant, liveness polling, accounting | deterministic core (RunManager) |
| Launching, messaging, resuming, stopping, cleaning up | runner adapter |
| Workspace, clones, branches, caches, subagents | the agent inside the run, within limits the adapter sets |
| Provider accounts, quota, subscription profiles | runner adapter (S1's ADR-0036 account selection moves here) |

Nothing in Sergeant's core references a PID, container id, tmux pane, session file, or provider API.
Those live only in adapters and inside `RunHandle.opaque`.

## 2. The contract

```
interface Runner {
  adapter: string                                   // "claude-code-local", "codex-local", "cloud-…", "fake"
  capabilities(profile) -> RunnerCapabilities       // 01; static per profile

  start(spec: RunSpec) -> RunHandle                 // idempotent on spec.runId
  status(handle) -> RunStatus                       // throws StatusUnavailable when it cannot answer
  cancel(handle, reason) -> void                    // idempotent
  result(handle) -> RunResult                       // valid once status is terminal

  send?(handle, message: { id: MessageId, text }) -> delivered | queued    // messaging or resume
  list?(filter: { taskId? }) -> [{ runId, handle, state }]                // list
}
```

Optional capabilities and how reasoning uses them:

| Capability | Enables | If absent |
|---|---|---|
| `liveUsage` | BudgetMeter sees spend while the run is going and can stop it at the budget | spend is known when the run ends; the wall-clock limit is the backstop |
| `messaging` | `send_run` reaches a running worker | reasoning waits for the run to end, then continues it or starts a successor with the message in its brief |
| `resume` | a waiting or finished worker continues in its own session (`start_worker(continueFrom)`) | the successor starts fresh from pushed branches and the handoff |
| `freshSubagents` | the **adapter** launches a fresh-context subagent and attests its session; used for review telemetry only (06 §5) | worker-written subagent reports are recorded as unattested |
| `list` | orphan runs can be found after a lost start or a lost ledger | an operator finds them by hand |
| `nativeCloud` | execution off the Sergeant host | runs in the host's runner zone |
| `providerReview` | the provider's own review feature, measured like any reviewer | ordinary reviewer runs |

Capabilities appear in the Situation Report, so reasoning can, for example, prefer a resumable profile
for a long task. `Run`, `RunStatus`, and reports look the same for every adapter.

## 3. Operations

### `start(spec) -> RunHandle`

- **Inputs**: `RunSpec` (01): `runId`, role, the rendered brief, profile, the task's repositories, the
  credential grant, limits, optional `resume`.
- **Output**: a `RunHandle`.
- **Side effects**: creates the run's workspace, installs the credential helper (§9), writes the brief
  where the agent reads it, launches the agent.
- **Failure**: throws `StartFailed(detail)` when nothing was launched. If unsure whether it launched (a
  cloud API timeout), it returns a handle and lets `status` answer.
- **Idempotency**: a second `start` with the same `runId` returns the existing handle and launches
  nothing (a launch record keyed by `runId` written before launching, S1 ADR-0040's record-first
  pattern, or a provider tag looked up first). This is the one runner effect whose duplication would
  matter: two workers on one task.

### `status(handle) -> RunStatus`

- **Output**: `state`, `lastActivityAt`, optional `usage`, `progress`, `waitingFor`, `failure`.
- **Lost** means known gone: `failed(lost)` only when the adapter can see the run no longer exists and
  produced no result (its process or container is absent; the provider says it terminated).
- **Failure**: throws `StatusUnavailable` when it cannot tell (network, provider API down, timeout). That
  is **unknown**, not loss.
- **Idempotency**: pure read.

### `send(handle, message) -> delivered | queued`

- **Precondition**: `messaging` (running runs) or `resume` (waiting runs).
- At-least-once delivery at the agent's next turn boundary; the agent lists acted-on ids in
  `acknowledgedMessages`. Duplicate ids are ignored. Errors: `NotRunning`, `Unsupported`.

### `cancel(handle, reason)`

- Ask the agent to stop (a short grace to push work in progress), then stop it hard, then clean up its
  processes (S1's UNF-645 "survivor processes" is the adapter's to prevent). Canceling a terminal run is
  a no-op. A cancel that cannot reach the run is retried by RunManager (§6).

### `result(handle) -> RunResult`

- Final state, the raw report document, final usage, a redacted transcript reference, failure. Pure read.

### `list(filter) -> runs` (optional)

- Enumerates the adapter's runs by `runId` tag, including ones the ledger does not know.

## 4. Run states

```
starting  ─► running ─► succeeded | failed | canceled
               │  ▲
               ▼  │ send / continue (resume)
             waiting
```

`statusUnknownSince` and `cancelRequestedAt` on the run row are not states. The first records that the
runner cannot currently answer; the second that Sergeant has asked the run to stop.

`waiting` exists only for adapters that can resume. Elsewhere, a worker with a question ends with
`outcome: needs_decision`, and reasoning continues it or starts a successor once it has the answer.

## 5. Reports

The **report document** (05, 06) is the run's deliverable. Format is fixed; transport is the adapter's:
a file at the workspace root read at the end, the agent's final message for cloud agents, or
`POST /runner/v1/runs/:id/report` (11 §4). A run may submit its report more than once while it runs
(each submission is a new revision in S3); the revision current when the run becomes terminal is final.
RunManager parses each revision (05 §6). A missing or unparseable report is recorded as such; the run is
still `succeeded`, and reasoning decides what to do.

## 6. Liveness, unknown status, and loss

RunManager reconciles every non-terminal run every `runners.reconcileSeconds` (default 60), and at
startup:

```
RunManager.reconcile(run)                                 // owner: deterministic core
  try st = runner(run.adapter).status(run.handle)
  catch StatusUnavailable:
    run.statusUnknownSince ?= now
    if run.cancelRequestedAt: try runner.cancel(run.handle)            // keep trying to stop it
    if now - run.statusUnknownSince > runners.idleTimeoutSeconds: append WakeReason(run_changed, "unreachable") once
    return                                                // never marks the run lost
  run.statusUnknownSince = null; run.lastCheckedAt = now
  update run from st (status, usage (monotone), progress, waitingFor, lastActivityAt)
  if run.cancelRequestedAt and st.state is not terminal: runner.cancel(run.handle)   // retry until it stops
  if st.state is terminal and the final report is not stored:
    res = runner.result(run.handle); store report + transcript ref; parse report
  if st.state == running and now - st.lastActivityAt > runners.idleTimeoutSeconds:
    append WakeReason(run_changed, "idle") once per idle episode        // a fact; reasoning decides
  if st.state == running and now - run.startedAt > run.limits.maxWallSeconds:
    cancel(run, "wall_timeout")                                          // deterministic
  if run status changed: append WakeReason(run_changed)
  if run is now terminal: its run token stops working; GitHub tokens the daemon still holds for it are revoked

on startup, for runs with status = starting and no handle:
  if the adapter has `list` and finds runId: adopt that handle
  else: start(spec) again (idempotent); if the brief artifact is missing, fail(start_failed)
```

- **Unknown is not death** (F04). An unreachable run stays non-terminal. Sergeant keeps retrying status,
  and keeps retrying cancellation once one was requested. Nothing replaces it automatically.
- **Replacing an unreachable worker** is reasoning's decision: it requests cancellation, and may then
  start a successor (R1 allows it once cancellation is requested). If the old worker was in fact still
  running, some work is duplicated. That is accepted; there are no leases.
- **Death** (`failed(lost)`, known to the adapter) wakes reasoning, which usually starts a successor from
  whatever was pushed (P4).
- **Stuck or distracted**: idleness is a fact; reasoning decides whether to nudge, redirect, or cancel.
  Wall-time overruns are canceled deterministically.
- **Daemon restart**: runs survive it (they live outside the daemon's process tree and cgroup, ADR-0040's
  lesson); `reconcile` re-adopts them.

## 7. Usage and spend

- Adapters report `Usage` with `costBasis`: `billed`, `estimated` (tokens × profile pricing), or
  `unknown`. Subscription-backed runs report `estimated` from tokens.
- With `liveUsage`, BudgetMeter stops runs when the task's cost budget is exhausted (overshoot about one
  reconcile interval of spend). Without it, cost is known when the run ends, and the wall-clock limit is
  the hard backstop.
- Spend is **best-effort** (captain, 2026-10-02). Dev/stage resources a worker creates, CI minutes it
  triggers, and tools with their own billing are outside it (09 §9).

## 8. Workspace model

- Each run gets a fresh, disposable workspace. Nothing in it survives the run except what the agent
  pushed.
- The workspace starts empty or with shallow clones of repositories the brief names. The agent clones
  others from its repository set as needed. A worker may change any repository in the set and open one
  PR per repository (or more if it judges that right). Multi-repo work is ordinary.
- **Continuity between runs comes from pushed branches** plus the previous report's `handoff`. Worker
  rule 3 (05 §3) requires pushing work in progress regularly and before stopping.
- Caches (bare repositories, build caches) are an adapter optimization on the data volume, capped and
  pruned (UNF-699). Never correctness-bearing.
- The agent's own subagents run with the same workspace and credentials. Sergeant neither sees nor
  manages them.

## 9. The runner zone and credentials

All runs execute in one **runner zone** that is separate from Sergeant's control plane (09 §2–4): on
the Sergeant host, a separate OS user (optionally containers) that cannot read the daemon's files,
environment, or instance role; on a laptop, a container; in the cloud, the provider's sandbox. Runs in
the zone are **not** isolated from each other: per-task isolation is not a Sergeant 2 requirement, and
fresh-context review is independence of reasoning, not an OS privilege boundary (captain, 2026-10-02).

Credentials are vended per run through `/runner/v1/runs/:id/credentials/...` (11 §4), authenticated by the
run token placed in the run's workspace:

- **GitHub**: one-hour installation tokens of the **worker App**, scoped to the task's current repository
  set; `contents: write`, `pull_requests: write`, `checks: read`, `actions: read` for workers. Reviewers
  get none: the host checks out a reviewer's PRs with a read-only token that never enters the run.
  Scoping keeps each run pointed at its repositories; it is not a boundary against another co-resident
  run.
- **AWS dev/stage**: short STS sessions for `aws.runnerDevRoleArn`, exposed as a `credential_process`.
  Reviewers get none.
- **Model credentials**: supplied by the adapter.
- **Environment**: an explicit allow-list (UNF-650); no `SERGEANT_*` control-plane variable ever.
- **When a run ends**: its run token stops working; GitHub tokens the daemon still holds are revoked;
  anything else expires within an hour.

**Cloud adapters**: a provider identity used for workers must not hold production or admin authority,
must not be able to bypass default-branch rulesets, and must be limited to the installation's enrolled
repositories. That is the hard boundary (09 §3). Per-task scoping is not required.

This is not a capability broker: every worker gets the same development authority.

## 10. Adapters

| Adapter | Execution | Expected capabilities | Notes |
|---|---|---|---|
| `claude-code-local` | Claude Code headless in the runner zone on the Sergeant host (or in a container on the captain's laptop during the trial) | liveUsage (token counts × pricing), messaging (a steering file read at turn boundaries, modeled on Firstmate's inbox), resume, freshSubagents, list | first adapter; subscription profiles and account selection inside it |
| `codex-local` | Codex CLI (`codex exec`) in the same zone | usage reporting (tokens; `costBasis: estimated` at a configured list price, TECH-5021) | second adapter; a different-provider reviewer (built, TECH-5009) |
| `cloud-…` | provider cloud agents | varies | allowed when its identity meets §9's hard boundary |
| `fake` | in-process script | all, configurable | tests only; never launches real processes (S1 UNF-383) |

**`codex-local` (TECH-5009; resolves V6).** Installation config picks the adapter per role
(`runners.worker`, `runners.reviewer`); a role not named runs `claude-code-local`. A Codex run uses the
same container, workspace, worker-App token, git identity, and network as a Claude Code run; only the
model credential differs (the task owner's registered Codex account, in place of their Claude
account; TECH-5179, TECH-5184). Checked against Codex CLI 0.160.0:

- **Usage**: `codex exec --json` reports tokens per turn (`turn.completed.usage`: input, cached input,
  output, reasoning output) and no dollar figure. The run record keeps the summed tokens and, when
  the run's model has a price, `costUsd` with `costBasis: estimated` (TECH-5021): the tokens times
  OpenAI's published API list price for the model (`packages/runner/src/codex-prices.ts`; the
  config's `codex.prices` adds to or replaces it). That is the same "what the API would charge" basis
  Claude Code reports, so both count alike against the budget. It is a runaway guard, not accounting:
  standard tier, short context, no per-account subscription math. A model with no price keeps no
  `costUsd`, and the budget counts it as unknown. Codex has no spend cap like `--max-budget-usd`, so
  the wall-time limit is still a Codex run's only hard backstop; an estimated cost stops further runs
  once the budget is spent.
- **Resume**: the CLI supports it (`codex exec resume <thread id>`), but its sessions live in the run's
  container, which is removed when the run ends, and the local runner resumes neither adapter. The
  fallback is a fresh run from pushed branches and the earlier runs' reports in the brief (05 §2), as
  for Claude Code here. The thread id is kept in the run's `agent.json` for a future `resume`.

**Provider by quota (TECH-5117).** With both credentials configured, the runner picks each run's
adapter right before launch from each provider's live quota (weekly and 5-hour percent left), by
deterministic code: the worker gets the best-paced account (the model accounts paragraph below); the
reviewer gets the other provider than its worker's when that provider's best scores within 20% of the best. An
unknown reading keeps the `runners` default, so a quota read never blocks a launch. The run record's
`providerChoice` keeps the choice and the readings behind it.

**Model accounts (TECH-5179, replacing TECH-5113's shared pool).** Every run carries its task's owner
(`RunSpec.owner`: the issue's human assignee, admitted only when Linear's history shows that person
delegated it, 07 §5) and runs only on an account that person registered through `/v1/accounts`, never
the installation's credentials or anyone else's. Among the owner's usable accounts the runner takes,
by one rule (TECH-5213), the one with the highest pace: for each window, percent left over percent of
the window's time left (from its reset and nominal length, counted as at least one hour's share: 20%
of the 5-hour window, about 0.6% of the week), and the lower of the two windows' paces. Above 1 the
quota would expire unused; below 1 it runs out before its reset. One whose quota could not be read,
or has a window without a reset time, ranks after every scored one. A reviewer takes an account of
another provider than its worker's when that provider's best scores within 20% of the best (the
provider choice above), else the best overall. Nothing is remembered between launches: no burn
history, stickiness, or round-robin. No low-quota warning is posted. A run that fails
on the account's quota or authentication (`failureReason`) sets the account aside for an hour, or until the window it ran out of resets if sooner, in
memory. That window is the one at 0% in the account's quota read again, past the cache, as the run fails; with none
known to be at 0% (an unreadable reading), the hour. Meanwhile the next launch takes another of the owner's. An owner with no account, or none usable, gets `NoModelAccount` from `start`, which
starts nothing; the core then asks the owner on the issue, as a question (07 §4), to register or fix one
and reply: one question per wait, and the reply opens a fresh budget window in which the launch is tried
again (TECH-5217). The run record's `account` says whose
subscription paid, never the credential.

An adapter may wrap a tiny native helper (for example a Rust binary that owns process groups and clean
termination) if OS process handling genuinely needs one. Sergeant itself stays TypeScript.

## 11. RunManager.start (core side)

```
RunManager.start(task, role, brief, profile, limits, trigger?, continueFrom?) -> Run
  runId = newId("run")
  token = newRunToken()
  Ledger.insertRun(runId, task, role, profile, briefRef: S3.put(brief), limits, status: starting,
                   credentialTokenHash: hash(token), reviewTrigger: trigger,
                   briefConversationRevision: brief.task.conversationRevision)
  spec = RunSpec(runId, …, repositories: expand(task.repositories), credentials: grant(token, role))
  if continueFrom: spec.resume = Ledger.run(continueFrom).handle         // profile must have `resume`
  try handle = runner(profile.adapter).start(spec)
  catch StartFailed(e): Ledger.failRun(runId, start_failed, e); throw
  Ledger.setHandle(runId, handle, status: running)
  return run
```

Owned by the deterministic core; called by the Effector for `start_worker` and `start_reviewer`, and by the
audit guardrail (06 §8). Idempotent on `runId`.

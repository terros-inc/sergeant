# Ledger export and budget-window analysis (TECH-5922)

Two read-only tools for answering *where a task's budget window actually goes* — active work versus
waiting on people, CI, or rate limits — and *whether the wall-time window is too short*. They read
files only. They touch no live service and change no runtime behaviour.

> **No stored ledger.** Sergeant keeps no billing ledger or events table. `docs/design/02-persistence.md`
> describes an aspirational SQLite ledger that was never built. The durable store is per-task JSON on
> the daemon's data volume. "Budget events" (window opens, exhaustion) are recomputed every poll and
> never recorded, so the export reconstructs them from each turn's own budget snapshot.

## 1. Export (operator runs this on the Sergeant host)

Run it from the repository checkout on the host, against the same `--state-dir` `serve` uses
(`$SERGEANT_STATE_DIR` below — substitute the real directory; it holds `tasks/` and `runs/`). Node is
the version in `.nvmrc`; it runs the TypeScript entry directly.

```sh
node packages/sergeant/src/ledger-export-cli.ts \
  --state-dir "$SERGEANT_STATE_DIR" \
  --since 2026-09-29 --until 2026-10-12 \
  --out sergeant-ledger-2026-09-29_2026-10-12.jsonl
```

- `--since` / `--until` are calendar dates in **UTC**; `--until` is **inclusive of its whole day**.
- A task directory is exported only if it has at least one turn whose completion time falls in range.
- `--out` writes JSON Lines; omit it to stream to stdout.

**Attach the output** (`sergeant-ledger-2026-09-29_2026-10-12.jsonl`) to **TECH-5922** as a file. It
may contain issue identifiers, PR numbers, model/provider names, and turn summaries, so treat it as
installation-internal: attach it to the Linear issue, do not commit it to this public repository.

### What it reads

| Source | Fields used |
|---|---|
| `<stateDir>/tasks/<ISSUE-ID>/state.json` | `issueId`, `startedAt`, `budget.{window,since,priorRuns}`, `unblockedAt`, `turns`, `turnCostUsd`, `runIds`, `repositories`, `blockedBy`, `merged`, `accepted` |
| `<stateDir>/tasks/<ISSUE-ID>/turns.jsonl` | per turn: `at`, `situation.budget`, `situation.runs`, `situation.pullRequests`, `situation.conversation`, `turn.costUsd`, `turn.output.summary`, `outcomes[].action.kind` |
| `<stateDir>/tasks/<ISSUE-ID>/{stopped,cancel}.json` | `at`, `reason` |
| `<stateDir>/runs/<runId>/run.json` (RunMeta) | `role`, `startedAt`, `provider`, `model` |
| `<stateDir>/runs/<runId>/record.json` (RunRecord) + its mtime | `status`, `costUsd`, `costBasis`, `failureReason`, `reportProblem`; mtime as the end-time proxy |

## 2. Format (JSON Lines)

One JSON object per line; `type` discriminates. **Times are ISO-8601**: UTC (trailing `Z`) for
Sergeant-stamped fields, with an offset for Linear-sourced ones (e.g. comment-derived window starts).
Durations the analysis derives are **seconds**; costs are **USD**. Schemas are `TaskExport`,
`TurnExport`, `RunExport` in `packages/sergeant/src/ledger-export.ts`.

- **`task`** — one per exported task: `issueId`, `startedAt` (first window start), `window`
  `{wallMinutes,costUsd}`, `since?` (current window start if reopened, TECH-5059), `priorRuns[]`,
  `unblockedAt[]` (each fresh window an unblock opened, TECH-5803), `turns`, `turnCostUsd`, `runIds[]`,
  `repositories[]`, `blockedBy?`, `merged?`, `accepted?`, `stopped?`, `canceled?`.
- **`turn`** — one per in-range `turns.jsonl` line: `at` (turn completion — the loop records **no turn
  start**), `window`, `windowStart` (turns sharing one are the same window), `wallDeadline`, `spentUsd`,
  `costLimitUsd`, `unknownCostRuns`, `exhausted` (`checkBudget` at `at`), `exhaustedReason?`, `runs[]`
  (`{runId,role,status}` as the snapshot saw them — RunRecord carries no timestamps), `runningCount`,
  `waitingOnHumanQuestion`, `waitingOnHumanPr` (string or null), `waitingOnCi`, `runQuotaFailure`,
  `actions[]`, `turnCostUsd`, `turnSummary`, `signalsComputed` (false when the snapshot shape did not
  parse and the human-wait signals were skipped).
- **`run`** — one per run referenced by a task or a turn: `runId`, `issueId`, `role`, `status`,
  `startedAt?` (the only authoritative run start), `recordWrittenAt?` (record.json mtime, the end
  proxy), `costUsd?`, `costBasis?`, `failureReason?`, `reportProblem?`, `provider?`, `model?`,
  `prior` (belongs to an earlier window).

## 3. Analysis

```sh
node packages/sergeant/src/budget-analysis-cli.ts --in sergeant-ledger-2026-09-29_2026-10-12.jsonl
```

Prints a JSON report (`report()` in `packages/sergeant/src/budget-analysis.ts`). Per budget window it
reconstructs the window from the turn snapshots and splits the elapsed wall time into **active run**,
**waiting on a human** (open question, PR review, or merge handoff), **waiting on CI**, **waiting on
rate limits**, and **idle/other**, then reports, over the windows that **ended exhausted**: the span
and each category as **total / median / p90**; how many ended with a run still in flight and how many
of those runs were canceled; how many were extended (a human reply opened a fresh window) versus
terminal; run-duration distribution and how many ran the full window; and the fresh-window trigger
counts (admission / unblock / human — TECH-5803, TECH-5218/5913, TECH-5059).

### Measurement limits (read before quoting numbers)

- **The configured window is not in the code.** `DEFAULT_BUDGET` is 120 minutes; the 30-minute window
  is an installation/per-repo override (`windowFor`, TECH-5219). The analysis reads each window's own
  `wallMinutes`, so it is correct whatever the installation configures.
- **Sergeant turn (reasoning) time cannot be separated out.** The loop records only each turn's
  completion time, so turn compute time is folded into the preceding segment. The report gives the
  turn count instead. Separating it would require recording turn start times (a follow-up, not this
  issue).
- **Window time is observed only at turn boundaries**; each gap is attributed to the snapshot that
  opened it. Sub-turn transitions are invisible.
- **Runs carry no end time**; durations use record.json's mtime as the end proxy.
- **"Canceled at window end" is not a stored flag.** A run cut off by exhaustion and one a human
  cancelled both land as `status: "canceled"`; the analysis infers the former from a run still
  `running` at an exhausted window's last turn.
- **Concurrency/slot waits** are not in the per-task files (they live in `serve` logs), so
  `waiting_rate_limit` covers only runs that ended with `failureReason: quota`.

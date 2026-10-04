# 11 — APIs and CLI

Contracts, not implementation syntax. Every endpoint lists inputs, outputs, side effects, failure,
idempotency, and owner where it matters. All APIs are versioned under `/v1` (runner API under
`/runner/v1`); briefs and reports carry their own versions (05, 06).

## 1. Surfaces

| Surface | Who calls it | Authentication | Where it listens |
|---|---|---|---|
| Internal API | operator `sgt admin` commands (over SSM, ADR-0027), operators on the host | host access | loopback |
| Public API | `sgt` for humans, including approvers' `sgt admin restart`, `update`, and `status` (TECH-5195) | Linear OAuth bearer (ADR-0024/0028) | optional public listener; routes are a subset of the internal API |
| Webhooks | Linear, GitHub | provider signatures | public listener |
| Runner API | runner adapters and the agents inside runs | run token | loopback (local adapters); not exposed for cloud adapters (§4) |
| Sergeant's tools | Sergeant's reasoning | in-process | — (03 §4) |
| MCP | other agents (ChatGPT, Firstmate) | host access, like the internal API | stdio, a read-only client of `/v1` (TECH-4940): `task_list`, `task_show`, `run_list`, `run_show`, `run_report`, `health` |

## 2. Internal and public API

| Endpoint | Inputs → outputs | Side effects | Public? | Notes |
|---|---|---|---|---|
| `GET /health` | → `{ ok, version, paused, draining }` | — | yes | |
| `GET /health/loops` | → per-loop last tick and status | — | no | deploy gate (S1 UNF-555/556, kept) |
| `GET /v1/tasks` | `status?, queued?, closed?` → task summaries | — | yes | `queued` lists delegated issues not yet admitted, with the reason (07 §5) |
| `GET /v1/tasks/:ref` | identifier or id → task, derived status, human wait, repositories, budget status, linked PRs (from Linear), runs, last 5 turn summaries | live reads | yes | |
| `GET /v1/tasks/:ref/audit` | → `AuditEvent[]` | — | yes | |
| `GET /v1/turns/:id` | → turn, decision, Situation Report link | — | approvers | |
| `GET /v1/runs/:id` | → run, report summary | — | yes | |
| `GET /v1/runs/:id/report` | → raw report Markdown | — | yes | |
| `GET /v1/runs/:id/transcript` | → redacted transcript link | — | approvers | |
| `POST /v1/tasks/:ref/wake` | `reason?` → `{ wakeAt }` | appends `human_cli` wake reason | team members | idempotent enough: a duplicate wake coalesces |
| `POST /v1/tasks/:ref/cancel` | `reason` → `{ closed }` | `cancel_task` closing action: cancels runs, removes delegation, posts one line, closes the task last (03 §10) | team members | key `close:<taskId>`, shared by every closing action so a task has at most one |
| `POST /v1/runs/:id/cancel` | `reason` → status | `cancel_run` action (actor human) | team members | key `cancel:<runId>` |
| `GET /v1/accounts` | → model accounts (never credentials), whose, and the runs each paid for | — | yes | TECH-5113 |
| `POST /v1/accounts/register` | `provider` (`claude` or `codex`), `name`, `credential` → account, quota read with it, and a `notice` that the credential is exposed to worker containers, and how to remove and revoke it (09 §3a) | stores the caller's own account in the registered-accounts secret, replacing theirs of that name | team members, as themselves | one per person and name (TECH-5196) |
| `POST /v1/accounts/remove` | `name` → `removed`, and when removed a `notice` that removal does not revoke a copy and where to revoke it with the provider (09 §3a, TECH-5198) | removes the caller's own account of that name | team members, as themselves | idempotent |
| `GET /v1/admin/status` | → this `serve`'s version and start time, the release `sergeant-update` last checked out, a request the host has not taken, and the host's latest restart or update outcome | — | approvers | TECH-5195; 404 off the Sergeant host |
| `POST /v1/admin/restart` | → the request (`id`, `by`, `at`) | leaves one request file for the host (below); the host reruns `sergeant-update` on its current release, rereading the installation config, and restarts `serve` gracefully | approvers | one action at a time: `409` while a request waits or the latest outcome is running |
| `POST /v1/admin/update` | `ref?` → the request | as restart, to `ref` (a commit on `main` whose `v2` check passed) or, without one, what the release channel would choose; a failed install reinstalls the previous release | approvers | as restart |
| `POST /v1/pause` / `POST /v1/resume` | `reason` → state | writes `system_state.pause`; audit action | approvers | resume of a pause is idempotent |
| `POST /v1/drain`, `POST /v1/drain/cancel` | owned drain token (ADR-0040, kept) | stop starting turns and runs; ready when no start or turn is mid-flight | no | deploys quiesce in seconds; runs survive restarts |
| `GET /v1/review-quality` | `since?, by?` → metrics (06 §9) | — | yes | |

Failures return a typed error (`not_found`, `forbidden`, `gate_denied{rule, reason}`, `unavailable`).
Every call that changes durable state or an external system is one action through the Gate; closing
actions have ordered steps and are re-driven until complete (03 §10), so a failure can leave them
pending, never half-forgotten. Drain and undrain are process-local controls, not actions.

**Restart and update (TECH-5195).** `serve` runs nothing privileged for `/v1/admin`: it checks the
caller is an approver, logs who asked, and creates one request file in its state directory
atomically. The host's root automatic-update service (`deploy/host/sergeant-autoupdate.sh`, started by
a systemd path unit and by its timer, never both at once) takes the request, validates it again,
resolves and checks the ref against GitHub, and runs the same `sergeant-update` an automatic update
does, with the same rollback and `autoupdate-failed` handling. It writes the outcome (who asked, the
reason, and on failure the update's last output) to a root-owned result file that `GET
/v1/admin/status` reads back; `sgt admin restart` and `update` wait on it. No person needs AWS
access, and the instance role is unchanged. These are host operations, not Gate actions.

**Client versions (TECH-5185).** There is no compatibility between versions of `sgt` (or `sgt-mcp`)
and the hosted `serve`: people keep their CLI current. Every client request names the client's own
version in `Sergeant-Cli-Version`, and `serve` refuses a `/v1` request that names none, one that is
not exactly `MAJOR.MINOR.PATCH` (optionally `+<sha>`), or one older than the oldest client it
supports (`MIN_CLI_VERSION`, `packages/contracts/src/min-cli.ts`), with
`400` and "Your sgt is older than this Sergeant server supports. Run `sgt update`." before
authentication, body parsing, or routing (TECH-5188), so a too-old client changes nothing. `sgt
update` needs no API: it fast-forwards its checkout to `main` and runs `pnpm install`. Every `/v1`
answer also carries `Sergeant-Min-Cli-Version`, that oldest supported client. A client whose own
minimum is above the server's, or whose server sends none, is newer than the server across a breaking
change, and `sgt` warns once. A change an older client cannot work with (a removed, retyped, or newly
required field, a new enum value) raises the minimum in the same change; response schemas are not
otherwise made tolerant of a missing field.

## 3. Webhooks

| Endpoint | Verified by | Effect |
|---|---|---|
| `POST /webhooks/linear` | Linear signature | intake (delegation, undelegation, state changes) or a wake reason (comments, edits, relations, attachments, labels). Nothing else |
| `POST /webhooks/github` | GitHub signature | a wake reason for the task owning the PR (08 §9). Unknown PRs are dropped |

Webhook handlers are idempotent: they only append wake reasons or trigger an intake check, both of
which coalesce. Reconcile polls make missed webhooks harmless.

## 4. Runner API

Authenticated with the run token (`Authorization: Bearer <runToken>`). Every call is refused once
the run is terminal, which is how cancellation ends a run's authority.

| Endpoint | Inputs → outputs | Side effects | Idempotency |
|---|---|---|---|
| `GET /runner/v1/runs/:id/credentials/github` | → `{ token, expiresAt, repositories, permissions }` | mints a worker App token scoped to the task's current repository set (read-only for reviewers); records the token for revocation | each call mints a fresh token; callers cache until near expiry |
| `GET /runner/v1/runs/:id/credentials/aws` | → `credential_process` JSON | short STS session for the runner dev role (workers only) | same |
| `POST /runner/v1/runs/:id/progress` | `{ text, attention? }` | updates `runs.progress`; `attention` wakes Sergeant | last write wins |
| `POST /runner/v1/runs/:id/report` | report Markdown | stores it as a new revision and parses it (05 §6); wakes Sergeant | each call is a new revision until the run is terminal; the last one then is final |
| `GET /runner/v1/runs/:id/messages` | `after?` → messages | — | for adapters that implement `messaging` by polling; ids make delivery idempotent |

Every runner-API call is authenticated by the run token and refused once the run is terminal, which is
how ending a run ends its authority. Cloud adapters whose agents run off-host usually authenticate to
GitHub through the provider's own integration and report through the provider's API. Their identity
must hold no production or admin authority, be limited to enrolled repositories, and not bypass
default-branch rulesets (04 §9); that is checked when the profile is configured.

## 5. Background loops

Each is supervised and reported by `/health/loops` (S1 UNF-555, kept).

| Loop | Cadence | Does |
|---|---|---|
| intake | webhooks + every 2 min | admit, close on undelegation/cancel/Done, wake on Linear changes, including a conversation revision that differs from the last completed turn's (07 §5, §8; 03 §5) |
| github-reconcile | webhooks + every 5 min | refresh linked-PR facts; wake owners on change |
| run-reconcile | every 60 s | `RunManager.reconcile` for non-terminal runs (04 §6) |
| budget-meter | every 60 s | compute `BudgetStatus`; wake on soft/exhausted; `enforce_budget` (§6) |
| scheduler | continuous | start due turns within concurrency (03 §2) |
| review-quality export | daily | write metrics to S3 and CloudWatch (06 §9) |

Startup runs the sequence in 02 §8 before the loops start.

## 6. Guardrail actions

Performed by the deterministic core, recorded as actions with `actor = guardrail`:

```
admit_task(issue)            intake: create task row (07 §5)                         key admit:<issue>:<observedAt>
close_task(task, as, reason) intake: ordered closing steps (03 §10)                    key close:<taskId>
link_pr(task, pr)            after a worker report names a PR it opened (08 §4)        key link:<taskId>:<repo>#<n>
start_reviewer(audit)        after a sampled not_required disposition (06 §8)         key start:<runId>
enforce_budget(task)         at exhaustion: send "wrap up: push and report within
                             wrapUpGraceSeconds" to active runs; after the grace,
                             cancel them (failure.kind = budget)                       key budget:<taskId>:<exhaustedSince>
budget fallback comment      if no turn produced the ask within 10 min of exhaustion   key comment:<taskId>:budget:<exhaustedSince>
```

## 7. CLI

Human commands use the human's Linear login, and so do approvers' `sgt admin restart`, `update`,
and `status` (TECH-5195). The other installation admin commands use AWS credentials for the
installation (unchanged from S1).

```
sgt login | logout | whoami                          # unchanged (ADR-0024)

sgt task list [--queued] [--closed]                  # what Sergeant is doing and waiting on
sgt task show <UNF-123 | tsk_…>                      # status, human wait, repos, budget, PRs, runs, recent turns
sgt task audit <ref>                                 # AuditEvent timeline
sgt task wake <ref> [--reason]                       # take a turn now
sgt task cancel <ref> --reason "…"                   # stop; removes delegation

sgt run list [--task <ref>] | show <run> | report <run> | transcript <run> | cancel <run>
sgt account list | register <claude|codex> [--name <name>] | remove <name>

sgt review quality [--since 30d] [--by category|provider|mode]

sgt pause --reason "…" | sgt resume                  # approvers
sgt admin restart | update [<ref>] | status          # approvers: restart or update the host, wait for the outcome

# installation administration (AWS credentials), unchanged mechanisms
sgt init <installation> [--bootstrap | --check]
sgt config show | diff | set <installation> …
sgt config repo add | set | enable | disable | remove | list <installation> …
sgt config claude-profile <installation> <name>      # token on stdin
sgt doctor [repo <slug>]
sgt admin health | logs | exec | drain | undrain <installation>
```

Hosts update themselves from green commits of `main` (10 §6); `sgt admin update` moves one sooner,
or pins it, through the same `sergeant-update` (§2).

Removed from S1: `sgt tool …` (capability/tool authorization), phase, wait, all grant commands,
repo-scope, fresh-run, retry, rethink, decision-answer commands, and safety governor views. Budget
continuation happens through a human answer to Sergeant's question, which opens a fresh wall-time and
money window; `sgt task show` absorbs what an operator needs to see.

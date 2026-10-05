# Sergeant

<img src="docs/assets/sergeant-logo.png" alt="Sergeant logo" width="160" />

Sergeant supervises AI engineering work. A Linear issue delegated to Sergeant becomes merged code
or a clear question back on the issue, without a human driving each step: Sergeant's reasoning
reads the issue, GitHub, and run state; briefs one primary worker to do the engineering; starts a
separate fresh-context reviewer when the change warrants it; asks a human only for genuine
judgment; and merges through a deterministic Gate.

**New to Sergeant?** [`docs/onboarding.md`](docs/onboarding.md) takes you from nothing to an issue
Sergeant is working on: install `sgt`, sign in, register your model account, and delegate.

This is Sergeant 2, a TypeScript workspace (pnpm, Turborepo, oxlint, Vitest). It is currently a
walking skeleton:

| Package | What it is |
|---|---|
| `packages/contracts` (`@terros/sergeant-contracts`) | Zod schemas for the conversation, Situation Report, run reports, proposed actions, and PR facts; the ports adapters implement; the pure merge Gate |
| `packages/reasoning` (`@terros/sergeant-reasoning`) | One fresh-context reasoning turn through the local `claude` CLI: Situation Report in, validated proposed actions out |
| `packages/linear`, `packages/github` (`@terros/sergeant-linear`, `-github`) | Live Linear and GitHub adapters (UNF-704), and GitHub App installation tokens for the control-plane and worker Apps (UNF-720) |
| `packages/runner` (`@terros/sergeant-runner`) | Local primary worker and fresh-context reviewer (UNF-705) |
| `packages/sergeant` (`@terros/sergeant`) | The app: executes proposed actions through the Gate against the ports, and the polling loop for one explicitly selected, V2-delegated issue that files follow-up issues, can ask a human and wait for the reply, posts one outcome comment after the merge, records review telemetry and audits a sample of skipped reviews, and stays within a task budget (UNF-706, UNF-724, UNF-727, UNF-728, UNF-729, UNF-730); and the long-running service that runs that loop for every delegated issue (UNF-719), with its client API (UNF-713) for Linear-authenticated callers (TECH-4938) |
| `packages/cli` (`@terros/sergeant-cli`) | `sgt`, a thin client of that API (UNF-714), with `sgt login` through Linear (TECH-4938) |
| `packages/mcp` (`@terros/sergeant-mcp`) | `sgt-mcp`, a read-only MCP server over stdio, another thin client of that API (TECH-4940) |

The architecture is designed in pseudocode in [`docs/design/`](docs/design/README.md) (draft 3).
Code here implements only the parts a ticket asks for. [`AGENTS.md`](AGENTS.md) is the guide for
agents and contributors.

## Commands

Requires Node.js 24 LTS (`.nvmrc`) and pnpm (pinned via `packageManager`;
`corepack enable`). Run from the repository root:

```sh
pnpm install     # install dependencies
pnpm exec turbo boundaries   # one-way package dependencies
pnpm lint        # turbo run lint      (oxlint)
pnpm typecheck   # turbo run typecheck (tsc, strict)
pnpm test        # turbo run test      (vitest)
```

CI ([`.github/workflows/v2.yml`](.github/workflows/v2.yml)) runs the same boundaries, lint, typecheck,
and test tasks on every pull request and every push to `main`.

The live commands below are manual and never run from tests or CI. They take an installation
config file that holds identifiers and secret references only (AWS Secrets Manager ids, resolved
with the configured AWS profile and region); no credential is ever printed, and no ambient `gh`,
Linear, or Claude login is used. Its shape is `InstallationConfig` in
`packages/sergeant/src/config.ts`:

```json
{
  "secrets": { "awsRegion": "us-west-2", "awsProfile": "<profile>" },
  "linear": {
    "tokenSecret": "<V2 Linear agent token secret id>",
    "agentUserId": "<V2 agent user id>",
    "reviewerProfiles": { "github-login": "https://linear.app/<workspace>/profiles/<user>" }
  },
  "github": {
    "controlPlaneApp": { "appId": 1, "installationId": 2, "privateKeySecret": "<secret id>" },
    "workerApp": { "appId": 3, "installationId": 4, "privateKeySecret": "<secret id>" }
  },
  "repositories": { "owner/name": { "mergeMethod": "squash", "mergePolicy": "sergeant" } },
  "modelTokenSecret": "<Sergeant model token secret id>",
  "gitIdentity": { "name": "<human name>", "email": "<human email>" }
}
```

Each repository's `mergePolicy` says who merges in it (TECH-5244): `sergeant` approves and merges a
gated head; `human` never does, and a repository without one is `human`, so it fails safe. In a
`human` repository the same merge checks decide when a head is ready, and Sergeant then hands it to a
human instead: it marks the PR ready, requests review from the code owners GitHub asked or else the
issue's assignee (their Linear profile in `linear.reviewerProfiles`), posts the review summary on the
PR and the issue, and waits. A human's review or comment is feedback as always; their merge finishes
the task as Sergeant's own would. The GitHub adapter rereads the live policy before any approval or
merge call and refuses in a `human` repository whatever asked it to merge.

The Linear token must act as `agentUserId` (checked at startup); every Linear read and write uses it.
Optional `linear.otherAgentUserIds` lists other agents' users (V1's) whose comments are not human
input. Optional `linear.delegatingAppIds` lists Linear app ids (`botActor.id`), such as Linear's MCP
connector, whose delegations count as the assignee's own when the app acted for a user with the
assignee's display name; any other app's delegation is refused. Optional `linear.reviewerProfiles` maps GitHub logins to Linear profile URLs. Sergeant puts
the URL in a re-review request so Linear renders a real user mention and sends an Inbox notification;
a missing mapping or failed lookup leaves the existing plain `@github-login` text. Optional
`review.auditSampleRate` (0 to 1, default 0.2) is the fraction of merged heads that
skipped fresh review which get an audit review. Optional `budget` is the budget window a task gets
when it starts or a human answers one of its questions, for `serve` and `canary` alike: `"budget": { "minutes": 45, "usd": 10 }` (positive
numbers, each optional; unset, 120 minutes and $25; see the task budget under Commands). Optional
`maxTasks` (a positive integer, default 2) is how many task slots `serve` fills, and optional
`waitingGraceMinutes` (default 15) how long a waiting task keeps its slot; `serve
--max-tasks` and `--waiting-grace-minutes` win over them (see Intake under Commands). Optional
`linear.webhookSecret` and `github.webhookSecret` are the signing secrets of the Linear app's and the control-plane App's
webhooks; `serve` has each webhook endpoint only when its secret is set. Optional `humans` says who
may use `sgt` and the client API, each with their own Linear login (see [The `sgt` CLI](#the-sgt-cli)):
`{ "linearClientId": "<the Linear OAuth app's client id>", "teams": ["<team key>"], "approvers": ["<Linear user id>"] }`.
Optional `release` makes the host update itself to green commits of `main`: `{ "channel": "main" }`
or `{ "channel": "soaked", "soakMinutes": 90 }`, with `"paused": true` to stop (`deploy/README.md`,
Automatic updates).
Optional `runners` chooses each role's agent (TECH-5009): `{ "reviewer": "codex-local" }` runs reviewers
on the Codex CLI; a role not named runs Claude Code, as before. A `codex-local` role needs `codex`:
`{ "model": "<Codex model>" }`, which also lets people register Codex accounts; each run uses its task
owner's registered account. A Codex run's cost is estimated from its tokens at OpenAI's list price for
its model (TECH-5021); optional `codex.prices`, `{ "<model>": { "input": 1.25, "cachedInput": 0.125,
"output": 10 } }` in USD per million tokens, adds or replaces a model's price, and a model with none
counts as unknown cost ([`packages/runner/README.md`](packages/runner/README.md#codex-codex-local-tech-5009)).

The control-plane App reads PRs, checks, and branch rules, and approves then merges; it needs
contents and pull requests write, checks and commit statuses read, and metadata read. The worker App
needs contents and pull requests write, and checks and actions read. Neither may hold administration,
workflows, secrets, environments, deployments, or actions write, and the worker App must not be a
ruleset bypass actor. Contents write would let the worker App merge its own green PR, so each
repository's ruleset must require at least one approving review: GitHub never lets a PR's author
approve it, and the control-plane App submits that approval on the exact gated head only after every
Gate check passes, immediately before its SHA-guarded merge. A failed approval stops the merge.
Only the base branch's declared required checks count toward a merge (ruleset
`required_status_checks`), so a repository with none cannot be merged; a repository's
`"observedChecksFallback": true` instead treats every check observed on the exact head as required.

After the V2 identities and the repository ruleset are provisioned (UNF-720), the live check
confirms them without writing anything or spending model money, and fails if the base branch does
not require an approving review:

```sh
pnpm --filter @terros/sergeant live-check --config <file> --repo owner/name [--issue UNF-123] [--pr 45]
```

The canary loop reads and writes live Linear and GitHub, launches real model sessions, and costs
money. It works on the issue only while the issue is delegated to `agentUserId`: before anything
starts, on every poll, and again from a live read before each start, merge, and the outcome comment
(Gate rule A1), and only while it is not in Backlog, Canceled, or Done (A2, TECH-4989; Done after
Sergeant's own closing merge is the normal end). A task either runs or is stopped, and every stop
takes one path: the issue undelegated or reassigned, moved by a human to Backlog, Canceled, or Done,
or `sgt task cancel` (a reassignment is a handoff that keeps the PRs open and puts the issue back in
Todo, undelegated; TECH-5179). The stop is recorded in `<dir>/cancel.json` first, and from then on the loop
takes no turn and makes no effect: it keeps retrying each run's cancellation, and treats a run whose
status it cannot read as still running, until the runner confirms every run stopped; then it closes
the task's open PRs (only those the worker App opened) with a short comment, posts one comment on the
issue saying it stopped and which PRs it closed, and sets `state.json` aside. Nothing resumes a stopped
task: the issue delegated and in Todo again starts a fresh one, with a new budget. After the merge, the V2 agent posts one outcome comment (PR, reviewed
head, observed required checks, merge result, known gaps), keyed by the issue and the merge so a
rerun never posts it twice; Linear's GitHub integration moves the issue to Done. Workers push their branches and open PRs with a worker-App token scoped to their run's
repositories; the merge is one control-plane action: fresh exact-head PR, check, and Linear reads,
the Gate, and GitHub's SHA-guarded merge. A blocking review finding or a failed required check
wakes a turn that may start a successor worker (one at a time, R1) on the same PR; its brief carries
the PRs with their check states and every earlier run's report and findings. The fix is a new head,
so the merge again needs a fresh approving review of it or the worker's waiver for it (M6). No
turn count bounds the iterations: the budget window does (TECH-5059). This runner cannot resume a worker's session, so every
continuation is a successor. Re-running the same command resumes from `<dir>/state.json`.

Reasoning may ask a human (`ask_human`): the V2 agent posts one question comment, keyed by the issue
and the conversation revision it was asked from, and the loop then takes no turn and makes no effect
until a human comments or edits the issue. No timeout decides for the human; `STOP` or undelegation
still ends the loop. The wait is never stored locally: a restart finds the question on the issue.

A follow-up issue is only for a concrete bug, required unfinished work from the task's own scope, a
real blocker, or a current operational or security problem (TECH-5186). There is no per-task quota,
but more than one from a task is exceptional. Workers suggest them in their report's `followups`, each
with its `category` and why it meets it; everything else they noticed (what made the task harder or
slower, what could be better, whether it will recur) goes in the report's `feedback` and its short
Feedback section, and is never filed. Reviewers' `non_blocking` findings and nits never become
follow-ups, nor do theoretical edge cases, future robustness, generalized cleanup, speculative rollback
hazards, or abstraction improvements. Reasoning decides whether a suggestion deserves an issue and
proposes `create_followup` with its category, why, and a short key naming the idea; the filed issue
opens with the category and why. The V2 agent files it in the task issue's team and project, related to the issue
(or blocked by it), with no delegate or assignee, so humans triage it. Linear's client-supplied ids,
derived from `followup:<task>:<key>`, make it at most one issue and one relation per key, even across
a crash or a rerun; filed follow-ups are kept in `state.json`, shown to every later turn, and listed
in the outcome comment. The category and why are the only limit: no count caps them. The Linear token
needs permission to create issues and issue relations.

With the closing PR's merge, reasoning may give up to three short feedback lines worth keeping, from
the workers' feedback and any non-blocking review notes worth keeping. After the outcome comment,
Sergeant posts them once as a **Sergeant feedback** comment on the issue, keyed by the merge like the
outcome, and adds the `sergeant-feedback` label. A merge reasoning did not make (a human's) uses only
the closing worker's explicit feedback. An issue completed in Linear without a recognized closing merge
gets the same from the latest worker, posted once as its stop finishes (keyed by the stop) while the
issue is still delegated to Sergeant. Delivery is the comment and the label: until both succeed, the
feedback is not marked posted and the task is neither seen through nor its stop finished, so a later
pass retries, and the key keeps the comment to one. A task with nothing worth keeping ("Nothing
notable") gets neither. A retro across tasks (TECH-5187) reads these comments; no other store holds
them. The `sergeant-feedback` label must already exist (a workspace label, or one in the issue's team);
Sergeant never creates it. The Linear token also needs permission to edit issue labels.

A **Sergeant retro** (TECH-5187, `packages/sergeant/src/retro.ts`) sees across tasks what a single worker
can't. With the installation config's `retro` (the Sergeant project's Linear id and the team its issues
are filed in), serve checks hourly and runs one when about 10 tasks got a Sergeant feedback comment since
the last retro, or at most 2 weeks after the last one if anything new happened; `sgt retro` runs one now
(after a big architecture change, say). Nothing else schedules it, so a healthy system that leaves less
feedback gets rarer retros. It runs on the control plane with Sergeant's own reasoning model, never a
worker or a person's model account. It reads two inputs only: the Sergeant feedback comments posted since
the last retro, and what became of the issues Sergeant filed in that time (done, canceled, or still
waiting), plus the previous retro and its issues as they stand now. Reasoning first says in one paragraph
whether the last retro's recommendations happened and their themes stopped recurring, then gives themes
with their evidence (task ids) and a recommendation each, and rarely an issue: only for repeated evidence
across tasks, a meaningful recurring cost or risk, a clear systemic defect, or a strong simplification,
preferring removing complexity, then guidance, then docs or tooling, then new machinery (at most 3).
Sergeant files those in Backlog in the Sergeant project, unassigned and not delegated, for a human to
promote, and posts the retro as one Linear document there titled `Sergeant retro <date>`. Linear is the
store: the newest such document is when the last window ended and what it filed. `<dir>/retro.json` only
keeps an answer whose filing or posting failed, so the retry pays for no second answer; issue and
document ids derive from the window, so a retry files and posts each once. A failed retro is retried a
day later, or at the next `sgt retro`. The Linear token needs
permission to create documents.

Review quality is telemetry, never a gate (UNF-730, design 06 §8–9). Every reviewer run that
finishes, whether or not the task ever merges, is written as a line of `<dir>/reviews.jsonl`: trigger
(`required` or `audit`), mode (a separate fresh run), reviewer and implementer provider and model,
whether their vendors are the same, the heads reviewed, the verdict, finding counts, the must-fix
(blocking) findings verbatim, the merged head once there is one, and the resulting change
(`resultingMutation`: `true` when a worker's report lists one of its findings `fixed` in
`addressedFindings`, `false` when it had none or workers answered them and fixed none, otherwise
`"unknown"`; a head changing after a review is not counted). A review is written again only when one
of those later facts changes, so the last line per run id holds. A merged head that no fresh review
approved skipped review; a stable hash of the head picks `review.auditSampleRate` of those for an
**audit review**, a separate fresh reviewer of exactly the merged head, started only after the merge
so it can never hold one up. After observing Done the loop waits for any review still running,
the audit included, and records it; an audit's must-fix findings on merged code also go to
`<dir>/audit-followups.jsonl` and an `AUDIT FOLLOW-UP` log line for a human to act on (nothing is
reopened or reverted, and no turn runs after the merge to propose a `create_followup`). To compare
review modes across runs:

```sh
cat <state dirs>/reviews.jsonl | jq -s 'reduce .[] as $f ({}; .[$f.runId] = $f) | [.[]] | group_by([.trigger, .vendor])
  | map({trigger: .[0].trigger, vendor: .[0].vendor, reviews: length, withMustFix: map(select(.findings.blocking > 0)) | length,
    ledToChange: map(select(.resultingMutation == true)) | length, unknown: map(select(.resultingMutation == "unknown")) | length})'
```

Each task has a budget window, saved in `state.json` with the task's start before anything else
happens. It is the installation config's `budget` (`{ "minutes": 45, "usd": 10 }`, say; TECH-4964),
each field unset defaulting to 120 minutes and $25; `canary`'s `--budget-minutes` and `--budget-usd`
override the config's for its task. A restart keeps the stored window and logs that it ignores a
different one, so changing the config's `budget` affects only tasks that start afterward, and their
next fresh window. A human's answer to any of the V2 agent's questions gives the task a fresh window
(TECH-5059): from the answer's time, with zero spend (runs of earlier windows no longer count) and the
config's current `budget`. Wall time is hard and runs from the window's start, including time spent
waiting for a human before an answer, and for a task slot after one. Spend is best-effort: the cost runs and reasoning turns report when they end (a turn's cost counts before its proposals run), so a running or
canceled run's cost is unknown and the wall time is the backstop; there is no billing ledger. Once
either is exhausted, no run, message, follow-up, or merge happens (Gate rule B1, checked before every
effect and again right after its live reads), running runs are canceled until the runner confirms it,
and the V2 agent asks one **Question for you**, summarizing spend, runs, and PRs, with the options to
extend or accept as-is. It is posted like any question, under a key of the task and the window, so a
restart finds it on Linear instead of asking again, and nothing happens until a human replies after it.
A reply opens a fresh window like any answer, so "extend" needs nothing more: the next turn carries on
with the work, and a steer is carried out in it. On "accept as-is" (the option's number, or the same in
the human's own words) reasoning proposes `accept_as_is` instead (TECH-5118): the loop ends `accepted`
with nothing more asked, and `state.json` is set aside so intake does not resume it, leaving its PRs
and the issue for a human. One line on the issue says so (TECH-5120), posted under a key of the
accepting reply, so a retried turn posts no second one. Gate rule Q2 refuses it unless a human replied to the budget question, and
unless the live conversation is still the one reasoning read, so a reply posted while it reasoned is
read by the next turn instead. An `accepted.json` marker keeps intake from starting the issue afresh
while it stays delegated and in Todo; moving the issue out of Todo (or undelegating it, or
`sgt task wake`) clears it, so back in Todo it starts a fresh task, as after a stop. When a
worker's verification shows nothing to change and the task opened no PR, reasoning proposes
`close_issue` instead of asking (TECH-5232): the same ending posts its evidence in one comment and
moves the issue to Done (main already covers it) or Canceled (obsolete), and the loop ends `accepted`;
Gate rules C1–C4 refuse it with any PR in the task, without evidence, before a worker finished, or once
the conversation changed. A task
that runs away in its fresh window is stopped at that window's end and asked once more. The outcome comment after a merge is the one
effect B1 does not hold back: it reports a merge that already happened, and withholding it would hide
the merge from the human. A run's id is saved before the runner starts it, so a crash in between still
leaves a run the loop cancels; one the runner never started is dropped once a cancel confirms it.

```sh
docker build -t sergeant-runner:local packages/runner/container
pnpm --filter @terros/sergeant canary --config <file> --issue UNF-123 --repo owner/name --dir <state dir>
```

### The service

`serve` runs Sergeant unattended (UNF-719): one process that works every open issue delegated to the
V2 agent, in every repository the installation config enrolls, with nobody starting an issue by hand.
It is a thin shell over the canary's per-task loop, not a workflow engine:

- **Intake** lists open (not completed or canceled) issues delegated to `agentUserId` every
  `--intake-seconds` (120) and runs each one's loop in one of `maxTasks` (2) task slots (TECH-5008).
  A free slot goes to the highest-ordered task that wants one: by Linear status, In Review, then In
  Progress, then Todo; then by priority, Urgent to none; then newest first. Finishing work beats
  starting it. A task asked to wake (`sgt task wake`) goes first. A task holds its slot while it runs
  a worker, a reviewer, or a reasoning turn, and while it waits on anything (a question, a budget
  reply, CI, mergeability, a human merge, an unreadable runner) for up to `waitingGraceMinutes` (15).
  Answered within the grace, it continues at once; past it, its slot goes to the next task quietly,
  with nothing posted in Linear, and its loop keeps polling without a slot (TECH-5015). Once it has
  work again, it queues for a slot in the same order as new work, so In Progress goes ahead of Todo.
  `GET /status` lists the released tasks under `released`. Linear's list only discovers new work, and
  a task starts only from Todo (TECH-4989): an issue in Triage or Backlog waits until a human moves it
  there. A Todo issue with a Linear "blocked by" issue that is neither completed nor canceled waits
  too (TECH-5066), logging `<issue> waiting on blocker <issue>`, and starts at the first intake after
  its last blocker finishes; one with more than 20 inverse relations waits as if blocked, since
  Sergeant reads only 20. A task already under way is not held back. Starting it moves the issue
  from Todo to In Progress, the only state Sergeant moves an issue to. Every intake also resumes each local task (`state.json`) with no loop, whether or not Linear
  lists it, into a free slot in the same order, or with no slot until it has work to do. Its loop's
  own live checks then continue it, stop it (undelegated, or in Backlog, Canceled, or Done without its
  closing PR merged), or see it through after the merge; a stop never needs a task slot, and a task
  seen through is not resumed again.
- **Each task loop** is the canary's: every `--poll-seconds` (60) it re-reads its runs, the PRs
  Linear links to the issue or a worker reported, with their checks, and the Linear conversation, and takes a reasoning turn only when they changed, so
  a missed webhook costs only latency. Its state is `<state dir>/tasks/<issue>/`; runs live under
  `<state dir>/runs/`.
- **Webhooks** (TECH-4937) are a latency optimization, never the source of truth.
  `POST /webhooks/linear` and `POST /webhooks/github` refuse a delivery whose signature (HMAC-SHA256 of the
  body, `Linear-Signature` or `X-Hub-Signature-256`) does not verify, before parsing it, and a Linear
  delivery whose signed `webhookTimestamp` is over a minute from now. A verified event about an
  issue's delegation, state, title, description, labels, comments, attachments, or relations, or a
  PR's changes, pushes, reviews, check runs and suites, or statuses, names the issue or PR it is
  about; each task loop watching that issue, PR, or head ends its wait and rereads, and a delegated
  issue with no loop, or a delegation change to or from the V2 agent, runs an intake now. Nothing else
  happens: no event owes a turn or is recorded, repeated events coalesce (each loop, and intake, wakes
  at most once per 5 seconds), an issue or PR no task watches is ignored, and the polls still find
  every change.
- **Post-merge feedback** (TECH-4985). While a task is active, a human's comment is part of its
  conversation, as above. Once its completing PR (`Fixes`) merged or its issue is Done, the loop takes
  no more turns, so a sweep every 10 minutes reads those issues (delegated to `agentUserId` and
  completed in the last 14 days, open and delegated, or merged by this host in that time): human
  comments on the issue after the work landed, and comments, review comments, and reviews on its
  merged worker-App PRs after their merge from the repository's owners, members, and collaborators.
  A reasoning call judges each one; an acknowledgement or discussion files nothing. Actionable
  feedback becomes one ordinary follow-up issue (Backlog, assigned to the origin's owner, not
  delegated; see the design's §11), related to the origin, whose description is the delta reasoning
  wrote, the feedback verbatim, and links to the original issue and the merged PRs; a comment on the
  origin says so. A human starts it like any issue, by moving it to Todo and delegating it to Sergeant.
  Its Linear id is derived from the feedback, so the same feedback never files a second issue.
  `<state dir>/feedback.json` records what was judged and failed attempts, and its `since` (the first
  sweep) keeps feedback from before the rollout out. Per issue, at most 3 follow-ups are filed and 10
  pieces of feedback judged; past that, or after 3 failed attempts at one piece, Sergeant says so in a
  comment on the issue rather than dropping it silently.
- A loop that ends (idle, a failed read) is admitted again on a later intake while
  the issue is still delegated: an unchanged task takes no turn, a changed one does. A failed intake
  is logged and retried next interval.
- SIGINT or SIGTERM stops intake and ends each loop at its next poll, never mid-turn; a second signal
  exits at once. A restart rereads Linear, GitHub, the runner, and each task's `state.json`, and
  continues, accepting some repeated work. One process serves a state directory: it holds an OS file lock on
  `<state dir>/service.lock` (released when it exits, however it exits), and a second start is refused while it does. `GET /health` on `--host` (127.0.0.1) and `--port` (8080) reports the process alive,
  the tasks running, and the last intake.
- The same port answers the client API under `/v1` (UNF-713, the slice of design 11 §2 `sgt` uses):
  task and run reads, `POST /v1/tasks/:ref/wake`, `/v1/tasks/:ref/cancel`, and `/v1/runs/:id/cancel`.
  A wake ends the task loop's wait and owes it one turn, behind every hold the loop keeps. A task
  cancel removes the V2 agent's delegation and then takes the task's one stop (above); it answers with
  any run the runner has not yet confirmed, and `serve` keeps driving the recorded stop at each intake,
  across a restart, until it has. A run cancel is the
  runner's confirmed cancel, noted on the issue so the next turn does not just restart it. Before
  anything else, every `/v1` call must name a client version (`Sergeant-Cli-Version`) no older than
  the oldest `sgt` this `serve` supports, or it is refused with `400` and "Run `sgt update`" (TECH-5188),
  so a too-old `sgt` changes nothing. Every `/v1` call names its caller and fails closed without one (TECH-4938): a bearer Linear access token
  from `sgt login`, which `serve` reads back from Linear on every call and admits only for an active
  user of the agent's own Linear workspace, not an agent, in one of `humans.teams`; those listed
  in `humans.approvers` are approvers too. `/v1/whoami` says whether the caller is an approver; only an approver (or the loopback operator) may `POST /v1/accounts/remove-person` to remove everything one person registered (TECH-5130), restart or update the Sergeant host through `/v1/admin` (TECH-5195, deploy/README.md), or `POST /v1/repositories/add` or `/remove` to change the enrolled repositories, which every caller may `GET /v1/repositories` (TECH-5193). A change is refused unless both GitHub Apps reach the repository; it rewrites only `repositories` in the installation-config parameter (`--config-parameter`, else `SERGEANT_CONFIG_PARAMETER`), naming the caller in the parameter version's description, and `serve` takes it in place. With a parameter, `serve` reads its enrolled repositories from it at startup rather than from `--config`, so a restart keeps every change. Wakes and cancels are logged
  with the caller's name, and a cancel's note on the issue names them. Only `GET /v1/auth/config`, the
  public client id `sgt login` starts with, needs no caller. For development on one machine,
  `--trust-loopback` also admits a caller on the host with no login, as an operator; it is refused
  unless `--host` is `127.0.0.1` or `::1` (not a name such as `localhost`), and never covers a request relayed by a proxy or naming a non-loopback
  `Host`. Posts must be JSON, so a cross-site form cannot post.

```sh
pnpm --filter @terros/sergeant serve --config <file> --state-dir <dir> [--port 8080] [--max-tasks 2] [--waiting-grace-minutes 15] [--config-parameter <SSM name>] [--trust-loopback]
```

To run `serve` on one AWS host behind an HTTPS endpoint, see [`deploy/`](deploy/README.md): Terraform,
the host install and update scripts, and the runbook.

### The `sgt` CLI

New to `sgt`? [`docs/sgt.md`](docs/sgt.md) is the user guide: install, log in, everyday commands.
This section is the reference.

`sgt` (UNF-714) only calls the client API and prints the answer: concise lines by default, the API's
own JSON with `--json` (errors too, as `{"error":{"code","message"}}`; exit 1 for an API error, 2 for
usage). It needs no AWS credentials. Run `sgt --help` for the commands: `login`, `logout`, `whoami`,
`task list | show | wake | cancel`, `run list | show | report | cancel`, `account …`, `repo list`, `admin repo add | remove`, `update`. Keep it current: the
installation refuses every request from an `sgt` older than it supports, before acting on it, and says
to run `sgt update`, which needs no API.

```sh
alias sgt="node $PWD/packages/cli/src/sgt.ts"   # from the repository root
sgt login                                        # once: sign in with Linear in the browser
sgt whoami
sgt task show UNF-123                            # serve on this machine: http://127.0.0.1:8080
```

The API is `--api <url>`, else `SGT_API_URL`, else `http://127.0.0.1:8080`. `sgt login` signs you in
as yourself with Linear OAuth (PKCE, no client secret) through the installation's Linear OAuth app,
whose client id the API serves, and keeps the resulting Linear token, renewed before it expires, for
that API URL in `~/.config/sergeant/credentials.json` (or under `XDG_CONFIG_HOME`), readable only by
you. It is the only credential `sgt` holds, and it is sent only over HTTPS or to loopback. The
browser returns to `http://localhost:4546/callback` (`SGT_LOGIN_PORT` changes the port, and the app
must list the result). `sgt logout` forgets it on this machine; revoking the app in your Linear
account settings ends it at Linear.

The installation's Linear OAuth app (the V2 agent's own app; one app per installation is enough) needs
`http://localhost:4546/callback` among its callback URLs; `sgt login` asks for the `read` scope as the
user (`actor=user`), and its client id goes in the installation config's `humans.linearClientId`.
The hosted API is available through the installation's permanent HTTPS endpoint. From a laptop—no
AWS account or session is needed—set that endpoint, sign in, and list tasks:

```sh
export SGT_API_URL=https://<hostname>
sgt login && sgt task list
```

The host operator must first set all three `humans` fields: the app's public `linearClientId`, the
allowed Linear team keys in `teams`, and the allowed teams' Linear user ids in `approvers`; the app
must have the callback above. Until then the API fails closed. See [`deploy/README.md`](deploy/README.md)
for rollout and unauthenticated live checks.

### The MCP server

`sgt-mcp` (TECH-4940) gives MCP clients the read-only half of `sgt` over stdio: `task_list`,
`task_show(ref)`, `run_list(task?)`, `run_show(run)`, `run_report(run)`, and `health`. Each tool is
one GET to the same client API, and returns the API's JSON unchanged as structured content (errors
as `{"error":{"code","message"}}` tool errors). It cannot wake or cancel anything. It reaches the API
at the same URL as `sgt` (`--api`, else `SGT_API_URL`, else `http://127.0.0.1:8080`), and sends the
Linear login `sgt login` saved for that URL, read and renewed on every call as `sgt` does (TECH-5123),
so it works from a laptop against the hosted API. With no login saved it sends none, which only a
`serve --trust-loopback` on the same machine answers. Register it with a client as a stdio server
([`docs/sgt.md`](docs/sgt.md) §9):

```json
{ "mcpServers": { "sergeant": { "command": "node", "args": ["<repo>/packages/mcp/src/sgt-mcp.ts", "--api", "https://<installation hostname>"] } } }
```

### UNF-724 live check (after UNF-720)

Once the V2 Linear agent app, both GitHub Apps, and the canary repository's ruleset exist:

1. Put the V2 agent's Linear user id in `linear.agentUserId` and V1's agent user in
   `linear.otherAgentUserIds`.
2. Create a small controlled issue in the canary repository's team and delegate it to the V2 agent.
   `live-check --issue <it>` must pass, including `issue is delegated to the V2 agent`.
3. Undelegated or delegated to V1's agent, `canary --issue <it>` stops at once with
   `CANARY RESULT {"outcome":"stopped",...}` and nothing is started; V1 never sees an issue delegated
   to V2.
4. Delegated to the V2 agent, run `canary` through to the merge. Expect exactly one comment, authored by
   the V2 agent, with the PR link, reviewed head, required checks, merge SHA, and known gaps, then the
   issue moving to Done through the GitHub integration (`CANARY RESULT {"outcome":"done",...}`).
   Running the same command again posts nothing more.
5. On a second controlled issue, reassign it to V1's agent (or remove the delegate) while a turn is
   deciding or a worker is running: the loop stops, cancels the running run, merges nothing, and
   posts nothing.

### UNF-726 live check (after UNF-720)

With the identities from UNF-720, on a controlled issue in the canary repository whose objective
invites a fixable mistake (or after a human pushes a deliberately failing commit to the worker's PR):

1. Run `canary` until a reviewer returns `changes_requested` with a blocking finding, or a required
   check fails on the PR head. The next turn starts one successor worker; its
   `<dir>/runs/<runId>/workspace/sergeant-brief.md` lists the PR, the failing check, and the finding.
2. The successor pushes to the same PR (no second PR, no second worker running), and the loop merges
   only after a fresh approving review of the new head, or the successor's own waiver for that exact
   head, with required checks green (`CANARY RESULT {"outcome":"done",...}`).

### UNF-727 live check (after UNF-720)

On a controlled issue delegated to the V2 agent whose description leaves a real product choice open
(for example "retain or purge X; the captain decides"):

1. Run `canary`. Expect one comment from the V2 agent headed **Question for you**, then only
   `waiting:` log lines: no run started, no merge, and no `idle` stop.
2. Stop the loop (`touch <dir>/STOP`), remove `STOP`, and run it again: still exactly one question
   comment, and it keeps waiting.
3. Reply on the issue in your own words. The next poll takes a turn that interprets the reply and
   continues the work (or asks one short clarifying question, which waits the same way).

### UNF-729 live check (after UNF-720)

With the identities from UNF-720, on a controlled issue in the canary repository whose change invites
a minor, out-of-scope observation:

1. Run `canary` until a reviewer approves with a `non_blocking` finding, or the worker's report lists
   a `followups` entry. In the turn that merges (or earlier), `turns.jsonl` shows a
   `create_followup <key>: done {"identifier":...}` outcome.
2. In Linear, exactly one new issue exists for it: in the origin issue's team and project, with no
   delegate or assignee, a description that stands alone and links back, and a `related` (or
   blocked-by) relation to the origin. The outcome comment lists it under "Follow-ups filed".
3. Rerun the same command, and once more with `state.json` restored from before that turn: no second
   issue or relation appears.

### UNF-730 live check (after UNF-720)

With the identities from UNF-720 and `"review": { "auditSampleRate": 1 }` in the installation config,
on a controlled issue in the canary repository whose change is small enough that the worker skips
review (a one-line docs fix, say):

1. Run `canary` through the merge. The worker's report says `review.required: false` with a reason,
   and the merge relies on it (`not_required`).
2. After the outcome comment, the log shows `audit review run_audit-<head> started`, and the loop
   waits for it after the issue reaches Done. Its brief
   (`<dir>/runs/run_audit-<head>/workspace/sergeant-brief.md`) names the merged head and the skip reason.
3. `<dir>/reviews.jsonl` ends with one `"trigger":"audit"` line for it; any blocking finding is also in
   `<dir>/audit-followups.jsonl` and an `AUDIT FOLLOW-UP` log line. `CANARY RESULT` stays `"done"`.
4. With `auditSampleRate` 0, or on an issue whose head a fresh review approved, no audit starts, and
   the last `reviews.jsonl` line of each reviewer run is `"trigger":"required"` with `merged` set.
5. On an issue whose first review requests changes, the successor's report lists the finding in
   `addressedFindings`, and that review's last line says `"resultingMutation":true`.

### UNF-728 live check (after UNF-720)

On a controlled issue delegated to the V2 agent whose work takes more than a few minutes:

1. Run `canary --budget-minutes 5`. Once a worker is running and five minutes have passed, expect
   `budget exhausted (wall time exhausted at ...)` and `canceled run_...` log lines, `docker ps` showing
   no `sergeant-run_*` container, and one **Question for you** comment from the V2 agent with the spend,
   the runs (the worker `canceled`), any PR, and the extend / accept-as-is options. No run starts and
   nothing merges while it waits.
2. Reply "extend". The loop logs `a human answered (...): a fresh budget window ...`, and the next turn
   resumes the work in it. Replying "accept as-is" instead ends the loop `accepted`, with no further
   question, the PR left open, the issue left in its state, and one comment saying Sergeant has stopped
   and the PR and issue are the human's to merge or close.
3. With `--budget-usd 1`, the first finished run's reported cost exhausts the spend instead
   (`spent $... of $1.00`), with the same question.
4. On another issue, undelegate it while a worker runs: the loop logs `canceled run_...` and stops only
   after that; stopping Docker first (or making `docker stop` fail) keeps it retrying, not stopped.
5. Kill the canary (Ctrl-C) while the budget question is unanswered and rerun it with
   `--budget-minutes 120`: it logs `ignoring the budget options`, posts no second question, and still
   waits for the reply.

## Sergeant 1

Sergeant 1, the Rust implementation, has been removed. Its final source, including its runbooks and
architectural decision records, is the annotated tag `v1-final` (`git switch --detach v1-final`), and
its last installable release is `v0.1.0+aad6046`.

## License

Sergeant is open source, licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Terros Inc.

## Support

For contributions, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security vulnerability, see
[SECURITY.md](SECURITY.md).

# @terros/sergeant-runner

The walking skeleton's runner (UNF-705): `containerRunner` implements `RunnerPort` from
`@terros/sergeant-contracts` for the primary worker and the fresh-context reviewer.

## How a run works

- **One run, one container, one session.** `start` mints the run's GitHub token, clones the run's
  repositories on the host into a new workspace with it, writes the brief (`src/brief.ts`) there,
  and launches the role's agent CLI (`src/agents.ts`) in a new `sergeant-runner:local` container:
  `claude -p` (`claude-code-local`, the default) or `codex exec` (`codex-local`, below). The workspace is the only mount. A reviewer is a separate
  container and session, built from the issue, the PR, and recorded reports. It inherits nothing from
  the worker's session. The adapter, session (or Codex thread) id, cost or tokens, and resolved
  model of each run are kept in `agent.json` beside its record. `RunRecord.provider`/`model` record who did the work.
- **Reports.** The agent writes `/workspace/sergeant-report.md`. The host reads it only if it is a
  regular file, never a symlink, and parses it with the contract schemas (`WorkerReport` or
  `ReviewReport`). A worker reports the PRs it opened and their exact heads.
- **Limits and cancellation.** `timeout` inside the container caps wall time, and for Claude Code
  `--max-budget-usd` caps cost (Codex has no such cap). `cancel` stops the container and records `canceled` only once Docker shows it stopped or
gone; otherwise it throws so the caller retries. Likewise `status` throws while Docker cannot
answer; a run counts as lost only when Docker says its container no longer exists. There are no leases, adoption, restart recovery, or
  `send`.
- **State.** One directory per run under `rootDir`: `run.json`, `workspace/`, and once terminal,
  `record.json`, `report.md`, and `agent.json`. The workspace is removed as the run ends, once its
  record and report are written, because nothing reads it after that (TECH-5229, `workspaces.ts`);
  `serve` sweeps any left behind at startup. The rest of the run's directory is kept.

## Credentials

A container gets only these, each passed by name so no value is on a command line, and there is no
generic environment input:

- For a Claude Code run, the chosen Claude account of the task's owner (below), as `CLAUDE_CODE_OAUTH_TOKEN`.
- For a Codex run instead, the chosen Codex account of the task's owner, as
  `CODEX_CREDENTIAL`. The container turns it into its own `~/.codex/auth.json` (outside the workspace)
  and unsets the variable before Codex starts. A Codex run never gets the Claude token, nor the reverse.
- For a worker only, `GH_TOKEN`: an installation token of the **worker GitHub App**, minted per run
  by the injected `githubTokens` and scoped to exactly the run's repositories with `contents` and
  `pull_requests` write and `checks`, `actions`, and `metadata` read. It is the worker's only GitHub
  credential: the worker pushes its `sergeant/` branch and opens or updates its PR itself (`gh` and
  git over https use it). The repository's ruleset, where the worker App is not a bypass actor, is
  what stops it from pushing to or merging into the default branch; it cannot change workflows
  because the App lacks that permission.

A reviewer's token is read-only and used only on the host to read the PR and check out its exact
head; it never enters the reviewer's container. A run gets no host home, AWS, `gh` login, SSH,
Linear, Docker socket, or Sergeant state. `node src/live-check.ts` prints what a run can see.

Commits are authored and committed, through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, as the person who
requested the run (TECH-5593): the name and Linear login email the task owner registered the run's
model account with (`ModelAccount.person`, `commitIdentity`), so GitHub attaches the commit to them.
`gitIdentity`, the installation's human identity, is only the fallback for an account that names no
person. The image's Claude Code settings turn off its co-author trailer; Codex
has no equivalent setting and may add its co-author trailer. The image does not set `core.hooksPath`,
so repository-provided hooks run normally. The brief tells agents not to add agent attribution.
Whatever the branch commits carry, Sergeant writes every squash merge's message itself (TECH-5085):
the PR title and body, `Fixes <issue>` (or `Part of`, never a closing word, for a PR that does not
complete it), a plain `Built by Sergeant (worker: …, review: …)` line, and only human co-authors,
agents being told by their commit identity, so no agent becomes a contributor in any enrolled repository.

## Codex (`codex-local`, TECH-5009)

No installation setting turns Codex on (TECH-5390): the image carries both CLIs, and each run's agent
comes from its task owner's registered accounts and their quota (below). An owner with both providers
registered gets reviews from the other provider than the worker's. The earlier blocker, that the only Codex login was personal (UNF-710), is gone:
each run uses an account its task's owner registered for Sergeant to use.

- **Credential.** Only the task owner's registered Codex account (Model accounts below), which they
  register with `sgt account register codex` (`docs/sgt.md`); the installation has none (TECH-5184).
  Its value is either the JSON of the `auth.json` that `codex login` writes after signing in to
  ChatGPT (`{"auth_mode":"chatgpt","tokens":{…},"last_refresh":…}`), or an OpenAI API key (`sk-…`).

  Codex refreshes a ChatGPT login's tokens as they age and writes them to `auth.json`; in a run that
  is the container's own copy, discarded at the end, so the registered account keeps the tokens it was given.
  Sergeant detects structured Codex authentication failures and Codex's specific refresh failures:
  expired, revoked, or already-used refresh tokens; a login changed to another account; and a generic
  failure to refresh the access token. It records the run's distinct `failureReason` as
  `authentication` and posts an idempotent alert on the Linear issue during an active pre-merge poll.
  The alert tells the account's holder to register it again or remove it. It never includes provider
  error text or token values. An API key does not age this way, but bills that API project per token
  instead of a ChatGPT plan.
- **Model.** `gpt-5.6-sol`, or the config's optional `codex.model`, in both roles.
  `serve`/`canary`'s `--worker-model`/`--reviewer-model` name only Claude Code's model for the role.
- **Usage.** `codex exec --json` reports tokens, not dollars. The run record keeps `tokens` (input,
  cached input, output, reasoning output; `sgt run` shows them) and, for a model with a price,
  `costUsd` estimated from them with `costBasis: "estimated"` (TECH-5021). Prices are OpenAI's
  published API list prices per model, USD per million tokens (`src/codex-prices.ts`, read
  2026-10-05 from https://developers.openai.com/api/docs/pricing); the config's `codex.prices` adds to
  or replaces them. Cached input is priced as cached, reasoning is counted within output, and cache
  writes, long context and subscription limits are ignored: the figure is the same API-equivalent
  basis as Claude Code's, a runaway guard rather than accounting. A model with no price records no
  `costUsd`, and the task budget counts the run as unknown cost. With no spend cap, the wall-time
  limit is the run's only hard backstop.
- **Provider by quota (TECH-5117).** `start` reads the live quota of each of the task owner's accounts
  right before the launch (`quota.ts`: Claude's `/api/oauth/usage`, or the
  `anthropic-ratelimit-unified-*` headers of a one-token Haiku request when the token may only run
  inference; Codex's `chatgpt.com/backend-api/wham/usage` with a ChatGPT login), cached for five
  minutes, and `choose.ts` decides deterministically (below). A reviewer takes an account of another
  provider than the latest worker that reported its PR whenever the owner has a usable one (else the
  same, marked `sameProviderAsWorker`).
  The run record's `providerChoice` holds the choice, its reason, and the readings (`sgt run <id>`).
  The config's `runners.worker`/`runners.reviewer` are deprecated and ignored (a warning is logged).
- **Model accounts (TECH-5179).** Each run uses only its task owner's accounts (`RunSpec.owner`, the
  human assignee who delegated the issue), read at each launch from `accounts(ownerId)`, the ones that
  person registered; never the installation's credentials or anyone else's. `accounts.ts` and
  `choose.ts` apply one rule (TECH-5213): among the owner's usable accounts (not set aside, not spent),
  the one with the highest pace, the lower of its weekly and 5-hour windows' percent left over percent
  of the window's time left. Time left counts as at least an hour's share of the window (20% of the
  5-hour window, about 0.6% of the week), so a sliver just before its reset does not start a run it
  cannot finish. An account whose provider reports only one window is scored on that window alone
  (TECH-5342). An account whose quota could not be read, or has a window without a reset time, is
  usable and ranks after every scored one; ties keep the registry's order, and no provider is preferred
  for a worker (TECH-5390). A reviewer takes the best usable account
  of another provider than its worker's whenever there is one, however it scores.
  Quota readings are cached for 4 minutes. There is no low-quota warning. Only the chosen account's
  credential enters the container. A run whose agent reports a quota or authentication failure (`failureReason`,
  from Claude Code's result text or Codex's failed turn) sets its account aside for an hour, or until the
  window it ran out of resets if sooner: the one at 0% when its quota is read again as the run fails
  past the 4-minute cache (`failingReset`); with no window known to be at 0%, the hour. The next launch takes another of the owner's. With no account, or none usable, `start` throws
  `NoModelAccount` before cloning anything, and nothing starts. The record's `account` and
  `accountReason` say whose subscription paid and why.
- **Resume (V6).** Codex can resume a thread (`codex exec resume <id>`), but its session lives in the
  run's container, removed at the end, and this runner resumes no adapter. A continuation is a fresh
  run from the pushed branches and earlier reports in its brief. The thread id is in `agent.json`.
- **Sandbox.** Codex runs with `--dangerously-bypass-approvals-and-sandbox`: the container is the
  sandbox, as with Claude Code's `bypassPermissions`.

## Fargate (`fargateRunner`, TECH-5237)

With the installation config's `"runners": { "workerBackend": "fargate" }`, each worker runs as one
ECS Fargate task (`src/fargate/`); reviewers stay on the host's `containerRunner`. `byRole` routes a
start by role and every later call by where the run started (`run.json`'s `backend`), so changing the
setting leaves running runs where they are. Account choice, the brief, the agent scripts, parsing, and
the report are the same as the local runner's; only where the run happens differs.

- **Start.** On the host: choose the account, mint the worker token, list the repositories'
  `sergeant/*` branches with `git ls-remote`, fetch the issue's files, render the brief. Then one
  Secrets Manager secret per run, `sergeant/runs/<runId>`, holds the brief, the files, `GH_TOKEN`, and
  the model credential as JSON keys; a task definition revision references those keys (never values);
  `RunTask` starts it with a client token and `startedBy: <runId>`. Each step is recorded in the run's
  `launch.json` before it can exist (`launch.ts`): a failure before the task deletes the secret and
  the revision, and a lost `RunTask` answer is settled by the run's next `status` or `cancel`, which
  finds the task by `startedBy` or repeats the same idempotent `RunTask`.
- **In the task** (`TASK_SCRIPT`): write the brief and files, clone with the worker token, run the
  adapter's unchanged script. Its output goes to the task's CloudWatch log stream. At the end the
  script prints, base64 between `SERGEANT-RESULT-…`/`SERGEANT-REPORT-… <nonce>` markers, the agent's
  last JSON line and `sergeant-report.md`. The first keeps Claude Code's result (its cost) intact when
  the log splits a line over 16 KiB.
- **Status and cancel.** `DescribeTasks`; only `MISSING` is loss, anything unreadable throws (unknown).
  A stopped task is collected from its log stream once its report frame arrives (or two minutes
  after it stopped), then its secret is deleted and its revision deregistered, and only then is the
  terminal record written. `cancel` calls `StopTask` and records `canceled` only once the task is
  `STOPPED` and its report, which may name PRs, is in; until then it throws and the caller retries.
- **Limits.** A secret holds at most 64 KiB: files that do not fit are left out and named in the
  brief; a brief that does not fit alone fails the start with an error saying so. Nothing else
  (no S3). The task has no task role, so nothing in a run can call AWS; Fargate does not support
  `no-new-privileges`, so the container drops all capabilities and runs as `node`.

The AWS resources are `deploy/terraform/fargate.tf`, and turning it on is in `deploy/README.md`
("Workers on Fargate"). Tests run against in-memory SDK clients (`src/fargate/fake-aws.ts`).

## Manual live check

Not part of CI. It starts a container the way a worker run is started, with placeholder credential
values, and prints its user, environment variable names, which host credential paths exist, and the
agent CLI's version:

```sh
docker build -t sergeant-runner:local container
node src/live-check.ts                          # Claude Code
node src/live-check.ts --adapter codex-local    # Codex: only CODEX_CREDENTIAL and GH_TOKEN enter
```

Real worker and reviewer runs are exercised by the canary (`packages/sergeant`).

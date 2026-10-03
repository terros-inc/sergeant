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
  `record.json`, `report.md`, and `agent.json`. Nothing is cleaned up automatically.

## Credentials

A container gets only these, each passed by name so no value is on a command line, and there is no
generic environment input:

- For a Claude Code run, `claudeOAuthToken`, the Sergeant model token, as `CLAUDE_CODE_OAUTH_TOKEN`.
- For a Codex run instead, `codexCredential`, the installation's Codex credential, as
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

Commits are authored and committed as `gitIdentity`, the installation's human identity, through
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`. The image's Claude Code settings turn off its co-author trailer; Codex
has no equivalent setting and may add its co-author trailer. The image does not set `core.hooksPath`,
so repository-provided hooks run normally. The brief tells agents not to add agent attribution.

## Codex (`codex-local`, TECH-5009)

The installation config chooses the agent per role: `"runners": { "reviewer": "codex-local" }` makes
reviews come from a different provider than the Claude Code worker. A role not named runs Claude Code,
exactly as before. The earlier blocker, that the only Codex login was personal (UNF-710), is gone:
Terros now has its own Codex Team account, and nothing personal is ever used.

- **Credential.** One Secrets Manager secret per installation, named by the config's
  `codex.credentialSecret` (for example `sergeant/<installation>/codex-credential`), never in source.
  Its value is either the JSON of the `auth.json` that `codex login` writes after signing in as the
  installation's Codex Team account (`{"auth_mode":"chatgpt","tokens":{…},"last_refresh":…}`), or an
  OpenAI API key (`sk-…`) of a project the installation owns. Create it from a throwaway Codex home, so
  no personal login is touched:

  ```sh
  export CODEX_HOME=$(mktemp -d)
  codex login --device-auth              # sign in as the installation's Team account
  aws secretsmanager create-secret --name sergeant/<installation>/codex-credential \
    --secret-string "file://$CODEX_HOME/auth.json"     # or put-secret-value to replace it
  rm -rf "$CODEX_HOME"
  ```

  Codex refreshes a ChatGPT login's tokens as they age and writes them to `auth.json`; in a run that
  is the container's own copy, discarded at the end, so the secret keeps the tokens it was given.
  Sergeant detects structured Codex authentication failures and Codex's specific refresh failures:
  expired, revoked, or already-used refresh tokens; a login changed to another account; and a generic
  failure to refresh the access token. It records the run's distinct `failureReason` as
  `authentication` and posts an idempotent alert on the Linear issue during an active pre-merge poll.
  The alert tells an operator to sign in again and replace the configured Secrets Manager secret, or
  switch to an OpenAI API key. It never includes provider error text or token values. An API key does
  not age this way, but bills that API project per token instead of the Team plan.
- **Model.** `codex.model` in the config, unless `serve`/`canary` gets `--worker-model`/`--reviewer-model`.
- **Usage.** `codex exec --json` reports tokens, not dollars. The run record keeps `tokens` (input,
  cached input, output, reasoning output) and no `costUsd`, so the task budget counts the run as
  unknown cost (`sgt` shows its tokens with `sgt run`); nothing guesses a price. With no spend cap, the wall-time
  limit is the run's only backstop.
- **Provider by quota (TECH-5117).** When the installation holds both credentials, `start` reads each
  provider's live quota right before the launch (`quota.ts`: Claude's `/api/oauth/usage`, or the
  `anthropic-ratelimit-unified-*` headers of a one-token Haiku request when the token may only run
  inference; Codex's `chatgpt.com/backend-api/wham/usage` with a ChatGPT login), cached for five
  minutes, and `choose.ts` decides deterministically. The worker gets the provider with the most weekly
  capacity left unless its 5-hour window is below 20%; the reviewer gets the other provider than the
  latest worker that reported its PR, unless that one is below the 5-hour floor (then the same, marked
  `sameProviderAsWorker`). Any unknown reading keeps the `runners` default; a read never fails a launch.
  The run record's `providerChoice` holds the choice, its reason, and the readings (`sgt run <id>`).
  A role's `--worker-model`/`--reviewer-model` applies to its configured adapter; on the other one it
  runs that adapter's default model.
- **Model accounts (TECH-5113).** `claudeOAuthToken` and `codexCredential` are the installation's own
  accounts (`installation-claude`, `installation-codex`); `accounts()` lists more, read at each launch:
  the owner's further ones, then people's registered ones. Owner-first across providers: while any
  owner's account of either provider is usable (5-hour window at least 20%, week not spent), only the
  owner's usable accounts take part; people's registered ones only when none is. `accounts.ts` picks
  each provider's account among those (`chooseAccount`), and TECH-5117's choice compares each
  provider's pick; a provider with no account taking part is left out, so a reviewer may then share its
  worker's provider (`sameProviderAsWorker`). With nothing usable anywhere, every account takes part as
  before. Only the chosen account's credential enters the container. A run whose agent reports a quota or
  authentication failure (`failureReason`, from Claude Code's result text or Codex's failed turn) sets
  its account aside for an hour, so the next launch takes the next account. The record's `account` and
  `accountReason` say whose subscription paid and why.
- **Resume (V6).** Codex can resume a thread (`codex exec resume <id>`), but its session lives in the
  run's container, removed at the end, and this runner resumes no adapter. A continuation is a fresh
  run from the pushed branches and earlier reports in its brief. The thread id is in `agent.json`.
- **Sandbox.** Codex runs with `--dangerously-bypass-approvals-and-sandbox`: the container is the
  sandbox, as with Claude Code's `bypassPermissions`.

## Manual live check

Not part of CI. It starts a container the way a worker run is started, with placeholder credential
values, and prints its user, environment variable names, which host credential paths exist, and the
agent CLI's version:

```sh
docker build -t sergeant-runner:local container
node src/live-check.ts                          # Claude Code
node src/live-check.ts --adapter codex-local    # Codex: only CODEX_CREDENTIAL and GH_TOKEN enter
```

With a real Codex credential, `packages/sergeant/src/live-check.ts` (for a config that selects
`codex-local`) logs Codex in inside the image as a run does and checks it reads the login.

Real worker and reviewer runs are exercised by the canary (`packages/sergeant`).

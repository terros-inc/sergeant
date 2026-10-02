# @terros/sergeant-runner

The walking skeleton's runner (UNF-705): `containerRunner` implements `RunnerPort` from
`@terros/sergeant-contracts` for the primary worker and the fresh-context reviewer.

## How a run works

- **One run, one container, one session.** `start` mints the run's GitHub token, clones the run's
  repositories on the host into a new workspace with it, writes the brief (`src/brief.ts`) there,
  and launches `claude -p` in a new `sergeant-runner:local` container. The workspace is the only mount. A reviewer is a separate
  container and session, built from the issue, the PR, and recorded reports. It inherits nothing from
  the worker's session. The session id, cost, and resolved model of each run are kept in
  `agent.json` beside its record. `RunRecord.provider`/`model` record who did the work.
- **Reports.** The agent writes `/workspace/sergeant-report.md`. The host reads it only if it is a
  regular file, never a symlink, and parses it with the contract schemas (`WorkerReport` or
  `ReviewReport`). A worker reports the PRs it opened and their exact heads.
- **Limits and cancellation.** `timeout` inside the container caps wall time, and `--max-budget-usd`
  caps cost. `cancel` stops the container and records `canceled` only once Docker shows it stopped or
gone; otherwise it throws so the caller retries. Likewise `status` throws while Docker cannot
answer; a run counts as lost only when Docker says its container no longer exists. There are no leases, adoption, restart recovery, or
  `send`.
- **State.** One directory per run under `rootDir`: `run.json`, `workspace/`, and once terminal,
  `record.json`, `report.md`, and `agent.json`. Nothing is cleaned up automatically.

## Credentials

A container gets only these, each passed by name so no value is on a command line, and there is no
generic environment input:

- `claudeOAuthToken`, the Sergeant model token, as `CLAUDE_CODE_OAUTH_TOKEN`.
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
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`. The image's Claude Code settings turn off its co-author trailer, and
the brief forbids agent attribution. An agent never appears as a GitHub contributor.

Codex is not a runner here: the only Codex login is personal (UNF-710), so reviewers are a separate
Claude session.

## Manual live check

Not part of CI. It starts a container the way a worker run is started, with placeholder credential
values, and prints its user, environment variable names, and which host credential paths exist:

```sh
docker build -t sergeant-runner:local container
node src/live-check.ts
```

Real worker and reviewer runs are exercised by the canary (`packages/sergeant`).

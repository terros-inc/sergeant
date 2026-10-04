# Using `sgt`

`sgt` is the command line for Sergeant: list its tasks, look at its runs, wake or stop a task. This
page gets you from nothing to `sgt task list`. You need the repository, a Linear account in one of
your installation's Linear teams, and your installation's URL (ask whoever runs it).

## 1. Prerequisites

- **Node.js 24.** With [nvm](https://github.com/nvm-sh/nvm): `nvm install 24` (or `nvm install` in the
  repository, which reads `.nvmrc`). Otherwise use the Node 24 installer from
  [nodejs.org](https://nodejs.org/). Check with `node --version` (`v24.…`).
- **pnpm.** Node 24 ships Corepack, which provides the pinned pnpm version: `corepack enable`. Check
  with `pnpm --version`.
- **git**, and read access to `terros-inc/sergeant` on GitHub.

## 2. Install

```sh
git clone https://github.com/terros-inc/sergeant.git
cd sergeant
pnpm install
pnpm install-sgt
```

`pnpm install-sgt` writes a small script, `~/.local/bin/sgt`, that runs
`node <repo>/packages/cli/src/sgt.ts "$@"` from this checkout, so `sgt` works in every shell. Set
`SGT_BIN_DIR` to put it elsewhere. It only ever replaces its own script: if some other file or a
symlink is already there, it stops and says so. If it says the directory is not on your `PATH`, add
the line it prints to your shell profile (`~/.zshrc` or `~/.bashrc`) and open a new terminal. Then
`sgt --version` should print a version.

**Update** with `sgt update`: it fast-forwards the checkout to `main` and runs `pnpm install`, and the
wrapper picks up the new code by itself. Keep `sgt` current: there is no compatibility with older
versions, so when the installation needs a newer `sgt`, every command stops with "Your sgt is older
than this Sergeant server supports. Run `sgt update`." `sgt update` only fast-forwards `main`: if the
checkout is on another branch or has commits `main` lacks, it says so and changes nothing.

## 3. Point it at your installation

Add this to your shell profile, with your installation's hostname, and open a new terminal:

```sh
export SGT_API_URL=https://<your installation's hostname>
```

Without it, `sgt` calls `http://127.0.0.1:8080` (a Sergeant running on your own machine).
`--api <url>` overrides it for one command.

## 4. Log in

```sh
sgt login     # opens Linear in your browser; approve, then return to the terminal
sgt whoami    # who the installation takes you for, and the repositories it works in
```

`sgt login` signs you in as yourself with Linear. If no browser opens, it prints the URL to visit.
The login needs local port 4546 free while it waits for the browser. It is kept per installation URL
in `~/.config/sergeant/credentials.json` and renewed automatically; `sgt logout` forgets it.

**Who may use it.** Access needs an active Linear account in your installation's Linear workspace
that is a member of one of the installation's configured Linear teams; that membership is checked on
every call, so leaving those teams ends your access. Every such member may use every `sgt` command.
**Approvers** are members the installation also lists by name (`sgt whoami` says `, an approver`
after your name); being an approver never admits someone outside those teams, and only
`sgt admin account remove-person` is limited to approvers. If `sgt login` or `sgt whoami` says you are in none of the installation's
teams, ask a Linear admin of your workspace to add you to one of the teams it names. To become an
approver, or to have another team configured, ask your installation's operator (who manages its
configuration).

## 5. Everyday commands

Tasks are named by their Linear issue identifier, such as `TECH-123`.

```sh
sgt task list                                  # every task, with status, turns, runs, last summary
sgt task show TECH-123                         # the issue, budget, runs, and recent turns
sgt task wake TECH-123 --reason "PR updated"   # ask Sergeant to take a turn now (--reason optional)
sgt task cancel TECH-123 --reason "not needed" # stop it: removes Sergeant's delegation, cancels its runs
sgt run list --task TECH-123                   # the task's runs, with their ids
sgt run show <run>                             # one run: status, model, cost, outcome, PRs
sgt run report <run>                           # the run's Markdown report
```

- `--json` prints JSON for scripts and `jq`: the API's own JSON for most commands, `{"report": "…"}`
  for `run report`, `{"api","signedOut"}` for `logout`, and errors as `{"error":{"code","message"}}`.
- `sgt --help` lists every command, including `run cancel <run> [--reason …]` and `update`.
- Exit codes: 0 ok, 1 the API refused or failed, 2 a usage mistake.
- MCP: `node <repo>/packages/mcp/src/sgt-mcp.ts` is a read-only MCP server over stdio, but it sends
  no login yet, so it only works on the Sergeant host itself ([README](../README.md#the-mcp-server)).

## 6. Model accounts

Sergeant runs workers and reviewers on the installation owner's Claude and Codex accounts first: while
any owner account of either provider has room (5-hour window at least 20%, week not spent), it uses the
one with the most weekly capacity left. Only when none of them has room does it use accounts people
registered, by the same rule. You can register your own subscription, one per agent CLI, and remove it at any time:

```sh
claude setup-token | sgt account register claude-code-local    # your Claude subscription
codex login && sgt account register codex-local < ~/.codex/auth.json   # your ChatGPT login for Codex
sgt account list                                # every account, whose it is, and the runs it paid for
sgt account remove codex-local                  # remove yours; runs already on it finish on it
```

- The credential is read from stdin, never from an argument, and is kept only in the installation's
  Secrets Manager. Sergeant checks it by reading its quota before storing it. Registering again
  replaces your earlier one.
- **Your credential is used inside Sergeant's worker and reviewer containers** while a run works on it,
  so a compromised or prompt-injected run could copy it. `sgt account remove` stops Sergeant using it
  but does not revoke a copy: to rotate it, revoke the token in your Claude account settings and make a
  new one with `claude setup-token`, or sign out of all ChatGPT sessions and `codex login` again.
  `register` says this each time. This risk is accepted on purpose (design/09-security.md §3a).
- You can only register or remove your own account. `sgt run show <run>` says which account a run used.
- **Offboarding.** An approver removes every account a person registered with
  `sgt admin account remove-person <linear-user-id>` (`sgt account list --json` shows each account's
  id, `person:<linear-user-id>:<adapter>`). Runs already on them finish on them, and it does not revoke
  a copy: the person, or their workspace admin, rotates the credential as above.
- The installation must be configured for registration (`registeredAccountsSecret`, deploy/README.md);
  otherwise `register` says so.

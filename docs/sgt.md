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
`SGT_BIN_DIR` to put it elsewhere. If it says the directory is not on your `PATH`, add the line it
prints to your shell profile (`~/.zshrc` or `~/.bashrc`) and open a new terminal. Then
`sgt --version` should print a version.

**Update** from the same checkout; the wrapper picks up the new code by itself:

```sh
git pull && pnpm install
```

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

**Who may use it.** Any active member of one of the installation's configured Linear teams may sign
in and use every `sgt` command. **Approvers** are members the installation also lists by name;
`sgt whoami` says `, an approver` after your name. No `sgt` command is limited to approvers yet.
If `sgt login` or `sgt whoami` says you are in none of the installation's teams, or the API refuses
you, ask your installation's operator (who manages its configuration) to add your team, or to make you
an approver.

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

- `--json` on any command prints the API's JSON unchanged (errors as `{"error":{"code","message"}}`),
  for scripts and `jq`.
- `sgt --help` lists every command, including `run cancel <run> [--reason …]`.
- Exit codes: 0 ok, 1 the API refused or failed, 2 a usage mistake.
- MCP: `node <repo>/packages/mcp/src/sgt-mcp.ts` is a read-only MCP server over stdio, but it sends
  no login yet, so it only works on the Sergeant host itself ([README](../README.md#the-mcp-server)).

## 6. Model accounts

Coming soon: registering your own model provider account with your installation
([TECH-5113](https://linear.app/terros/issue/TECH-5113/sergeant-a-pool-of-model-accounts-per-installation-with-people)).
The command will be added here when it ships.

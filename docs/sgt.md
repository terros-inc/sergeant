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
versions, so when the installation needs a newer `sgt`, it refuses every command before acting on it
with "Your sgt is older than this Sergeant server supports. Run `sgt update`." (`sgt update` itself
never calls the API.) `sgt update` only fast-forwards `main`: if the
checkout is on another branch or has commits `main` lacks, it says so and changes nothing.

## 3. Point it at your installation

Add this to your shell profile, with your installation's hostname, and open a new terminal:

```sh
export SGT_API_URL=https://<your installation's hostname>
```

Without it, `sgt` calls `http://127.0.0.1:8080` (a Sergeant running on your own machine).
`--api <url>` overrides it for one command.

**Several installations.** `sgt` keeps one login per API URL (§4), so the URL is what chooses the
installation; there is no profiles file. Give each one an alias in your shell profile instead of the
`export`, and log in once through each:

```sh
alias sgtw='SGT_API_URL=https://<work installation hostname> sgt'
alias sgtp='SGT_API_URL=https://<other installation hostname> sgt'
sgtw login && sgtp login
sgtw task list
```

## 4. Log in

```sh
sgt login             # opens Linear in your browser; approve, then return to the terminal
sgt login --paste     # remote/headless: paste the callback URL or its code
sgt whoami    # who the installation takes you for, and the repositories it works in
```

`sgt login` signs you in as yourself with Linear. In an interactive terminal, if no browser opens, it
prints the URL to visit and prompts for the callback URL or code. Use `sgt login --paste` to choose this
flow immediately on a remote or headless machine: open its printed URL in your browser, approve access,
copy the dead `localhost` callback URL from the address bar (or copy just its `code` parameter), and
paste it into the terminal; explicit paste mode also accepts that value from piped stdin. The normal
login needs local port 4546 free while it waits for the browser
(`SGT_LOGIN_PORT` changes the port, and the installation's Linear app must then list that callback URL
too); in an interactive terminal, if sgt cannot listen there, it automatically uses the paste flow.
If the listener receives no callback for five minutes, sgt keeps listening and, in an interactive
terminal, also prompts for pasted input. With non-interactive stdin, automatic fallback leaves stdin
untouched and waits up to five minutes for loopback; use `--paste` to choose piped input, including
when the port is unavailable. The login is kept per
installation URL in `~/.config/sergeant/credentials.json` (or under `XDG_CONFIG_HOME`), readable only by
you, and renewed automatically; `sgt logout` forgets it on this machine, and revoking the app in your
Linear account settings ends it at Linear.

The login uses Linear OAuth with PKCE (no client secret) through the installation's Linear OAuth app,
whose public client id the API serves. The Linear token it keeps is the only credential `sgt` holds:
`sgt` needs no AWS credentials, and sends the token only over HTTPS or to loopback.

**Who may use it.** Access needs an active Linear account in your installation's Linear workspace
that is a member of one of the installation's configured Linear teams; that membership is checked on
every call, so leaving those teams ends your access. Every such member may use every `sgt` command.
**Approvers** are members the installation also lists by name (`sgt whoami` says `, an approver`
after your name); being an approver never admits someone outside those teams, and only the
`sgt admin` commands are limited to approvers. If `sgt login` or `sgt whoami` says you are in none of the installation's
teams, ask a Linear admin of your workspace to add you to one of the teams it names. To become an
approver, or to have another team configured, ask your installation's operator (who manages its
configuration).

## 5. Everyday commands

Tasks are named by their Linear issue identifier, such as `TECH-123`.

```sh
sgt task list                                  # every task, with status, turns, runs, last summary
sgt task show TECH-123                         # the issue, budget, runs, recent turns, and its last stop with the PRs it closed
sgt task wake TECH-123 --reason "PR updated"   # ask Sergeant to take a turn now (--reason optional)
sgt task cancel TECH-123 --reason "not needed" # stop it: removes Sergeant's delegation, cancels its runs
sgt run list --task TECH-123                   # the task's runs, with their ids
sgt run show <run>                             # one run: status, model, cost, outcome, PRs
sgt run report <run>                           # the run's Markdown report
```

`sgt retro` asks Sergeant for a retro across tasks now, after a big architecture change, say; it is
posted as a `Sergeant retro <date>` document in the configured Sergeant project. Otherwise retros run
by themselves. An approver can set or disable that target with `sgt admin retro` (§7).

Approvers also have `sgt admin` (§7).

- `--json` prints JSON for scripts and `jq`: the API's own JSON for most commands, `{"report": "…"}`
  for `run report`, `{"api","signedOut"}` for `logout`, `{"version"}` for `update` and `--version`,
  `{"request","outcome"}` for `admin restart` and `admin update`, and errors as `{"error":{"code","message"}}`.
  The API's JSON is printed as it was sent, so it keeps fields newer than your `sgt`; an answer outside
  the contract your `sgt` knows is an error.
- `sgt --help` lists every command: `login`, `logout`, `whoami`, `task list | show | wake | cancel`,
  `run list | show | report | cancel`, `account …`, `repo list`, `stops`, `review readiness`, `retro`,
  `admin …`, and `update`.
- Exit codes: 0 ok, 1 the API refused or failed, 2 a usage mistake.
- MCP: `sgt-mcp` puts the read-only commands in your AI assistant (§9).

### Budgets

A task works in a **budget window** of active time and money: by default 120 minutes and $25, or the
installation's configured `budget` (a repository's own `budget`, which approvers set with `sgt admin
repo budget` (§8), applies once the task has a run there).
Once either runs out, Sergeant cancels its runs and asks a **Question for you**: 1. Extend, 2. Accept
as-is, with its recommendation. Your comment on the issue, or your review or comment on its PR, gives
the task a fresh window. What the time counts, what opens a fresh window, and what the question says
are in [design 07 §6](design/07-linear-contract.md#6-budget-asks-and-fresh-windows).

- **`sgt stops`** shows, for each rubric rule and recommendation, how many budget questions were asked,
  how people replied (extend, stop, other), and how often the reply followed the recommendation.
  `--json` adds every stop.
- **`sgt task wake` does not touch the budget** of a task at work. It asks for a turn now, which still
  waits for anything that holds it, an exhausted budget included. A task whose closing PR merged is
  different: while its issue is open and delegated, a wake reopens its work in a fresh window, and
  otherwise the wake says no turn comes (`after_merge`), as
  [design 07 §7](design/07-linear-contract.md#7-completion-prs-automation-and-done) sets out.
- **There is no command to reset a task's budget**, not even for approvers. Changing the installation's
  `budget`, or a repository's own, affects only new tasks and later fresh windows.
- **`sgt task show <ID>`** shows the current window: spend of its limit, when its time would run out if
  the task worked without pause from now, and `EXHAUSTED` with why once it has run out (`--json` adds
  `windowStart`).

### Readiness agreement

`sgt review readiness [--since 90d] [--repo <owner/name>] [--list]` shows how often a human
merged exactly the head Sergeant declared READY TO MERGE: `AGREED n / evaluated m = p%`, with
DIFFERENT_HEAD and REJECTED beside it, the UNKNOWN declarations by reason (never in the rate), and
who merged. `--list` adds each declaration's PR, head, class and reason
([design 16 §7.1](design/16-evidence-based-review.md#71-stage-1-sgt-review-readiness-computed-by-rereading-github)).

## 6. Model accounts

Each task's workers and reviewers run only on the model accounts its owner registered (TECH-5179): the
issue's human assignee, who delegated it to Sergeant themselves. Sergeant takes the usable one whose
quota is furthest ahead of its reset schedule, and a reviewer uses the other provider from its
worker's when you have a usable account of it; the exact rule is in
[design 04 §10](design/04-runner-contract.md#10-adapters). Registering a Codex account is all it takes
for your tasks to use Codex (TECH-5390); no installation setting chooses providers. A task whose Linear
issue has the `sergeant:codex` label runs its workers on your best usable Codex account, and on the
usual choice when you have none usable (TECH-5084). Sergeant's own system account runs its reasoning
only, never a worker or reviewer. Register your own accounts, as many as you like, and
remove them at any time:

```sh
sgt account register claude                     # your Claude subscription, named "claude"
sgt account register codex                      # your ChatGPT login for Codex, named "codex"
sgt account register claude --name claudeWork   # another one, under a name of yours
sgt account list                                # every account: name, provider, whose, the runs it paid for
sgt account remove claudeWork                   # remove yours, then revoke it where it says
```

- **Signing in.** `register` runs the provider's own sign-in on your terminal: for `claude`,
  `claude setup-token` opens your browser, and you then paste the token it printed (it is not echoed;
  sgt cannot read it from that command's screen reliably); for `codex`, `codex login` signs in to a
  temporary `CODEX_HOME`, so your own `~/.codex` is never touched, and sgt reads its `auth.json` and
  deletes it. It needs that CLI installed (Claude Code or `npm install -g @openai/codex`) and says so
  otherwise. For scripts, pipe the credential instead and no sign-in runs:
  `sgt account register codex --name codexCI < auth.json`.
- **Names.** A name defaults to the provider (`claude` or `codex`) and is up to 40 letters, digits, `-`
  and `_`. Registering a name you already have replaces that account only. Your accounts are
  interchangeable to Sergeant: each run takes the best-paced one as above, and one that fails on quota
  or authentication is set aside for an hour (or until the window it ran out of resets, if sooner) so the next run
  takes another.

- Any of your subscriptions may be registered, personal or company-paid (TECH-5198).
- The credential is never an argument, and is kept only in the installation's Secrets Manager.
  Sergeant checks it by reading its quota before storing it.
- **Your credential is used inside Sergeant's worker and reviewer containers** while a run works on it,
  so a compromised or prompt-injected run could copy it. `sgt account remove` stops Sergeant using it
  (runs already on it finish on it) but does not revoke a copy, so it tells you how to revoke it. For
  Claude, open https://claude.ai/new#settings/claude-code and, under Authorization tokens, delete the
  user:inference-scoped token `claude setup-token` made, matching it by its Connected time. For Codex,
  open https://chatgpt.com/settings/security?view=sessions, where each Codex CLI login is its own
  session, and log out the one sgt's sign-in created, matching it by its time (Log out of all devices
  if you cannot tell which it is). Then register a new one if you want.
  `register` warns about this each time. This risk is accepted on purpose (design/09-security.md §3a):
  per-user isolation would keep it from colleagues' runs, but your own runs still hold it until the
  token is kept outside the run.
- You can only register or remove your own account. `sgt run show <run>` says which account a run used.
- **Only your own tasks spend it** (TECH-5179): an issue assigned to you that you delegated to Sergeant
  yourself. Someone else delegating an issue assigned to you is refused with a comment; assign it to
  yourself and delegate it, and its runs use your accounts and nobody else's. With none of yours
  registered or usable, the issue says so and nothing starts.
- **Offboarding.** An approver removes every account a person registered with
  `sgt admin account remove-person <linear-user-id>` (`sgt account list --json` shows each account's
  id, `person:<linear-user-id>:<name>`). Runs already on them finish on them, and it does not revoke
  a copy: the person, or their workspace admin, revokes the credential as above.
- The installation must be configured for registration: a hosted Sergeant is out of the box
  (deploy/README.md), except one whose host was first booted before TECH-5204, and a `serve`
  elsewhere needs `registeredAccountsSecret` in its config. Otherwise `register` says so, and your
  operator follows deploy/README.md, "Model accounts".

## 7. Restarting or updating Sergeant (approvers)

An approver applies an installation config change, or moves the hosted Sergeant to another release,
without AWS access (TECH-5195):

```sh
sgt admin restart          # reread the installation config and restart Sergeant on its current release
sgt admin update           # move to the newest green main commit its release channel would choose
sgt admin update v2.1.0    # or to a branch, tag, or commit, which must be on main with a green check
sgt admin status           # its release, when it last restarted, the last restart or update, and
                           # whether the installation config changed since (then: sgt admin restart),
                           # the retro target (or none), GitHub API calls left this hour, whether
                           # each webhook source is delivering (or an alert when it is not), and
                           # GitHub and Linear API calls this hour and last by what made them
sgt admin api --hours 24   # what spent the GitHub and Linear API budgets (up to 168 hours, kept
                           # across restarts): calls per hour by source and endpoint with GitHub's
                           # 304s, GitHub's budget windows with the calls serve did not make, each
                           # hour's lowest budget, rate-limit pauses and the tasks they paused, and
                           # low-budget warnings; --json adds every 5-minute budget sample. The MCP
                           # `health` tool returns the same for an approver's login
sgt admin retro set <projectId> <teamId> # validate both in Linear, then use the target at once
sgt admin retro off                     # remove the target and stop scheduling retros at once
```

The retro commands write only the installation config's `retro` block, and the parameter version
names the approver who changed it. They do not require AWS access or a restart, and a restart keeps
them: Sergeant takes its retro target from the parameter at every start. `set` refuses a
project or team id that does not exist in the installation's Linear workspace.

`restart` and `update` wait for the outcome and print it, with the reason when it failed (exit 1);
Sergeant is unreachable for part of it. How the host carries out each request, one at a time, is in
[`deploy/README.md`, Restart or update with `sgt`](../deploy/README.md#restart-or-update-with-sgt-tech-5195).

## 8. Enrolled repositories

Sergeant works only in the repositories its installation enrolls (TECH-5193). Anyone signed in can
list them; an approver enrolls or removes one with their own Linear login, no AWS access needed:

```sh
sgt repo list                                     # each repository, how Sergeant merges in it, and its budget window
sgt admin repo add <owner>/<repo> --merge-method rebase   # squash unless you say otherwise
sgt admin repo remove <owner>/<repo>
```

An approver also sets an enrolled repository's own budget window (TECH-6606), for one whose builds and
CI need more (or less) than the installation's. Each flag changes only its own field: a positive
number, or `default` to clear it so the installation's applies again.

```sh
sgt admin repo budget <owner>/<repo> --wall-minutes 60            # its cost stays as it was
sgt admin repo budget <owner>/<repo> --cost-usd 10 --wall-minutes 90
sgt admin repo budget <owner>/<repo> --wall-minutes default
```

`sgt repo list` marks each field that is the repository's own with `(own)`. Only budget windows that
open after the change get it: a task already working keeps its current window until its next fresh
one (Budgets, §5). How it reaches the installation's config is in
[`deploy/README.md`, Change the per-task budget](../deploy/README.md#change-the-per-task-budget).

A repository is enrolled only once both of Sergeant's GitHub Apps can reach it. The change is written
to the installation's configuration in AWS, naming who made it, and the running Sergeant takes it at
once. After a removal Sergeant stops working in that repository, tasks already started there included.

## 9. Sergeant in your AI assistant (`sgt-mcp`)

`sgt-mcp` gives an assistant that speaks MCP (Claude Code, Claude Desktop, Cursor, and others) the
read-only half of `sgt`: the tools `task_list`, `task_show`, `run_list`, `run_show`, `run_report`,
and `health`, answering what the matching `sgt` commands show. It cannot wake, cancel, or change
anything. It runs on your laptop from the same checkout as `sgt`, and calls your installation as you,
with the login `sgt login` saved (§4); there is nothing else to sign in to.

1. Log in with `sgt login`, once, as in §4. `sgt-mcp` renews the login as `sgt` does, and reads it
   on every call, so a later `sgt login` takes effect without restarting your assistant.
2. Register it with your assistant as a stdio server. Assistants usually do not start it from your
   shell, so they may not see your shell's `PATH` or `SGT_API_URL`. Give the installation with
   `--api`, and give Node as an absolute path: `sgt-mcp` needs Node 24 (§1), whose type stripping
   runs its TypeScript directly, and an assistant that finds an older system `node` instead fails.
   Use the output of `which node` in a shell where `sgt` works as `<node>`. For Claude Code:

   ```sh
   claude mcp add sergeant -- <node> <repo>/packages/mcp/src/sgt-mcp.ts --api https://<your installation's hostname>
   ```

   Other assistants take the same command in their MCP configuration, typically:

   ```json
   { "mcpServers": { "sergeant": { "command": "<node>", "args": ["<repo>/packages/mcp/src/sgt-mcp.ts", "--api", "https://<your installation's hostname>"] } } }
   ```

- Each tool is one GET to the installation's client API, and returns the API's JSON unchanged as
  structured content (errors as `{"error":{"code","message"}}` tool errors).
- `sgt-mcp` finds the API as `sgt` does: `--api`, else `SGT_API_URL`, else `http://127.0.0.1:8080`.
  With no login saved for that URL it sends none, which only a `serve --trust-loopback` on the same
  machine answers.
- `--api` must be the URL you logged in to: each URL has its own login. If you set `XDG_CONFIG_HOME`,
  pass it to `sgt-mcp` too (most assistants take an `env` setting), since your login is kept under it.
- If the server fails to start with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`, the
  assistant ran an older Node. Set `command` to the absolute path of Node 24, as in step 2.
- A tool that answers `unauthorized` has no usable login: it names the `sgt login --api <url>` to run.
  Run it, then ask again. `sgt update` updates `sgt-mcp` too; restart your assistant after updating.

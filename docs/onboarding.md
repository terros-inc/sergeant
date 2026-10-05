# Onboarding: delegating work to Sergeant

This page takes a Terros engineer from nothing to a Linear issue Sergeant is working on, on the hosted
Terros installation at `https://sergeant.terros.com`. It links to the reference instead of repeating
it: [`docs/sgt.md`](sgt.md) is the `sgt` user guide.

## 1. Before you start

**You need:**

- An active account in Terros's Linear workspace, in one of the Linear teams the installation admits.
  `sgt login` names those teams if you are in none of them.
- A Claude subscription (Claude Code installed) or a ChatGPT login for Codex (`npm install -g
  @openai/codex`). Sergeant's workers run on your account, not on a shared one (step 3).
- Node.js 24, pnpm (`corepack enable`), git, and read access to `terros-inc/sergeant` on GitHub
  ([`sgt.md` §1](sgt.md#1-prerequisites)).
- Write access on GitHub to the repositories you will hand work in, if any of them is merged by a
  human (step 4): there, you review and merge Sergeant's PR yourself.

**An admin does** (only if it is not already true):

- A Linear admin adds you to one of the admitted Linear teams. Access is rechecked on every call, so
  nothing in Sergeant needs to change for a new member of those teams.
- An approver (someone listed in the installation config's `humans.approvers`) enrolls any repository
  you need that `sgt repo list` does not show: `sgt admin repo add <owner/name> --merge-policy
  sergeant|human` ([`sgt.md` §8](sgt.md#8-enrolled-repositories)). Omitting `--merge-policy` means
  `human`.
- Optional: the operator adds your GitHub login to `linear.reviewerProfiles` in the installation
  config, so Sergeant's review requests mention you in Linear rather than as plain `@github-login`
  text. Making you an approver, or admitting another Linear team, is also an operator's config change
  ([`deploy/README.md`](../deploy/README.md#public-human-api-and-login-for-sgt-tech-4938-tech-4939)).

## 2. Install `sgt` and sign in

```sh
git clone https://github.com/terros-inc/sergeant.git
cd sergeant
pnpm install
pnpm install-sgt                                         # writes ~/.local/bin/sgt
echo 'export SGT_API_URL=https://sergeant.terros.com' >> ~/.zshrc   # or ~/.bashrc; open a new terminal
sgt login                                                # approve in Linear in the browser
sgt whoami                                               # you, and the repositories Sergeant works in
```

Details, and what to do if `sgt` is not on your `PATH`: [`sgt.md` §2–4](sgt.md#2-install). Keep it
current with `sgt update`: the installation refuses an `sgt` older than it supports and tells you to run
it.

## 3. Register your model account

Each task's owner pays (TECH-5179): a task's workers and reviewers run only on accounts its owner
registered. With none registered, Sergeant comments on your issue and nothing starts.

```sh
sgt account register claude    # runs `claude setup-token`; paste the token it prints
sgt account register codex     # or: runs `codex login` in a temporary CODEX_HOME
sgt account list               # yours shows up with your name
```

Read [`sgt.md` §6](sgt.md#6-model-accounts) once before registering: it explains how Sergeant picks
among your accounts, that the credential is used inside run containers, and how to remove and revoke it.

## 4. Delegate an issue

1. **Check the repository is enrolled**, and who merges there:

   ```sh
   sgt repo list
   ```

   A `sergeant` repository is merged by Sergeant once its Gate passes. In a `human` one (such as
   `terros-inc/sales`), Sergeant never approves or merges: it gets the PR green and reviewed, marks it
   ready, requests review (from the code owners, else you), and posts **Ready for a human to merge** on
   the PR and the issue. You merge it, and Sergeant then finishes the task.
2. **Write the issue** so it stands on its own: what to change, in which repository, and how to tell it
   is done.
3. **Assign it to yourself and delegate it to Sergeant yourself**, in Linear. The assignee is the
   owner whose accounts pay, and Sergeant starts only if Linear shows that same person delegated it. If
   someone else delegates an issue assigned to you, Sergeant refuses with a comment.
4. **Put it in Todo.** Sergeant starts work only from Todo, and moves the issue to In Progress when it
   does. Backlog and Triage never start, and a Todo issue with an unfinished Linear "blocked by" issue
   waits for it. Free task slots go to In Review, then In Progress, then Todo work, then by priority.

**Budget.** Each task gets a budget window, 120 minutes and $25 unless the installation config says
otherwise (`sgt task show` prints yours). When it runs out, Sergeant stops the runs and asks a
**Question for you** with the options to extend or accept the work as it is.

**Questions.** When only a human can decide, Sergeant posts a comment headed **Question for you** on
the issue and does nothing more until someone replies. Reply on the issue in your own words; when it
lists numbered options, a number is fine. Any answer gives the task a fresh budget window.

**Stopping it.** Undelegate the issue, or move it to Backlog, Canceled, or Done, or run
`sgt task cancel TECH-123 --reason "…"`. Sergeant cancels its runs, closes the PRs it opened, and says
so on the issue. Reassigning the issue to someone else stops it too, but keeps its PRs and puts the
issue back in Todo, undelegated, for the new assignee.

## 5. Watch the work

```sh
sgt task list                 # every task: status, turns, runs, last summary
sgt task show TECH-123        # the issue, budget, runs, recent turns
sgt run list --task TECH-123  # its runs, with their ids
sgt run show <run>            # one run: status, model, account, cost, outcome, PRs
sgt run report <run>          # the run's Markdown report
sgt task wake TECH-123        # ask for a turn now, after you changed something it should see
```

To ask your AI assistant about Sergeant's work, add the read-only MCP server `sgt-mcp`
([`sgt.md` §9](sgt.md#9-sergeant-in-your-ai-assistant-sgt-mcp)):

```sh
claude mcp add sergeant -- node <repo>/packages/mcp/src/sgt-mcp.ts --api https://sergeant.terros.com
```

The Linear issue stays the place to talk to Sergeant: it reads every comment on it, and on its PRs.

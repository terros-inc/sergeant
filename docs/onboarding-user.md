# Onboarding: delegating work to Sergeant

This page takes you from nothing to a Linear issue Sergeant is working on. It links to the reference
instead of repeating it: [`sgt.md`](sgt.md) is the `sgt` user guide. Already set up? Go to
[Delegate an issue to Sergeant in Linear](#4-delegate-an-issue-to-sergeant-in-linear). If something
here needs an approver or operator, they follow [`onboarding-admin.md`](onboarding-admin.md).

## 1. Before you start

- An active account in your installation's Linear workspace, in one of the Linear teams it admits.
  `sgt login` names those teams if you are in none of them; ask a Linear admin to add you to one.
- Your installation's API URL, from whoever runs it.
- A Claude subscription (Claude Code installed) or a ChatGPT login for Codex (`npm install -g
  @openai/codex`): Sergeant's workers run on your account (step 3).
- Node.js 24, pnpm, and git ([`sgt.md` §1](sgt.md#1-prerequisites)).
- Write access on GitHub to any human-merge repository you hand work in (step 4): there you review and
  merge Sergeant's PR yourself.

## 2. Install `sgt` and sign in

Install `sgt` from a checkout with `pnpm install-sgt` ([`sgt.md` §2](sgt.md#2-install)), then:

```sh
export SGT_API_URL=https://<your installation's hostname>   # in your shell profile
sgt login     # approve in Linear in the browser
sgt whoami    # you, and the repositories Sergeant works in
```

Keep it current with `sgt update`: the installation refuses an `sgt` older than it supports and tells
you to run it. More in [`sgt.md` §3–4](sgt.md#3-point-it-at-your-installation).

## 3. Register your model account

Each task's owner pays: its workers and reviewers run only on accounts its owner
registered. With none registered, Sergeant comments on your issue and nothing starts.

```sh
sgt account register claude    # runs `claude setup-token`; paste the token it prints
sgt account register codex     # or: runs `codex login` in a temporary CODEX_HOME
sgt account list               # yours shows up under your name
```

Read [`sgt.md` §6](sgt.md#6-model-accounts) once first: how Sergeant picks among your accounts, that
the credential is used inside run containers, and how to remove and revoke it.

## 4. Delegate an issue to Sergeant in Linear

1. **Check the repository.** `sgt repo list` shows the repositories Sergeant works in and who merges in
   each. In a `sergeant` repository Sergeant merges once its Gate passes. In a `human` one it never
   approves or merges: it gets the PR green and reviewed, marks it ready, requests review (from the
   code owners, else you if the operator configured your reviewer profile), and posts **Ready for a human to
   merge** on the PR and the issue; you merge it, and Sergeant then finishes the task. A repository not
   listed needs an approver to enroll it.
2. **Open or create the issue** in your installation's Linear workspace. Write it so it stands on its
   own: what to change, in which repository, and how to tell it is done.
3. **Assign it to yourself.** The assignee is the task's owner: their model accounts pay for it, and
   reassigning the issue later hands the task off.
4. **Delegate it to Sergeant yourself.** In the issue's properties sidebar, open the assignee menu and
   pick your installation's Sergeant agent. Linear records an agent as the issue's **delegate** and
   keeps you as its assignee. Creating the issue already delegated counts too, when you are its creator.
5. **Move it to your team's unstarted state** (normally Todo). Sergeant starts work only from a state
   of Linear's type *unstarted*; Triage- and Backlog-type states never start. An unstarted issue with
   an unfinished Linear "blocked by" issue waits until that one is done or canceled.

**What happens next.** Within a couple of minutes (or at once, when webhooks are set up) Sergeant picks
the issue up. When its first worker starts, Sergeant moves the issue to In Progress; if it asks first
(say, you have no usable model account), the issue waits in its unstarted state until you answer. The
worker opens a PR, which Linear links on the issue. Questions come as comments on the issue (below). After the
merge, Sergeant posts one outcome comment.

**When it refuses.** Sergeant starts only when Linear's history shows the assignee delegated the issue
themselves. If the issue has no human assignee, or someone else delegated it, or an app did it on your
behalf (such as an MCP connector), Sergeant posts one comment on the issue saying so, and nothing
starts. An app's delegation counts as yours only when the installation lists the app in
`linear.delegatingAppIds` and Linear names the user it acted for with exactly your display name.
To fix any of these, assign the issue to yourself, then remove the delegate and add it again yourself
in Linear. With no usable model account
registered, it says that instead (step 3).

**Budget.** Each task gets a budget window (`sgt task show` prints it). When it runs out, Sergeant
stops its runs and asks a **Question for you** with the options to extend or accept the work as it is.

**Questions.** When only a human can decide, Sergeant posts a comment headed **Question for you** and
does nothing more until someone replies. Reply on the issue in your own words; when it lists numbered
options, a number is fine. Any answer gives the task a fresh budget window.

**Stopping it.** Undelegate the issue, move it to Backlog, Canceled, or Done, or run
`sgt task cancel <issue> --reason "…"`. Sergeant cancels its runs, closes the PRs it opened, and says
so on the issue. Reassigning the issue stops it too, but keeps its PRs, removes Sergeant's delegation, and moves a
started issue back to its team's unstarted state (normally Todo) for the new assignee.

## 5. Watch the work

```sh
sgt task list                  # every task: status, turns, runs, last summary
sgt task show <issue>          # the issue, budget, runs, recent turns
sgt run list --task <issue>    # its runs, with their ids
sgt run show <run>             # one run: status, model, cost, outcome, PRs
sgt run report <run>           # the run's Markdown report
sgt task wake <issue>          # ask for a turn now, after a change it should see
```

To ask your AI assistant about Sergeant's work, add the read-only MCP server `sgt-mcp`
([`sgt.md` §9](sgt.md#9-sergeant-in-your-ai-assistant-sgt-mcp)). The Linear issue stays the place to
talk to Sergeant.

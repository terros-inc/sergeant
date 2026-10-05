# Onboarding: delegating work to Sergeant

This page takes you from nothing to a Linear issue Sergeant is working on. It links to the reference
instead of repeating it: [`sgt.md`](sgt.md) is the `sgt` user guide. If something here needs an
approver or operator, they follow [`onboarding-admin.md`](onboarding-admin.md).

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

Each task's owner pays (TECH-5179): its workers and reviewers run only on accounts its owner
registered. With none registered, Sergeant comments on your issue and nothing starts.

```sh
sgt account register claude    # runs `claude setup-token`; paste the token it prints
sgt account register codex     # or: runs `codex login` in a temporary CODEX_HOME
sgt account list               # yours shows up under your name
```

Read [`sgt.md` §6](sgt.md#6-model-accounts) once first: how Sergeant picks among your accounts, that
the credential is used inside run containers, and how to remove and revoke it.

## 4. Delegate an issue

1. **Check the repository is enrolled**, and who merges there, with `sgt repo list`. In a `sergeant`
   repository Sergeant merges once its Gate passes. In a `human` one it never approves or merges: it
   gets the PR green and reviewed, marks it ready, requests review (from the code owners, else you if an approver mapped your GitHub login),
   and posts **Ready for a human to merge** on the PR and the issue. You merge it, and Sergeant then
   finishes the task. A repository not listed needs an approver to enroll it.
2. **Write the issue** so it stands on its own: what to change, in which repository, and how to tell it
   is done.
3. **Assign it to yourself and delegate it to Sergeant yourself**, in Linear. The assignee is the owner
   whose accounts pay, and Sergeant starts only if Linear shows that same person delegated it. If
   someone else delegates an issue assigned to you, Sergeant refuses with a comment.
4. **Put it in Todo.** Sergeant starts only from Todo, and moves the issue to In Progress when it does.
   Backlog and Triage never start, and a Todo issue with an unfinished Linear "blocked by" issue waits
   for it.

**Budget.** Each task gets a budget window (`sgt task show` prints it). When it runs out, Sergeant
stops its runs and asks a **Question for you** with the options to extend or accept the work as it is.

**Questions.** When only a human can decide, Sergeant posts a comment headed **Question for you** and
does nothing more until someone replies. Reply on the issue in your own words; when it lists numbered
options, a number is fine. Any answer gives the task a fresh budget window.

**Stopping it.** Undelegate the issue, move it to Backlog, Canceled, or Done, or run
`sgt task cancel <issue> --reason "…"`. Sergeant cancels its runs, closes the PRs it opened, and says
so on the issue. Reassigning the issue stops it too, but keeps its PRs and puts the issue back in Todo,
undelegated, for the new assignee.

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

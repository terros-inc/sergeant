# Onboarding: admitting a new user

For approvers and operators of an installation. A new user follows
[`onboarding-user.md`](onboarding-user.md); this page is what they may need from you. Installation
setup itself is in [`deploy/README.md`](../deploy/README.md).

Who does what:

- A **Linear admin** manages Linear team membership.
- An **approver** is listed by Linear user id in the installation config's `humans.approvers`, and can
  run `sgt admin` with their own login (`sgt whoami` says `, an approver`).
- An **operator** edits the installation config in AWS. Every config change below is: edit the
  parameter, then `sgt admin restart` (an approver) or an Update
  ([`deploy/README.md`](../deploy/README.md), "Restart or update with `sgt`").

## 1. Admit them

Access needs an active Linear account in the installation's workspace that is a member of one of the
teams in `humans.teams`, checked on every call. A Linear admin adds the user to one of those teams;
nothing in Sergeant changes. Admitting another team, or making someone an approver, is an operator's
edit of `humans.teams` or `humans.approvers`
([`deploy/README.md`](../deploy/README.md), "Public human API and login for `sgt`").

## 2. Enroll their repositories

`sgt repo list` shows what is enrolled and each repository's merge policy. An approver enrolls one,
once both GitHub Apps can reach it:

```sh
sgt admin repo add <owner/name> --merge-policy human      # Sergeant hands the ready PR to a human
sgt admin repo add <owner/name> --merge-policy sergeant   # Sergeant approves and merges
sgt admin repo remove <owner/name>
```

Without `--merge-policy` a repository is `human`, and `--merge-method squash|merge|rebase` defaults to
`squash`. `--merge-policy` on an enrolled repository changes its policy. The running Sergeant takes the
change at once, with no restart
([`deploy/README.md`](../deploy/README.md), "Enrolled repositories"). In a human-merge
repository the user needs GitHub write access to merge.

## 3. Other settings

- **Reviewer profile.** Add the user to `linear.reviewerProfiles`
  (`"<github-login>": "https://linear.app/<workspace>/profiles/<user>"`). In a human-merge repository
  Sergeant requests the assignee's GitHub review only through this mapping (when no code owner was
  asked); without it nobody is requested and they find the PR from the issue. It also makes re-review
  requests mention them in Linear instead of as plain `@github-login` text.
- **Budget.** Every task gets the config's `budget` window (default 120 minutes and $25); it is not
  per user
  ([`deploy/README.md`](../deploy/README.md), "Change the per-task budget").
- **Model accounts.** Nothing to do: each user registers their own
  ([`deploy/README.md`](../deploy/README.md), "Model accounts").

## Offboarding

A Linear admin removes the person from the admitted teams, which ends their access. An approver
removes every model account they registered with `sgt admin account remove-person <linear-user-id>`
(`sgt account list --json` shows each account's id); the credential itself is revoked by the person
or their workspace admin ([`sgt.md` §6](sgt.md#6-model-accounts)).

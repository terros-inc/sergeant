# ADR-0020: Candidate branch push/PR/merge primitive (UNF-242)

## Status

Accepted.

## Context

UNF-237 (ADR-0017) built the GitHub App installation identity — token minting/caching
(`github::token`), a REST client (`github::client::GitHubClient`) with repo/branch reads, PR
create/read/update/merge, and check-run/review reads — but explicitly deferred the actual `git
push` wiring: `github::git_auth::authenticated_remote_url` existed only as a URL-shape helper
nothing called yet, per that ADR's "Git clone/fetch/push wiring is not part of this ticket's
deliverable."

UNF-197 (the autonomous Task→Run orchestrator, open as PR #40 at the time of this ticket) was
initially going to mark a Task `DONE` once its own review/test loop passed locally, without ever
pushing, opening, or merging anything. That's wrong against its own acceptance criteria ("a Task
dependency is satisfied by the usable merged/completed implementation state" — a local pass is not
a usable completed implementation) and is why this is a separate, formally-blocking ticket rather
than folded into UNF-197 itself: authenticating a real `git push` and PR/merge operation with the
App's installation token is new, security-sensitive surface deserving its own focused review.

UNF-197's orchestrator module does not exist on `main` at the time of this ticket (still
unmerged, and is itself being reworked to carry `candidate_run_id` rather than branch strings
through its internals). This ticket's design deliberately does not wait for or depend on that —
see the "Run-ID-agnostic interface" decision below.

## Decision

### Credential-helper push, never a token-embedded URL

`github::git_auth::authenticated_remote_url` (URL of the shape
`https://x-access-token:<token>@github.com/...`) is replaced in place — nothing had called it yet
— by:

- [`github::git_auth::remote_url`]: a credential-*free* URL
  (`https://x-access-token@github.com/owner/repo.git`). `x-access-token` is GitHub's fixed literal
  for App-authenticated HTTPS access, not a secret, so it's the only part of the URL that may ever
  reach a subprocess argv or a log line. Because it's already embedded, `git` only ever prompts for
  a password, never a username.
- [`github::git_auth::push_to_remote`]: runs `git push` against that URL with `GIT_ASKPASS` pointed
  at a short-lived, owner-only-permission (`0700`) shell script
  ([`github::git_auth::AskpassScript`], private to the module) that reads the installation token
  from an environment variable (`SERGEANT_GIT_ASKPASS_TOKEN`) and prints it — never a command-line
  argument. `GIT_TERMINAL_PROMPT=0` forbids `git` from ever falling back to an interactive prompt.
  The script is removed on drop. Both success and failure paths were verified to never put the
  token in `git`'s stderr/the function's returned error (see the test module).

  **Amended:** the push no longer runs in the Run's checkout. A worktree's hooks and config are
  worker-controlled (the shared bare cache's too, since every worktree's `.git` points at it). A
  planted `pre-push` hook inherited the token from the environment and could print it into the
  returned error, and `credential.helper`, `url.*.insteadOf`, or a proxy setting could redirect it.
  `push_to_remote` now resolves the branch's exact commit, stages it into a temporary bare
  repository Sergeant creates (borrowing the checkout's objects through `alternates`, which git
  reads as plain data), and pushes `<sha>:refs/heads/<branch>` from there on an isolated `git`
  (`git_auth::run_credentialed`): no system/global config, no hooks, no credential helper, no
  inherited `GIT_*` overrides, and the token redacted from any error. The authenticated
  clone/fetch (`workspace::repo_cache`) likewise runs only in a Sergeant-owned mirror, fetched from
  the credential-free URL rather than any URL read from config.

This was the ticket's central design question, and the credential-helper/`GIT_ASKPASS` approach was
chosen over `git`'s own documented token-in-URL mechanism specifically because a URL is a `git`
subprocess argument — visible in `ps`/process listings for the life of the process, and one `{:?}`
of the wrong thing away from a log line — while an environment variable a same-uid script reads is
not.

### `GitHubClient` gains `find_open_pull_request_by_head` and `installation_token`

Two small additions close the gap between what UNF-237 built and what "open a PR for a new
candidate branch, or update an existing one" needs:

- `find_open_pull_request_by_head` (`GET /repos/{owner}/{repo}/pulls?head=...&state=open`) — how a
  caller decides "create" vs. "update" without tracking a PR number itself.
- `installation_token` — exposes the already-cached/refreshed token for a caller (this ticket's own
  `candidate::publish_candidate_branch`) that needs to authenticate something other than this
  client's own REST calls, namely the `git push`. Calling it immediately before the push — rather
  than plumbing a token minted earlier in a longer flow — is what satisfies "mint fresh right
  before the push, don't reuse one that might have expired mid-operation": `InstallationToken
  Provider` already mints-or-serves-fresh on every call (5-minute refresh buffer, ADR-0017), so the
  freshness guarantee comes from *when* this is called, not new logic here.

`PullRequest` also gained `mergeable`/`mergeable_state` (from GitHub's own PR response fields) —
GitHub's own computed merge-readiness, incorporating whatever branch-protection/required-check
rules the repo already has (this ticket's non-goal: Sergeant does not reimplement that policy).
This is what "read PR/check status" means for the merge step; alongside the already-existing
`list_check_runs`/`list_reviews`/`merge_pull_request`, no new gate-evaluation abstraction was added
here — that policy belongs to whichever caller decides when to actually call `merge_pull_request`
(UNF-197's own gate structure, once it exists), matching `merge_pull_request`'s existing doc
comment ("this method performs the merge, it does not gate it").

`GitHubClient` also gained a `pub(crate)` `ensure_repo_allowed_for_push`, wrapping the same
allow-list check every REST method already runs. `publish_candidate_branch` calls it before
minting a token or pushing, because the push happens through `GitPusher`/`git`, not through this
client's own `call` — a push has no REST method to inherit the check from, so it needs its own
explicit call to the same guarantee.

### `github::candidate::publish_candidate_branch`: the one Run-ID-agnostic call

`github::candidate` is the self-contained primitive this ticket exists to provide: given a
`CandidateBranch` (owner/repo/local worktree path/branch/base ref — already resolved) and
`PullRequestMetadata` (title/body), `publish_candidate_branch` pushes the branch (via a `GitPusher`
trait — `InstallationGitPusher` in production, a recording fake in tests, same real-vs-fake seam
`GitHubTransport`/`SecretResolver` already use) and then finds-and-updates or creates the PR.

### Run-ID-agnostic interface: deliberately not wired into UNF-197 yet

UNF-197's orchestrator does not exist on `main` yet, and is itself still being reworked to carry a
`candidate_run_id` through its internals rather than a branch string. This ticket's interface takes
an already-resolved branch name and local worktree path — it has no notion of a Run, a Task, or a
`candidate_run_id` at all, so it does not need to change shape as UNF-197's own internals move.
When UNF-197's orchestrator lands, its own responsibility (already noted in
`docs/repo-map.md`'s "Not yet built") is: resolve `candidate_run_id` to a branch via
`workspace::store::get_workspace_for_run`, call `candidate::publish_candidate_branch`, read
`mergeable`/check-runs/reviews against its own configured gates, and call `merge_pull_request` —
only then may the Task reach `DONE`. This mirrors the same "build the piece, document the
integration point" pattern `preflight::check_before_dispatch` (UNF-230) and
`context_snapshot::store::create_snapshot` (UNF-213) already used ahead of UNF-197 landing.

## Consequences

- A candidate branch can be pushed for real using only the GitHub App installation token, with no
  static credential and no token ever appearing on argv, in a URL, or in a log — this ticket's
  central acceptance criterion.
- `github::git_auth`'s public surface changed shape (the old `authenticated_remote_url` is gone,
  replaced by `remote_url` + `push_to_remote`); the two doc-comment references to the old name
  (`workspace::provision`'s `PrepareWorkspaceInput::repo_source` doc, `docs/repo-map.md`) were
  updated to match.
- Still nothing in `sergeant-daemon`'s ticks or `worker::`/orchestrator dispatch calls
  `candidate::publish_candidate_branch` — same gap this ADR's "Run-ID-agnostic interface" section
  says is deliberate. A Task cannot yet actually reach `DONE` through a real merge, because the
  loop that would call this doesn't exist yet; UNF-197 remains blocked on this ticket only in the
  sense that the primitive it needs now exists to call.

## Live verification runbook — **[NOT YET EXECUTED]**

Same sandbox constraint as ADR-0017: nothing below has been run. Everything above is verified by
unit tests (`github::git_auth`'s own askpass/push tests against a local bare repository over a
plain filesystem path — not a real remote, so credential-helper behavior itself is verified in
isolation by directly invoking the generated script; `github::candidate`'s tests against
`FakeGitHubTransport`/a fake `GitPusher`). ADR-0017's runbook items 3-4 (push to a real repo, open a
PR, confirm the App is its author, merge it) are superseded by the more specific steps below —
before trusting this against anything that matters, someone with real access must, in order,
against a low-stakes test repository first (not a real Unforgotten repository):

1. **[NOT YET EXECUTED]** Using a real installation token (ADR-0017's runbook step 2), call
   `github::candidate::publish_candidate_branch` against a throwaway branch in a real, low-stakes
   test repo the installation can see. Confirm the branch appears on GitHub and a PR is opened,
   authored by the App (not the captain).
2. **[NOT YET EXECUTED]** Run it a second time against the same branch (new commit) and confirm the
   existing PR is updated in place, not a second PR created.
3. **[NOT YET EXECUTED]** Confirm the pushed branch's PR shows real `mergeable`/`mergeable_state`
   values, and that `list_check_runs`/`list_reviews` return sensible data once CI runs.
4. **[NOT YET EXECUTED]** Confirm `merge_pull_request` actually merges it, and that the merge shows
   the App as the actor.
5. **[NOT YET EXECUTED]** Confirm the installation token never appears in shell history, `ps`
   output captured during the push, or any log line Sergeant's own process/deploy logging emits —
   inspect this directly during step 1's push, not after the fact.
6. **[NOT YET EXECUTED]** Confirm a push to a repository *not* in `GitHubAppConfig
   .allowed_repositories` is rejected before any push or API call is attempted (this is
   `GitHubClient::ensure_repo_allowed_for_push`, called by `publish_candidate_branch` before it
   mints a token or pushes, already covered by unit tests — this step is the live confirmation
   only).

Until this runbook has actually been run, treat `candidate::publish_candidate_branch` and
`git_auth::push_to_remote` as reviewed-but-unproven, the same status ADR-0017 left its own
implementation in.

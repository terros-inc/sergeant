# ADR-0017: GitHub App automation identity, not a PAT or the captain's credentials

## Status

Accepted. `github::git_auth::authenticated_remote_url`, referenced throughout this ADR as the
future git push mechanism, was replaced (not called by anything yet, so no callers to migrate) by
a credential-helper design — see
[ADR-0020](0020-github-candidate-push-pr-merge.md#credential-helper-push-never-a-token-embedded-url)
— once UNF-242 actually wired up the push. Everything else in this ADR still stands.

## Context

`docs/security/threat-model.md#11` already named "GitHub App installed on
the specific repos Sergeant operates on, authenticating with short-lived
installation tokens" as the preferred long-term direction, with a
fine-grained PAT as the interim step. UNF-237 is that migration: the
Unforgotten Sergeant instance needs a real, dedicated GitHub automation
identity before any worker adapter clones/pushes/opens a PR against a real
repository, and it must never be the captain's personal token/SSH key or a
long-lived PAT.

PR #25 (UNF-216, `sgt doctor`) had already built a check against a bare
`GITHUB_TOKEN` env var + `GET /user` before this ticket landed — reviewed
and correctly flagged as architecturally stale the moment the GitHub App
model was adopted, since it would tell an operator "GitHub isn't
configured" on a machine that's actually correctly configured via the App.
This ticket's `github::` module is what that check (in a follow-up PR,
once PR #25 rebases onto this) calls instead.

## Decision

**One private GitHub App per Sergeant deployment, never shared across
trust boundaries.** `Sergeant Unforgotten` (App ID 4915715, installation
161014053) is owned by the captain's personal GitHub account and installed
only on the Unforgotten/Sergeant repositories the control plane needs. A
future Terros deployment gets its own separately-owned `Sergeant Terros`
App installed in `terros-org` — never this App's key, never this
installation. Nothing in `github::` or the Task/Run domain model encodes
which App/installation is in play; that's entirely
[`github::config::GitHubAppConfig`], one instance's worth of
configuration, same role `linear::config::LinearConfig` plays for Linear.
Swapping deployments is swapping the `GitHubAppConfig` a daemon is started
with, not a code change.

**Short-lived installation access tokens, minted on demand, never a
long-lived PAT for steady state.**
[`github::token::InstallationTokenProvider`] signs an App-level JWT
(RS256, ≤10 minute validity per GitHub's own ceiling —
[`github::jwt::sign_app_jwt`]) only to exchange it for an installation
access token (~1 hour validity), caches that token, and refreshes it
proactively (5 minutes before expiry) rather than on failure. Everything
else in `github::` — [`github::client::GitHubClient`]'s REST calls,
and eventually git clone/fetch/push via
[`github::git_auth::authenticated_remote_url`] — authenticates with the
installation token, never the App JWT directly and never a PAT.

**Config-driven repo allow-list, enforced in code, not just trusted to
installation scope.** `GitHubAppConfig.allowed_repositories` is a second,
explicit gate `GitHubClient` checks on every repo-scoped call
(`ensure_repo_allowed`) — independent of whatever the installation happens
to include. Today the captain's installation is scoped to "all
repositories" on the account (see the operator note below); this allow-list
is what keeps Sergeant itself from touching a repo beyond what its own
config names, and it's the mechanism a later narrower installation slots
into without a code change.

**Minimum permission surface, expand only when a concrete call needs
more.** Contents (read/write), pull requests (read/write), checks (read) —
matching exactly what `GitHubClient` implements (repo/branch reads, PR
create/read/update/merge, check-run/review reads) and nothing broader
(no Administration, Secrets, Environments, Deployments, Members, or
org-wide scope). Actions (read) was evaluated and skipped: nothing in this
module needs workflow-run data beyond what Checks already exposes.
UNF-613 amends this with **Actions (read and write)**, the concrete need
being the `persona-eval` capability's executor: it dispatches exactly one
authorized workflow from `main` and reads that run and its artifacts
(ADR-0037; `docs/runbooks/sergeant-github-app-credentials.md` §7).

**No webhook handling in this module.** The ticket's own scope defers this
until a stable public HTTPS webhook ingress exists; none does yet —
`sergeant-daemon`'s `http/` surface is Task/Run query API only (see
`docs/repo-map.md`), and Linear's own equivalent integration (`linear/`,
UNF-227) is polling/reconciliation-based, not webhook-driven, so there is
no "shared minimal ingress architecture" yet to reuse. Building one here
would be inventing infrastructure ahead of a concrete second consumer —
exactly what the ticket's non-goals warn against. When a webhook ingress
exists, `github::` gets a narrow event-subscription/signature-verification
addition scoped to whatever events the review/test/merge loop actually
needs (pull request/check-related), not a broad event mirror.

**Shape mirrors `linear::` throughout**, for the same reasons that module
gives: [`github::transport::GitHubTransport`] is the real-vs-fake seam
(`transport::fake::FakeGitHubTransport` drives every test in this crate);
[`github::secret::SecretResolver`] plays the same role for the private
key, so the JWT signer ([`github::jwt::sign_app_jwt`]) never depends on
*how* the key was fetched. `github::transport_live::LiveGitHubTransport`
(HTTPS via `ureq`) and `github::secret_aws::SecretsManagerResolver` (real
AWS Secrets Manager reads) are real, production-shaped implementations
behind the `github-live` cargo feature — mirroring `storage::s3`'s
pattern exactly: compiled and reviewable, never built or exercised by
`cargo test` in this crate, and not yet proven against the real App/
installation (see the runbook below).

**Git clone/fetch/push wiring is not part of this ticket's deliverable.**
`github::git_auth::authenticated_remote_url` provides the mechanism (the
`https://x-access-token:<token>@github.com/...` URL shape GitHub
documents), but nothing in `worker::local`'s git subprocess helpers calls
it yet — there is no existing "clone/push to a remote" operation in this
repo to retrofit; today's local worker only creates git worktrees from an
already-local checkout. Wiring a real dispatch flow to use it is future
work, same pattern as `worker::claude`/`worker::local` landing ahead of
the daemon calling them (see `docs/repo-map.md`'s "Build order").

## Consequences

- A worker or the daemon can act on GitHub without ever holding the
  captain's personal token/SSH key — the acceptance criterion this ticket
  exists for.
- The exposure window of any single leaked credential is roughly an
  installation token's lifetime (~1 hour) rather than a PAT's, and rotating
  the App's private key (Secrets Manager entry update) requires no code or
  domain-model change, matching `docs/security/threat-model.md#8`'s
  rotation story.
- `Connection.provider == "github"`/`credential_ref` (the permission
  model's shape, not yet wired to a real caller — see ADR-0008) is
  unaffected: `GitHubAppConfig.private_key_secret_ref` is exactly the kind
  of secret-store pointer `credential_ref` already models, so wiring
  `permissions::authorize()` to a real GitHub-scoped grant later is
  additive, not a redesign.
- Nothing in `sergeant-daemon`'s ticks or `worker::` dispatch calls
  `github::` yet, same as `linear::` today — this lands the credential
  foundation and API surface, not the orchestration wiring. That wiring
  (git operations during a run, PR creation/merge decisions in the review/
  test/merge loop) is separate follow-up, tracked by the still-open
  UNF-197/198/199/203 tickets `docs/repo-map.md` lists under "Not yet
  built."
- `crates/sergeant-cli/src/commands/doctor/github.rs` does not exist on
  `main` yet (it lives on PR #25's not-yet-merged branch). Updating it to
  check GitHub App configuration/reachability through this module instead
  of `GITHUB_TOKEN`/`GET /user` is PR #25's own follow-up once it rebases
  onto this change, per the captain's explicit direction — not done here.

### Operator-visible gap found during implementation (not fixed here)

`deploy/terraform/iam.tf` (PR #29, also not yet merged) scopes the
Unforgotten instance role's `secretsmanager:GetSecretValue`/
`DescribeSecret` grant to the prefix
`arn:...:secret:${var.secrets_manager_path_prefix}*`, defaulting to
`sergeant/staging/` — an environment-tier prefix (`sergeant/<env>/...`).
The private key the captain already created lives at
`sergeant/<installation>/github-app-private-key`, which does **not** start
with `sergeant/staging/` (it's keyed by deployment name, not environment
tier). As drafted, the instance role in PR #29 would not actually be able
to read this secret. This spans two branches neither owned by this ticket
(this PR only adds code, no Terraform; PR #29's worktree is a different
in-flight task) — flagged here for whoever lands PR #29 (or a follow-up)
to reconcile, either by widening/adding an IAM statement for the
`sergeant/<installation>/` prefix or by moving the secret to an env-scoped
path. Not a blocker for this ticket: nothing here depends on the instance
role's IAM policy at build/test time.

## Live verification runbook — **[NOT YET EXECUTED]**

Per this ticket's explicit sandbox constraint, none of this has been run:
the crewmate implementing it never fetched the real private key, signed a
real JWT with it, or called GitHub's or AWS's real APIs. Everything above
is verified by unit tests against a throwaway test RSA keypair
(`crates/sergeant-core/tests/fixtures/github_app_test_key*.pem`, generated
locally and never registered with GitHub) and a fake transport/secret
resolver. Before trusting this against anything that matters, someone
with real access must, in order, against a low-stakes test repository
first (not a real Unforgotten repository):

1. **[NOT YET EXECUTED]** Confirm the instance role (or an operator's own
   scoped AWS credentials) can actually read
   `sergeant/<installation>/github-app-private-key` — resolve the IAM gap
   noted above first if it's still open.
2. **[NOT YET EXECUTED]** Using that key, sign one real App JWT and call
   `POST /app/installations/161014053/access_tokens`; confirm a token
   comes back and that `GET /installation/repositories` with it lists
   exactly the expected repositories (not more).
3. **[NOT YET EXECUTED]** Against one throwaway test repository the
   installation can see: clone it using
   `github::git_auth::authenticated_remote_url`'s URL shape, create a
   branch, push it, and open a PR via `GitHubClient::create_pull_request`.
   Confirm the PR shows the App as its author, not the captain.
4. **[NOT YET EXECUTED]** Confirm `GitHubClient::list_check_runs`/
   `list_reviews` return sensible data for that PR, and that
   `merge_pull_request` actually merges it.
5. **[NOT YET EXECUTED]** Confirm a repository *not* in
   `GitHubAppConfig.allowed_repositories` (but still within the
   installation's broader "all repositories" scope today) is correctly
   rejected by `ensure_repo_allowed` before any request is sent.
6. **[NOT YET EXECUTED]** Only after 1-5 pass: point `GitHubAppConfig` at
   a real Unforgotten repository sergeant-core actually needs and repeat
   step 3's PR-creation check once against it.

Until this runbook has actually been run, treat the `github-live`-gated
implementations as reviewed-but-unproven, the same status UNF-207 left its
own resilience/destroy tests in.

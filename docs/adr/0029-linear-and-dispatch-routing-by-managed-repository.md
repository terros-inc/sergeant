# ADR-0029: route Linear intake and Task dispatch by managed repository

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: `run_repositories` is now `runs.repo_slugs_json`, `task_pending_repo_scope` is now `tasks.pending_repo_scope_json` (both via `domain::repo_scope`), and `run_workspaces` is renamed `workspaces`. The migrations cited below were replaced by the V2 `0001_init.sql`. The routing rules below still stand.

Amended by [ADR-0038](0038-planner-first-repository-selection.md) (UNF-569): a Task's first mutating repository now normally comes from its repo-less Planner Run's accepted plan (`ScopeSource::Planner`), a nonmutating Run's structured proposal validated by the same deterministic check; the human decision is asked only when the plan names none.

Accepted. Unit/integration-tested Rust only (fake Linear/GitHub transports, real SQLite, real git
worktrees against local fixture repos) — no live multi-repo verification against the real
Unforgotten installation. That happens separately, outside a sandboxed task worktree, with a
human/Firstmate holding real AWS credentials driving it explicitly (this machine's crewmate
worktrees inherit real ambient AWS credentials, so nothing here was run against them — see
UNF-394's own launch brief).

**Corrected by UNF-403.** This ADR's original decision put repository routing on the *Task*: a
Task's `repo_slug` was resolved once, at Linear-intake materialization time, from the originating
issue's Linear project (`domain::managed_repositories::get_managed_repository_by_linear_project`),
and every later stage (dispatch, workspace, GitHub identity) read that one persisted Task-level
value back. That coupled Linear project membership — workflow/product organization metadata — to
repository identity, and assumed a Task only ever needs one repository for its whole lifetime.
Neither holds: a Sergeant installation connects to one Linear workspace containing many projects,
and a single Task (one Linear issue) may legitimately need Runs against more than one repository
over its lifetime, as long as each *mutating* Run still targets exactly one.

The corrected model, in full, in `docs/adr/0028`'s own Status note and this file below: repository
scope belongs to the **Run**, not the Task or Linear project. `tasks.repo_slug`
(`migrations/0016_task_repo_slug.sql`) and `managed_repositories.linear_project_id`
(`migrations/0015_managed_repositories.sql`) are both dropped outright
(`migrations/0019`–`0020`). A new `run_repositories` table
(`migrations/0021_run_repositories.sql`, `domain::run_repositories`) records the repository (or,
for a nonmutating Run, repositories) each Run was explicitly authorized to touch, persisted before
worker launch and deterministically validated (enrolled, and — for a mutating Run — enabled) by
that same module; a Task's *next* mutating Run's repository target is tracked separately as an
explicit pending proposal (`domain::task_repo_scope`), sourced only from an operator/admin's direct
input (`POST /tasks/:id/repo-scope`) or a validated structured proposal from a nonmutating
"repository-scope scout" Run (`orchestrator::repo_scope`) — never inferred, guessed, or decided by
an LLM call inside Sergeant's own control plane. `implementation_tick::resolve_task_repo` reads a
Task's *latest* Run's own already-resolved scope when one exists, or that pending proposal when it
doesn't, and fails closed (escalates a Linear decision, exactly like any other stuck condition) when
neither yields a valid target — see that function's own doc comment.

**Narrowed by UNF-470 / ADR-0031.** Run-level scope remains the authorization and provenance
mechanism, and a cross-repository scout may still inspect multiple enrollments. Coding V1 now
binds a coding Task to the first non-scout repository in its Run history: later mutating Runs and
pending proposals must name that same repository. A request that genuinely needs another
repository is decomposed into a separate, explicitly-dependent coding issue outside this lifecycle.
This replaces UNF-403's allowance for one Task to mutate different repositories over time; its
separation of Linear project metadata from repository routing remains intact.

Everything below this note describes the **original UNF-394 decision** for historical context.
Where a later section's own claim was corrected, it says so inline; the GitHub allow-list/webhook-
relevance/tool-lookup/same-seam-overlap pieces were only ever keyed off `repo_slug` values (never
`linear_project_id` or `Task.repo_slug` themselves), so those particular mechanisms are unaffected
by this correction beyond reading their `repo_slug` from a Run's own scope instead of a Task's.

## Context

Every build before this ticket assumed one Sergeant installation supervises exactly one
repository: `SERGEANT_LINEAR_PROJECT_ID` narrowed Linear discovery to one project,
`SERGEANT_REPO_ROOT`/`SERGEANT_REPO_SLUG` named the one repository `workspace::provision`
clones/fetches, and `SERGEANT_GITHUB_OWNER`/`SERGEANT_GITHUB_REPO` named the one repository GitHub
push/PR/merge targets. UNF-393 (ADR-0028) added `domain::managed_repositories` — the durable
enrollment table recording which repositories an installation manages and which single Linear
project routes work to each — but deliberately wired nothing to it, leaving that "for UNF-394."

## Decision (original UNF-394 shape — see this ADR's Status note for UNF-403's correction)

**Admission resolves and persists a Task's repository once, at materialization time; every later
stage reads it back from the Task/Run, never from daemon-wide config again.**

> **UNF-403 correction:** this whole premise — a Task has one repository, resolved once at
> admission — was replaced. `linear::intake::materialize_task` no longer takes or persists a
> `repo_slug` at all; `Task.repo_slug`/`migrations/0016_task_repo_slug.sql` and
> `managed_repositories.linear_project_id`/`migrations/0015_managed_repositories.sql` are both
> dropped. Admission now admits an eligible issue regardless of its Linear project — see this
> ADR's Status note for where repository scope moved instead.

- ~~`linear::intake::materialize_task` gains a `repo_slug` parameter and persists it on the created
  `Task` (`migrations/0016_task_repo_slug.sql`, `domain::tasks::Task::repo_slug`) — a natural-key
  snapshot, not a live foreign key to `managed_repositories`, matching `Run::resolved_context`'s
  own "provenance, not a joinable reference" precedent (ADR-0014): removing or disabling an
  enrollment later never retroactively changes what an already-admitted Task targets.~~
- ~~`ticks::linear_intake_tick` is the single admission choke point (unchanged from UNF-236) and now
  resolves each newly-discovered issue's own Linear project (`LinearIssue::project_id`, newly
  selected by `ISSUE_QUERY`) against `domain::managed_repositories::get_managed_repository_by_linear_project`
  immediately before materializing. No project, no mapped repository, or a mapped-but-disabled
  repository are all treated identically: skip this issue, log why, never materialize a Task, and
  never guess. `linear_project_id` is `UNIQUE` at the schema layer (ADR-0028), so "ambiguous" (two
  repositories mapped to the same project) is structurally impossible once enrolled through
  `enroll_repository` — this fail-closed check exists for defense in depth, not because the
  lookup can plausibly return more than one row today.~~ (UNF-403: intake performs no repository
  resolution at all any more — see the Status note above.)
- The old `SERGEANT_LINEAR_PROJECT_ID` single-project narrowing on `LinearConfig` is removed
  outright (not deprecated): `linear::intake::discover_eligible_issues` now discovers every
  delegated, unresolved issue on the configured team, and per-issue routing decides admission
  instead.
- **Workspace provisioning/dispatch**: `implementation_tick` (daemon) resolves each dispatched
  Task's own repository fresh, every tick, from its persisted `repo_slug` (UNF-403: now via
  `implementation_tick::resolve_task_repo` — a Task mid-candidate-cycle continues its latest Run's
  own already-resolved `domain::run_repositories` scope; a fresh Task reads its explicit
  `domain::task_repo_scope` pending proposal, re-validated at read time — rather than a Task-wide
  `repo_slug` column, which no longer exists) — `domain::managed_repositories::get_managed_repository`
  for the enrollment row, then `workspace::repo_source::RepoSource::parse(&repo.source_url, cwd)`
  for the credential-free clone source (UNF-368's `RepoSource` needed no changes: it was already a
  per-call value, never a type baked into daemon `Config`). `ImplementationDeps` (the per-dispatch
  bundle `advance_task` and every `LoopStep` arm already threaded through unchanged) keeps its
  exact pre-existing shape; only its *construction* moved from once-per-tick (in
  `loops::run_implementation_loop`, from daemon-wide `Config` fields) to once-per-Task (inside
  `implementation_tick`'s own loop, resolved as above). The genuinely tick-wide dependencies
  (store, worker, Linear client, retry/safety policy, drain gate, ...) moved into a new, smaller
  `SharedDeps`/`SharedGitHubDeps` pair so the daemon-wide `Config` no longer carries a
  `repo_source`/`repo_slug` field at all — there is no longer a "the" repository this V1 daemon
  supervises, per instance, nor a "the" repository any one Task supervises, per Task.
- **GitHub identity is decoupled from clone mechanism.** `GitHubDeps::owner`/`repo` are derived by
  splitting the Task's own managed repository's `repo_slug` (always validated `"owner/repo"` at
  enrollment time — `admin_repo::validate_repo_slug`), never by pattern-matching `RepoSource`'s
  variant. This is deliberate, not incidental: a repository cloned from a local checkout
  (`RepoSource::Local` — self-hosted git, or a fast local-worktree test fixture with no network
  access) can still legitimately push/PR/merge through the GitHub App against its own real
  `owner/repo` identity, exactly as a `RepoSource::GitHubApp` source does. `resolve_installation_token`'s
  existing "a `Local` source never needs an installation token" gate remains the only place clone
  mechanism and GitHub API identity interact.
- **GitHub App allow-list**: `GitHubAppConfig::allowed_repositories` (the credential-safe "this
  instance's App identity may only touch these repos" guard `GitHubClient::ensure_repo_allowed`
  already enforced on every call — ADR-0017) is now built from every currently enrolled managed
  repository's `repo_slug` (enabled or not — this is a credential boundary, not a work-routing
  gate; an in-flight Run against a since-disabled repo must still be able to complete), read once
  at daemon startup, replacing the fixed `SERGEANT_GITHUB_OWNER`/`SERGEANT_GITHUB_REPO` pair. The
  GitHub App identity itself (`app_id`/`installation_id`/private key) is still resolved once at
  startup, unchanged — only which repositories it may operate on now comes from the routing table.
  **Known follow-up, not built here**: this allow-list is not hot-reloaded — a repository enrolled
  after the daemon starts is immediately routable for Linear intake/dispatch (`ticks`/
  `implementation_tick` re-read `managed_repositories` fresh every tick) but needs a daemon restart
  before its GitHub push/PR/merge calls pass `ensure_repo_allowed`. Acceptable for now because the
  ticket's own acceptance criterion is "both repos already enrolled, intake/dispatch works for both
  without a restart *between tasks*" — not "a brand-new enrollment takes effect with no restart at
  all." **UNF-402 update:** built since, by dropping the startup snapshot rather than
  reloading it. `GitHubAppConfig` now takes a live membership check
  (`github_instance::enrolled_repository_membership`): every `ensure_repo_allowed` decision does one
  authoritative `managed_repositories` lookup for that slug, and a database error fails closed.
  `sgt admin repo add`/`remove` write that database from a separate on-box process the daemon is
  never notified by, so a per-decision lookup — not a cache, which would need an invalidation
  protocol to observe removals and to stop an older concurrent reload overwriting a newer one — is
  what makes an enrollment or a removal take effect from the next GitHub side effect without a
  restart.
- **GitHub webhook relevance** (`POST /webhooks/github`) was previously a single
  `GitHubHttpState::repo_full_name` string comparison; it's now a live
  `domain::managed_repositories::get_managed_repository` lookup against `AppState::db_path` at
  request time, so a newly enrolled repository's webhook deliveries are recognized without a
  restart (unlike the allow-list above — this is a pure relevance filter with "harmless to miss"
  semantics already established by this endpoint's own design, not a credential boundary).
- **`sergeant.toml` loading** needed no change: `repo_config::resolve_context`/`RepoConfig::load_from_repo`
  were already parametrized on `repo_root`/`repo_slug` per call (ADR-0014); only the daemon-side
  caller now supplies the Task's own values instead of `Config`'s.
- **Tool lookup** (`sgt tool configure|status|logout`, `sgt tools`, UNF-361): `/tools*` routes
  gain a `:repo_slug` path segment (`/repos/:repo_slug/tools/...`), and `sgt tool *`/`sgt tools`
  gain a required `--repo <slug>` flag. `AppState::tool_repo_root` (a single optional local
  checkout path) is removed; each request resolves its own checkout root from
  `domain::managed_repositories` via `AppState::db_path`, degrading to the same
  `unsupported_repo_source` response a `RepoSource::GitHubApp`-sourced repository already produced
  before this ticket (no persistent local checkout outside a per-Run worktree) — a known,
  pre-existing V1 limitation this ticket does not attempt to lift.
- **Same-seam dispatch-concurrency detection** (UNF-254, `preflight::overlap`) also assumed a
  single repository: `gather_active_run_files` compared a new Task's predicted file scope against
  *every* other active Run's changed files, trusting that "another active Run exists" implied "in
  the same repository." That's false once `run_workspaces` holds workspaces from more than one
  managed repository — two unrelated repositories sharing a common path (`README.md`,
  `src/main.rs`, ...) would otherwise be flagged as a same-seam collision. `gather_active_run_files`
  now takes `repo_slug` and filters to `Workspace::repo_slug` matches only (see below).
- **`run_workspaces.repo_slug`** (`migrations/0017_run_workspace_repo_slug.sql`) is a new column
  recording the actual bare-clone cache key (`repo_cache::bare_clone_path`'s `repo_slug` argument)
  a worktree was created from — distinct from the pre-existing `repo_source` column (the original,
  possibly-different config value a workspace was cloned from; UNF-271 already established that
  `remove_workspace` must never address the bare clone via `repo_source`). Before this ticket,
  `workspace::cleanup::remove_workspace` and `ticks::workspace_maintenance_tick` took a single
  daemon-wide `repo_slug` parameter naming "the" bare clone to prune; now that more than one
  repository's workspaces coexist in the same `run_workspaces` table, `remove_workspace` reads
  `repo_slug` off each workspace's own row instead, and the maintenance tick's `git worktree prune`
  pass iterates every enrolled managed repository rather than pruning one fixed cache.

## Consequences

- `SERGEANT_LINEAR_PROJECT_ID`, `SERGEANT_REPO_ROOT`, `SERGEANT_REPO_SLUG`, `SERGEANT_GITHUB_OWNER`,
  and `SERGEANT_GITHUB_REPO` are gone from `sergeant-daemon::config::Config` entirely — not
  deprecated, not silently ignored, removed. `sgt doctor`'s own local `SERGEANT_REPO_ROOT`
  convenience (checking whether the *current directory* has a `sergeant.toml`, entirely independent
  of the daemon's routing model) is untouched.
- One running Sergeant installation can intake work for, and dispatch Runs against, every
  currently enrolled managed repository concurrently, without a restart between Tasks targeting
  different repositories — the ticket's core acceptance criterion.
- **Not built** (deliberately, per the ticket's own "one Linear project -> one managed repository,
  one Task targets one repository" scope): multi-repo Tasks, cross-repo transactions, automatic
  work decomposition across repositories, and hot-reloading the GitHub App allow-list without a
  restart (see above — since built by UNF-402). **UNF-403 correction:** "one Task targets one repository" was the exact
  premise this later ticket removed. ADR-0031/UNF-470 restored one repository per coding Task as
  an intentional Coding V1 product boundary (without restoring Linear-project routing): multiple
  repositories require separate dependent coding issues. Automatic cross-repo decomposition,
  cross-repo transactions, and one mutating Run touching multiple repositories remain out of scope.

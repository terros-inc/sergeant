# ADR-0038: Planner-first repository selection

## Status

Accepted (UNF-569). Amends [ADR-0029](0029-linear-and-dispatch-routing-by-managed-repository.md)
and [ADR-0031](0031-coding-v1-task-lifecycle-integration-ownership-waits-and-workspace-retention.md)
where they describe how a Task's first mutating repository is chosen. Retires the UNF-484 literal
title/description match and the UNF-456 TypeSafe/Jev classifier as repository-selection layers;
Jev stays wired for decision interpretation and SME adjudication (UNF-531).

Amended by UNF-625 (Captain direction 2026-09-30): the multi-repository stopgap below is replaced
by "do the first repository on this Task, spin the rest into follow-up issues" -- see
**Multi-repository plans**.

## Context

The Planner (`ROLE_SIMPLIFY`, UNF-341) used to run inside the Task's retained mutation worktree,
and that first Run is what bound the Task to its repository. So something had to choose the
repository before the Planner could run: an exact slug in the issue text, then Jev, then a human
"Which repository should this task use?" decision. The Planner could only see one repository, so it
could not follow the architecture into another repository or read a second repository's guidance.
At roughly ten enrolled repositories, it is simpler and more accurate to let the Planner itself
choose, from the full catalog, with real read access.

## Decision

**The first Planner Run starts without a selected mutation target.** A Task with no established
repository and no pending scope no longer escalates or asks Jev. It advances through the normal
`implementation_tick` path with no repository bound, so the ordinary scheduling, preflight,
blocker, drain, safety-governor, worker-account, retry, fresh-run, cancellation, and recovery
controls all apply unchanged. Any step other than dispatching the Planner, waiting on it, retrying
it, escalating its decision, or binding its plan fails loudly as a tick error rather than guessing
a repository.

**Planner working directory.** The Planner Run is dispatched through the ordinary
`dispatch_run_at` choke point with a planning target instead of a repository target. Its working
directory is a scratch directory, `<run_workspace_root>/planning/<run_id>/`, never a repository
worktree. It holds a read-only inspection checkout of every enabled managed repository at
`repos/<owner>/<repo>/`: a `git clone --no-hardlinks` of Sergeant's existing bare-clone cache
(after the usual fetch) -- an independent copy of its objects -- detached at that repository's base
ref, with its remote and reflogs removed. These are
disposable files, not workspaces: they register no `workspaces` row and no worktree or branch in
the bare cache, so there is nothing to preserve and no ownership to reconcile. A repository that
cannot be materialized -- including one whose enrolled `source_url` doesn't parse -- stays in the
Run's scope and is listed in the prompt as unavailable, rather than being dropped or failing the
whole Run.

**Nonmutating by structure.** The checkouts are made read-only on disk right after they are created
(never following a symlink), so an ordinary edit or commit fails. Because the worker runs as the same
OS user and could restore write permission, each checkout's state is also recorded in the Run's
provenance -- `HEAD`, git config digest, and the bare cache's `config`/`HEAD` digests -- and
re-verified when the Run finalizes, along with a clean index/working tree (untracked and ignored
files included) and no remotes. A Planner Run that reports success after changing any of it is
failed closed (`FailureClass::Deterministic`); its plan is never trusted.

The persistent bare cache is protected by isolation, not comparison. A checkout is an independent
copy: no alternates file, remote, or reflog in it names the cache, so the checkout offers no route
to rewrite the cache's refs, such as another Task's retained `sgt/*` branch. (`--shared` would
have: its alternates file points at the writable cache.) The cache's refs are not compared after
the fact, because other Tasks legitimately fetch and commit into the same cache concurrently, so a
comparison couldn't tell a Planner's write from theirs.

**Residual, out of scope.** This defense is scoped to the inspection checkout. Workers run as the
same OS user as Sergeant, so a worker that independently locates the cache, or any other Sergeant
state, on disk could still write to it. Preventing that needs an OS-level sandbox or mount
boundary enforced for every provider, which this change deliberately does not build.

**Inspection scope.** The Planner Run's repository scope is recorded with the existing nonmutating
primitive (`set_nonmutating_run_repositories`) as every enabled repository it was given. A Planner
Run with no workspace, like a scope-scout Run, is never repository authority:
`established_task_repository` ignores it.

**Catalog and progressive disclosure.** The prompt carries the complete enabled catalog
(slug + `purpose`). The Planner reads guidance (`AGENTS.md`, `sergeant.toml`, README) from
candidate checkouts before inspecting code in the ones that stay relevant. Repository names in the
issue are hints only.

**Binding the plan to a Task scope.** The plan's `work_units` are the authoritative mutation list.
After the plan passes the existing deterministic checks (every named repository enrolled and
enabled), `decide::next_step` returns `DispatchImplementation` as before. When no repository is
bound yet, the daemon binds instead of dispatching:

- at least one mutated repository: record the first (see **Multi-repository plans**) as the Task's
  pending scope with `ScopeSource::Planner` (the same validated `propose_repo_scope` a human or
  scout proposal uses).
  The next tick resolves it and dispatches implementation, which creates the Task's retained
  mutation worktree for the first time;
- no mutated repository: raise the existing "Which repository should this task use?" decision.
  This is now reached only *after* planning.

**Multi-repository plans (UNF-625).** An accepted plan that mutates more than one repository no
longer stops for a human (UNF-569's original stopgap). The Task proceeds with one repository
through the ordinary one-repository Coding V1 lifecycle:

- the primary repository is the one the Task was already bound to before planning (an operator's
  `POST /tasks/:id/repo-scope`, which ADR-0031 never redirects, even when the plan does not mutate
  it); otherwise the mutated repository whose earliest work unit comes first in plan-wide dependency
  order (`SimplificationReport::mutated_repos_in_dependency_order`), never an alphabetical choice;
- for every other mutated repository, Sergeant's own control-plane code (never the model) creates
  one Linear issue (`implementation_tick::followup_issues`) carrying that repository's work-unit
  objectives and a link back, marked blocked by the originating issue, and delegated to Sergeant.
  Creation is idempotent per `{task_id}:{repo_slug}` marker; a reused issue only gets the blocker
  relation or delegation an interrupted earlier attempt left missing. An unbound Task creates them
  before binding its primary repository; a pre-bound Task creates them at its first implementation
  dispatch;
- ordinary intake admits each follow-up WAITING on its blocker, and blocker reconciliation starts it
  once the originating issue resolves. There is no parent/child Task state machine, no new table,
  and no cross-Task completion coupling: the originating Task completes on its own repository's
  work alone.

A `needs_human_decision` plan is never accepted, so its `work_units` are never bound (UNF-616).
Once a human answers it, a Task with no repository bound plans again: the new Planner Run receives
the resolution and any reply that came with it, so a reply directing the work to a repository, or
the issue's own named repository, decides the binding rather than the unaccepted plan or a second
"which repository?" question. A Task already bound proceeds to implementation as before.

**The accepted plan governs implementation.** For an accepted (`proceed` or `simplify`) plan, the
implementation Run's prompt and context snapshot carry the repository choice, the assessment, the
adopted effective plan, the design decisions, and every work unit for that repository in dependency
order. Coding V1 implements all of a repository's work units in that one Run. Its capability tier
and local validation are the strongest any of those units asked for, with targeted checks combined.
(Since UNF-647, [ADR-0041](0041-reviewer-rules-on-acceptance-criteria-ci-is-the-test-gate.md), local
validation means only checks CI cannot perform: `none` or `targeted`.)

**Lifecycle of a Run with no Task repository.**

- *Finalize:* `poll_and_finalize` releases a workspace only when the Run has one, and verifies a
  Planner Run's checkouts before accepting its success.
- *Retry / fresh run:* re-enter `DispatchSimplify` through the same router, so a retried Planner
  gets a fresh scratch directory.
- *Cancel:* `orchestrator::cancel_task` already stops a Run with no workspace. The scratch
  directory is swept afterwards.
- *Restart:* a running Planner keeps its scratch directory. After restart, the same `WaitForRun`
  path polls and finalizes it from durable Run state; the binding happens on a later tick from the
  persisted plan artifact.
- *Cleanup:* the scratch directory is removed as soon as the Run is finalized, and the workspace
  maintenance loop sweeps any `planning/<run_id>` whose Run is terminal or unknown. That covers
  cancellation and crashes.

## Consequences

- A delegated issue that names no repository reaches the right implementation repository through
  exactly one Planner Run, with no "which repository?" interruption.
- Every Planner Run costs one incremental fetch and one local copy (objects and working tree) per
  enabled repository. That is acceptable at the current installation's scale; a search/classification
  layer is deliberately not built.
- The UNF-484 exact-match layer (including its WAITING auto-resume) and UNF-456's Jev
  repository selection are removed rather than kept as a second routing path. Legacy
  `exact_match`/`jev_proposal` scope sources still decode.

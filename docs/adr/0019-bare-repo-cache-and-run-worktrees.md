# ADR-0019: Bare repository cache and per-Run worktrees (UNF-241)

## Status

Accepted, with its per-Run mutation-worktree decision superseded by ADR-0031/UNF-471 for Coding
V1. Sequential mutation Runs now share one retained Task workspace. Non-mutating Runs retain this
ADR's detached, exact-candidate observation worktrees, and the persistent bare-clone boundary is
unchanged.

## Context

UNF-241 is a formal Linear blocker of UNF-197 (the autonomous Task→Run dispatch loop, open as a
PR at the time of this ticket). An architecture review of that PR found two real defects in how
it drove `workspace`/`worker`:

1. The worker created the git worktree/branch itself, inside `Worker::start`, and Sergeant only
   called `workspace::lifecycle::register_workspace` afterward (reading the path back via
   `Worker::get_result`). A crash between the two left a live process/worktree/branch with no
   durable ownership record — exactly what [ADR-0018](0018-run-context-snapshots-and-workspace-lifecycle.md)
   (UNF-217) exists to prevent.
2. Non-mutating Runs (review, test) branched off the *previous* Run's branch rather than
   observing it (implementation → review branch B from A → fix branch C from B), so which
   branch/SHA was "the candidate" to merge became ambiguous, and a reviewer/tester Run could in
   principle drift it.

Both defects share a root cause: worktree/branch creation was a worker adapter's responsibility,
decided implicitly as a side effect of `Worker::start`, rather than an explicit step Sergeant
takes and durably records before a worker ever runs.

Separately, this ticket established Sergeant's V1 repository checkout policy: a persistent bare
clone per repository (Git objects/refs only, structurally incapable of becoming a dirty worker
checkout) plus isolated worktrees with shared object storage and no reclone-per-Run cost. UNF-471
later changed mutation-worktree lifetime from per-Run to per-Task.

## Decision

### One persistent bare clone per repository; isolated worktrees from it

`workspace::repo_cache` owns the bare-clone cache (`<cache_root>/<repo_slug>.git`):
`ensure_bare_clone` clones once (concurrency-safe: it clones into a private tmp directory and only
renames it into place if no racing caller won first), `fetch_and_prune` refreshes it, `resolve_sha`
resolves a ref to an exact commit, and `prune_worktrees` is the periodic `git worktree prune`
maintenance hook. `repo_slug`/`repo_source` stay opaque, caller-supplied strings (never a
`Repository`/`ExecutionTarget` registry table), mirroring `repo_config`'s and UNF-217's own
non-relational stance.

It clones with plain `--bare`, then explicitly configures `remote.origin.fetch =
+refs/heads/*:refs/remotes/origin/*` — the same remote-tracking refspec an ordinary (non-bare)
clone gets by default, which a bare clone does not. This is deliberate, not an oversight: it keeps
upstream branches (`refs/remotes/origin/*`) in a separate namespace from the Sergeant-owned
branches `workspace::worktree::create_run_worktree` creates directly in `refs/heads/*` for a
mutation Run. The obvious alternative, `--mirror` (which configures `+refs/*:refs/*`), was
rejected specifically because it folds both into the same `refs/heads/*` namespace — the very next
`fetch --prune` would delete every Sergeant-owned branch that doesn't also exist upstream, which
is exactly the branch this cache exists to hold before it's ever pushed anywhere. `resolve_sha`
tries `refs/remotes/origin/<ref>` first (an upstream branch/tag), falling back to the literal ref
(a Sergeant-owned branch, or a raw SHA already in the object database).

`workspace::worktree` does the actual `git worktree add`/`remove` against that cache — branch-
backed (`-b <branch>`) for a mutation Run, `--detach` for a non-mutating one — superseding
`worker::local::process`'s pre-UNF-241 `create_worktree`/`remove_worktree_and_branch`/
`WorktreeCreated` (removed).

### Sergeant creates and registers the workspace; the worker only ever operates inside it

`workspace::provision::prepare_run_workspace` is the single primitive a dispatch loop calls,
replacing "the worker creates a worktree, Sergeant registers it afterward" with the correct order:
ensure the bare clone → fetch/prune → resolve the exact base SHA → create the worktree (and
branch, for a mutation Run) → `workspace::lifecycle::register_workspace` — all before a worker is
ever invoked. If registration fails (e.g. a duplicate path/run), the worktree/branch just created
are torn down best-effort, so a failed call never leaves orphaned state behind.

`worker::contract::WorkerTask` changed shape accordingly: `repo_path`/`base_ref` (an adapter's
instruction to go create its own worktree) became `workspace_path` (an already-created,
already-registered worktree), `base_ref` (now just the resolved SHA, kept for change-set/
commit-count provenance), and `branch: Option<String>`. Every adapter (`local`, `claude`) had its
own worktree/branch creation and start-failure worktree/branch cleanup deleted — they now only
`cd` into `workspace_path`.

### Non-mutating Runs observe a candidate by Run ID, never by branch name or SHA

`workspace::provision::WorkspaceRequest` is either `Mutation { base_ref }` (the retained
`sgt/<task_id>` branch, rooted at `base_ref` on first use) or `Observe { candidate_run_id }` (a
detached worktree at the exact head SHA the named Run's associated workspace currently records —
no new branch). A caller never passes an observed SHA around itself; it names the candidate Run,
and `prepare_run_workspace` resolves the branch from that Run's durable workspace association and
its exact current SHA from the bare clone. This makes
"which branch/SHA is the candidate" unambiguous by construction: it's whichever mutation Run
(implement or fix) most recently produced one on the Task branch — never a chain of mutation
worktrees branching off one another.

`run_workspaces.branch` became nullable (migration `0008_workspace_branch_nullable.sql`,
recreate-copy-rename since SQLite has no `ALTER COLUMN`) to represent this: `None` for an
observational Run's detached worktree. `workspace::safety::inspect_worktree` and
`workspace::cleanup::remove_workspace` both accept an optional branch, skipping the
remote-tracking-ref check and the `git branch -D` step, respectively, when there is none.

## Consequences

- `workspace::provision::prepare_run_workspace` is the clean primitive UNF-197's own follow-up
  dispatch rework calls instead of relying on `Worker::start` to create a workspace as a side
  effect — this ticket does not rewrite `dispatch.rs` itself (it doesn't exist on `main`; it lives
  in UNF-197's still-open PR).
- No `Worker` adapter creates, removes, or otherwise owns a git worktree/branch any more; a future
  Codex (or other provider) adapter never needs to reimplement that plumbing either.
- The bare-clone cache never becomes a worker's mutable checkout (no working tree exists there at
  all), and it is reused across every Run against a repository rather than recloned — the V1
  invariant this ticket's Linear brief specifies.
- Cleanup/reconciliation retain UNF-217's idle-then-safe removal and restart-recovery policy.
  UNF-471 changes the owning Run claim between sequential mutations without weakening either rule.
- Explicitly not built here (per this ticket's own non-goals): a `REPO_READ/EXECUTE/WRITE` mode
  hierarchy, a generalized multi-repo mutation workspace, or any new relational repository
  registry table. ADR-0031 later narrowed Coding V1 further: work needing changes in two
  repositories is represented by two explicitly-dependent coding Tasks, not two repository
  mutations within one Task and not a multi-repo workspace.

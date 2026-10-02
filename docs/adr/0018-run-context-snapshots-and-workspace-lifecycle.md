# ADR-0018: Immutable Run context snapshots and workspace lifecycle (UNF-213/UNF-217)

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: the `context_snapshots` table is gone -- a snapshot body is a promoted `context_snapshot` artifact and the Run keeps a write-once pointer in `runs.context_snapshot_json` (`version` and the staleness baseline were dropped); `run_workspace_uses` is replaced by `runs.workspace_id`; `run_workspaces` is renamed `workspaces`. The immutability and workspace-safety decisions below still stand.

Accepted. ADR-0031/UNF-471 supersedes only the one-workspace-per-Run decision below for Coding V1
mutation Runs: one Task now retains and sequentially reclaims one authoritative mutation
workspace. Detached observation Run worktrees and the safety/recovery policy remain in force.

## Context

The design handoff dispatched UNF-213 and UNF-217 together as the direct prerequisite for
UNF-197 (the first autonomous Task→Run dispatch loop): before Sergeant can dispatch a real Run,
it needs (a) a durable record of exactly what context that Run was given, so it can reproduce
what a worker was told without depending on Linear/the repo/a design doc staying reachable after
dispatch, and (b) a durable, restart-recoverable record of the local git worktree that Run
mutates, so parallel work stays isolated and the host doesn't accumulate unsafe or stale state.

Both tickets share a "no new relational registry table" non-goal already established by
[ADR-0014](0014-repo-owned-topology-config.md) (UNF-233): neither may reintroduce
`Repository`/`Application`/`Environment`/`ExecutionTarget` tables as a way to constrain what a
Run may touch.

## Decision

### UNF-213: `context_snapshot`

- `context_snapshot::store::create_snapshot` persists one immutable, versioned, content-hashed
  snapshot per creation call, linked to the Run it was dispatched for
  (`runs.context_snapshot_id`). A Task whose authoritative inputs change gets a **new** snapshot
  (the next `version`), never a mutated one — `context_snapshots` has no `UPDATE` path anywhere
  in this crate touching its body/hash/provenance.
- The snapshot body (`context_snapshot::ContextSnapshotBody`) names specific kinds of context
  (Task intent/acceptance criteria, repo instructions, architecture references, configuration,
  resolved Linear decisions, intentionally supplied source context, and repo/application/
  environment context) rather than being a generic document bag — per this ticket's own "no
  generic RAG platform" non-goal.
- Large bodies are offloaded to the existing `storage::ObjectStore` (UNF-202,
  [ADR-0010](0010-object-storage.md)) above `context_snapshot::store::INLINE_BODY_THRESHOLD_BYTES`;
  smaller ones stay inline in SQLite. Reuses the object store rather than building a second
  mechanism, and reconstructs the object key from `(task_id, run_id, id)` rather than parsing a
  stored key string back apart, mirroring `domain::artifacts::artifact_key`.
- Repo/application/environment context is carried as an opaque `serde_json::Value` field
  (`ContextSnapshotBody::repo_context`), typically `repo_config::ResolvedContext::to_json`
  re-parsed — generalizing that narrower UNF-233 snapshot exactly as ADR-0014 anticipated,
  without replacing `domain::runs::Run::resolved_context` itself (existing callers/tests of that
  column are untouched).
- Active-run staleness (`context_snapshot::staleness`) reuses `preflight`'s own comparison
  primitives (`PreflightInputs`/`ChangedInput`/`diff_inputs`) rather than inventing a parallel
  diff shape, per the handoff's explicit direction. It differs from `preflight` in *when* it runs
  (after dispatch, not before) and in what it does with a detected change: it only records the
  delta (`active_run_staleness_checks`, append-only) and leaves the response — irrelevant, a
  steering update, or superseding the Run — to a future caller. It never mutates the Run's
  snapshot, and it never enacts a response itself.

### UNF-217: `workspace`

- Filesystem/worktree isolation is treated as the real execution boundary — not a relational
  `repository_id`/`ExecutionTarget`. `workspace::types::Workspace::repo_source` is an opaque,
  caller-supplied descriptor, mirroring `repo_config`'s own non-relational stance.
- As originally accepted, `run_workspaces` was one row per Run. UNF-471 later makes it an index of
  physical worktrees: one retained mutation row per Coding V1 Task plus detached per-Run
  observation rows. `run_workspace_uses` preserves all Run associations, while
  `active_run_id` makes the current sequential mutation claim explicit.
- Restart recovery (`workspace::reconcile::reconcile_workspace_ownership_on_startup`) reads
  `run_workspaces` state=`active` rows and cross-checks each owning Run's own status
  (`domain::runs`, the same durable source ADR-0006 already established), demoting a workspace to
  `idle` only when its Run turned out to be terminal or stale by
  `domain::runs::list_stale_running_runs`'s own definition — never by scanning the filesystem or
  a worker adapter's private on-disk run records. (UNF-643, [ADR-0040](0040-worker-runs-survive-daemon-restart.md):
  the stale-by-age demotion is gone — worker Runs now survive a restart, so a long `running` Run is
  normally still using its workspace; only a terminal or missing owning Run is demoted.)
- Cleanup never deletes on the strength of "the Run is no longer active" alone:
  `workspace::safety::inspect_worktree` checks for uncommitted changes and for commits that exist
  nowhere but the local worktree (conservatively: any commit beyond `base_ref` with no matching
  `refs/remotes/origin/<branch>`) before `workspace::cleanup::remove_workspace` will touch disk;
  an unsafe workspace transitions to `cleanup_blocked` instead of being removed or silently
  retried forever.
- Deliberately separate from tmux/process supervision: this module never touches tmux and does
  not duplicate or bypass UNF-228's `WorktreeCreated` proof-token pattern
  (`worker::local::process`) — it is a distinct, SQLite-only ownership/lifecycle ledger a caller
  populates around that existing worktree-creation mechanism, not a replacement for it.

### Shared: nothing wires either into `sergeant-daemon` yet

Both modules land the same way `preflight`/`retrospective`/`linear` did before their own
wiring: complete, tested library modules with no daemon call site, since worker dispatch
(UNF-197) doesn't exist yet either. Each module's `mod.rs` documents the exact intended
integration point for UNF-197's dispatch loop.

## Consequences

- `runs.context_snapshot_id` and `run_workspaces` are new, independently useful pieces of
  schema/state that UNF-197 can build directly on without inventing either mechanism itself.
- `domain::runs::Run::resolved_context` (UNF-233) is untouched; UNF-213 generalizes the *concept*
  (repo/application/environment context inside a broader snapshot) without migrating or removing
  the narrower column, so no existing test or call site needed to change.
- A future maintenance tick is responsible for periodically re-gathering
  `preflight::PreflightInputs` to call `context_snapshot::staleness::check_active_run_staleness`
  against an active Run — still not built. The other half, actually calling
  `workspace::cleanup::list_cleanup_candidates`/`remove_workspace` on a schedule, was wired in by
  UNF-244 (`sergeant-daemon::loops::run_workspace_maintenance_loop`) — see
  `docs/adr/0019-bare-repo-cache-and-run-worktrees.md`'s own consequences for the rest of that
  ticket's scope.

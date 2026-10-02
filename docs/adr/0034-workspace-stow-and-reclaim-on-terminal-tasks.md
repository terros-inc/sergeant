# ADR-0034: Stow-then-reclaim workspace cleanup for terminal Tasks

## Status

Superseded in part by UNF-567 ([`docs/data-model.md`](../data-model.md)) at the table level only: `run_workspaces` is now `workspaces`, and its separate recovery columns are one `workspaces.recovery_json` object (`{branch, sha, pull_request_url, recorded_at}`, NULL when nothing is preserved). The stow-then-reclaim policy below is unchanged.

Accepted (UNF-494). Refines ADR-0031's "Workspace retention" section: that section's own
"terminal workspaces may be removed after the configured grace period" and "still applies the
existing dirty/unpushed safety checks" both remain true, but the meaning of a workspace that fails
that safety check changes -- it is no longer a permanent, human-attention-only hold.

## Context

Sergeant stage reached severe disk pressure even with a low-frequency `workspace_maintenance_tick`
already running (UNF-244/ADR-0018). The original, conservative policy had three real gaps:

- A terminal Task's dirty/unpushed workspace transitioned to `cleanup_blocked` and was never
  reconsidered by any later pass -- a correct one-time safety decision that then became a
  permanent disk-usage sink, indistinguishable from an intentionally-preserved row.
- A pre-UNF-394 (`docs/adr/0028-managed-repository-enrollment.md`) `run_workspaces` row with no
  `repo_slug` errored out of cleanup entirely (`remove_workspace` cannot address a bare-clone
  cache it cannot identify) and could remain indefinitely with no path back to a clean state.
- The default one-hour idle grace period, combined with `cleanup_blocked` never being retried,
  meant a terminal Task's `target/`-sized build artifacts routinely outlived the Task itself by
  a wide margin under any real disk pressure.

None of this is a case where Sergeant should choose between "delete real work" and "leave disk
usage unbounded forever." The captain's stated preference is explicit: preserve useful work
remotely, then reclaim local disk aggressively once that preservation is confirmed.

## Decision

### Preserve before deleting, automatically

`workspace::stow::preserve_workspace` is the new primitive: given a workspace `safety::inspect_worktree`
already found unsafe to remove outright, it commits any uncommitted content under a fixed
Sergeant identity (never the host's ambient git config, which a deployment has no reason to have
set), then pushes. It prefers the Task's own retained branch when that push succeeds outright (the
natural home -- an existing PR, if any, already targets it); a detached observation workspace (no
branch at all) or a push the remote rejects (the branch diverged from what's already there) falls
back to a dedicated, deterministic `sgt/recover/<task_id>` branch instead, freshly branched off the
worktree's current `HEAD` so it always pushes cleanly without ever force-pushing over anyone.

`workspace::cleanup::dispose_workspace` is the new orchestrator every maintenance pass actually
calls, superseding "just call `remove_workspace`":

1. If `repo_slug` is missing (a legacy row), `workspace::legacy::ensure_repo_slug` tries to
   recover it deterministically from durable provenance (the Task's established single-repository
   Run history, then this specific Run's own recorded scope, then "there is only one enrolled
   managed repository at all" -- true by construction for every row old enough to predate
   multi-repository support). Failing that, this opens a `TaskFault` and stops, rather than
   guessing.
2. `remove_workspace` is attempted normally, unchanged. Clean and safe removes immediately.
3. If unsafe and GitHub is configured, `stow::preserve_workspace` runs once. Success records where
   (`recovery_branch`/`recovery_sha`/`recovery_pull_request_url` on the workspace row) and removes
   the worktree directly -- deliberately not by re-running the safety check, which would
   misreport the just-pushed branch as still unpushed (a plain `git push` to a raw URL never
   updates the local `refs/remotes/origin/*` tracking ref that check reads).
4. If preservation fails (or GitHub isn't configured at all), a `domain::task_faults::TaskFault`
   opens/refreshes and the workspace stays `cleanup_blocked` -- visible and retryable, not silently
   discarded and not silently stuck.

### `cleanup_blocked` is a retry state, not a terminal one

`workspace::list_cleanup_retry_candidates` feeds every currently `cleanup_blocked` workspace
belonging to a terminal Task back through `dispose_workspace` on every maintenance pass, with no
age cutoff -- the failure mode this state now represents ("preservation hasn't succeeded yet") is
retried until it does, not left for a human to notice. A successful retry clears the fault
automatically; the workspace is reclaimed in the very same pass that finally succeeds.

### Legacy attribution has an explicit human escape hatch

A `run_workspaces` row `ensure_repo_slug` cannot attribute (no single-repository signal at all --
rare, but possible for a row old enough) surfaces as a `TaskFaultKind::UnattributedWorkspace`
fault rather than looping forever. `sergeant admin-workspace attribute <workspace-id> <owner/repo>`
lets an operator supply the answer directly (from a backup, a Linear reference, or direct
inspection); `sergeant admin-workspace reclaim <workspace-id> [--force]` is the one-time bypass for
a row that truly cannot be attributed, deleting the worktree directory straight from disk (there is
no bare clone to address a `git worktree remove` against) rather than through the ordinary
git-mediated path -- refusing unless the content is already safe or an operator explicitly passes
`--force` to acknowledge the risk.

### Cancellation releases the workspace claim it stops

`orchestrator::cancel_task` already stopped an active Run and transitioned the Task to `CANCELED`
(UNF-373) but never touched the workspace claim. Without also releasing it (`Active` -> `Idle`),
a canceled Task's workspace could never become a cleanup candidate at all -- `remove_workspace`
refuses outright to touch an `Active` workspace, and a canceled Task is no longer `ACTIVE` so
`orchestrator::finalize::poll_and_finalize` (the loop that ordinarily performs this release) never
polls it again. `cancel_task` now releases the claim itself once the Run is confirmed stopped, when
one exists -- pure durable bookkeeping, no git/filesystem access, so this does not weaken the
existing "cancellation never touches workspace *content*" boundary. Preservation and physical
removal both remain the maintenance pass's job, reached promptly through the same
`dispose_workspace` path every other terminal workspace goes through.

### Promptness comes from cadence, not a special disk-pressure path

`SERGEANT_WORKSPACE_IDLE_AFTER_SECONDS`'s default dropped from one hour to five minutes -- once
dirty content is safely preserved before removal, the grace period's only remaining purpose is
avoiding a race with a still-finalizing process, not giving a human time to intervene before
deletion. Combined with the existing 15-minute maintenance interval and `cleanup_blocked`'s own
automatic retry, a terminal Task's workspace (and its `target/`-sized build artifacts) is reclaimed
within roughly 20 minutes under normal operation, not indefinitely. This is deliberately not a new
disk-pressure-detection subsystem (ADR-0031's "disk pressure ... never broadens cleanup to
unfinished work" stays true) -- it is the existing conservative cadence made prompt now that
preservation removes the reason to wait.

## Consequences

- `run_workspaces` gains `recovery_branch`/`recovery_sha`/`recovery_pull_request_url`/
  `recovery_recorded_at` (migration 0036) -- durable provenance for where preserved content landed.
- `github::completion::GitHubCompletion` gains `push_branch`/`find_pull_request_for_branch`,
  narrower than `publish`'s own create/update-PR side effect -- `stow::preserve_workspace` only
  needs a push and an existence check, never PR creation.
- `domain::task_faults::TaskFaultKind` gains `WorkspacePreservationFailed`/`UnattributedWorkspace`,
  reusing UNF-486's existing fault/comment machinery rather than inventing a second escalation
  path.
- The default end state of a terminal Task is no retained mutable workspace on local disk once its
  content is confirmed safe -- either because it was already clean, or because it was pushed
  somewhere durable first.
- Non-goals unchanged from the ticket that motivated this: no generalized artifact-archival system
  (a build's `target/` directory is discarded, never preserved -- only source/work-product changes
  that need recovery are); ACTIVE/WAITING Task workspaces remain untouchable regardless of disk
  pressure.

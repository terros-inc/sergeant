# ADR-0006: Workers are disposable; work state is durable

## Status

Accepted; terminology and mechanism narrowed by
[ADR-0013](0013-task-run-simplification.md) (UNF-226). The core principle — a `Run` never holds
the durable workflow state, so deleting every `Run` row still leaves the parent's state and
history meaningful — still holds. `WorkItem` was renamed to `Task`,
`work_item_state_transitions` to `task_state_transitions`, and `previous_state` was dropped
entirely (`WAITING` is now generic and always resumes to `ACTIVE`, never to a remembered
sub-stage). The context and decision below are kept for history, not as the current design.

## Context

The design doc's core architectural boundary is "build our own control
plane, not our own coding runtime." Individual worker runs — a Claude
session, a Codex run, a tmux pane — are inherently ephemeral and
provider-specific. If Sergeant's workflow state lived in any of those (model
memory, tmux state, Linear comments), a crashed or restarted worker, or a
restarted Sergeant process, would lose track of what was happening.

## Decision

`sergeant-core`'s `WorkItem`, its `current_state`/`previous_state`, and its
full `work_item_state_transitions` history are the only source of truth for
where a piece of work stands. A `Run` (`crates/sergeant-core/src/domain/runs.rs`)
records that a worker executed, and can be cited as the `actor_run_id` on a
transition it caused, but the workflow state itself never lives on the Run
or on any provider-side session — deleting every Run row still leaves the
WorkItem's state and history fully meaningful. This is exactly what
`crates/sergeant-core/tests/restart_survival.rs` verifies: closing and
reopening the database (standing in for a Sergeant process restart) loses
nothing.

## Consequences

- A worker process crashing mid-run is a `Run` ending up `failed` or stuck
  `running` — never a WorkItem whose state can't be determined.
- Recovery logic (a future ticket) only ever needs to read `work_items` and
  `work_item_state_transitions` to know what to do next; it never needs to
  reach into a provider's session state.
- Multiple runs (implement → review → fix → review again) against one
  WorkItem are representable via `parent_run_id`, without the WorkItem
  itself needing to track "which cycle am I on."

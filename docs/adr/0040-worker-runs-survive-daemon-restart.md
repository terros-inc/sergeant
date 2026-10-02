# ADR-0040: Worker Runs survive a Sergeant restart; drain is a quiesce

## Status

Accepted (UNF-643). Reshapes the drain contract from UNF-374 and the startup workspace recovery from
UNF-244 ([ADR-0018](0018-run-context-snapshots-and-workspace-lifecycle.md)). Builds on
[ADR-0006](0006-workers-disposable-work-state-durable.md): work state stays in the durable store, and
now so does everything needed to re-adopt a Run the previous process launched. The worker check-in /
lease protocol for remote workers and redundancy (UNF-644) is a separate, later decision that builds
on this one.

## Context

A deploy drained Sergeant by refusing new Tasks and waiting (`deploy.sh --drain-timeout-secs`, 300s)
for every active Run to finish. Tasks run for hours, so any deploy while Sergeant was busy timed
out and aborted; as load grew, deploys effectively never landed. The drain existed because a
restart was destructive: `sergeant.service` used systemd's default `KillMode=control-group`, so
stopping the daemon killed every worker process tree, and the Claude adapter then reported the Run
`Failed` ("claude process ended without recording an exit code").

The adapters already track a Run through on-disk records (pid, process group, output log,
`exit_code` file), and since UNF-570 every turn leads its own process group. Nothing about a running
worker needed the daemon to stay alive -- only the unit's kill scope did.

## Decision

Restart fast; in-flight worker Runs outlive the daemon and are re-adopted. Scope: this covers the
process-backed providers (Claude, Codex), whose turns are their own process trees. An OpenAI Run
executes on a thread inside the daemon and does not survive a restart; drain holds a restart until
none is in flight (item 4).

1. **Workers outlive the daemon.** `deploy/host/sergeant.service` sets `KillMode=process`: stopping
   the unit signals only `sergeant serve`. `PrivateTmp` is dropped (systemd deletes a unit's private
   `/tmp` on every stop, under the surviving workers) in favour of `ReadWritePaths` for `/tmp` and
   `/var/tmp`. Cancelling a Task still terminates the whole tree (UNF-570's `process_tree`), from
   whichever process does the cancelling.
2. **Re-adopt on startup.** Nothing new is needed for a live or finished worker: the implementation
   loop's first poll reads the Run through `Worker::status`, which derives state from the on-disk
   record plus liveness of the recorded pid, so a still-running turn is monitored again and a turn
   that finished while the daemon was down is collected normally. Liveness is identity-checked
   (`process_tree::turn_is_alive`): a recorded pid now alive as an unrelated process (reused after a
   host reboot) reads as gone.

   **Launch is crash-consistent.** An adapter writes a turn's record -- atomically, temp file +
   fsync + rename (`worker::run_dir::write_record_atomic`) -- *before* spawning its process, then
   records the pid. A daemon that stops between the two leaves a record naming the turn with no pid;
   the next daemon's `Worker::status` finds the turn's live leader process by its script
   (`process_tree::find_turn_leader`) and adopts it instead of reporting it interrupted and launching
   it again. So a startup that finds no record at all knows no worker was ever spawned, and a first
   turn recorded but never spawned (no conversation to resume) fails for a fresh retry. This is the
   whole mechanism -- no separate launch-intent state -- because record-first plus adoption closes
   both windows: the initial start and the interrupted-turn resume.
3. **Interrupted, not failed.** A turn whose process vanished without an exit code (host reboot,
   crash, OOM kill of the whole turn) is `WorkerState::Interrupted`, not `Failed`. `poll_and_finalize`
   resumes it in its own conversation via `Worker::send` (Claude `--resume <session>`; Codex resumes
   its thread once codex has reported one), losing at most the in-progress turn. Resumes are bounded
   (`MAX_INTERRUPTED_RESUMES`, 2) and each is a `run.interrupted` event written before the resumed turn
   launches, so the bound survives the restarts that cause interruptions. Past the bound, or when the
   worker cannot resume, the Run fails `Transient` with a reason naming the interruption, and the
   ordinary retry policy takes over. A genuine non-zero exit stays a failure. A resume is a worker
   launch, so it goes through the drain counter like a dispatch (below): while draining it waits for
   the restart instead of starting a process the restart could catch mid-launch.
4. **Drain shrinks to a quiesce.** Draining refuses every new Run dispatch (not only a new Task's
   first Run) and counts dispatches already under way (`DrainGate::admit_dispatch`);
   `ready_for_restart` is true once draining with no dispatch or resume launch in flight and no
   in-process (OpenAI, `worker::IN_PROCESS_PROVIDERS`) Run in flight -- seconds, not Task lifetimes,
   for process-backed work. `deploy.sh`'s default drain timeout drops to 60s. `--bypass-drain` keeps
   its meaning; the worst it can now cut off is one dispatch step, or an in-process Run.

   **Owned drains.** Each drain `POST /drain` starts gets an opaque token returned only to that
   request; `POST /drain/cancel` with a token ends only that drain, and without one (an operator)
   ends whatever drain is in place. An aborting deploy or `sgt admin restart` cancels only with its
   own token, so an operator's drain survives whether it was in place first or started after the
   operator cancelled the deploy's (observed live: a deploy timing out on an active Task cancelled
   the operator's `sgt admin drain` on its way out). Against a sergeant too old to report ownership
   nothing is cancelled automatically; the abort path prints the undrain command instead.
5. **Startup settles half-done work.** `startup::recover` runs before any loop: a Run left `pending`
   by a dispatch the previous process never finished is adopted if its worker had started, else failed
   like any failed dispatch (`orchestrator::recover_interrupted_dispatches`). The workspace reconcile
   no longer demotes a `running` Run's workspace by age -- that Run is normally still working in it.
6. **Nothing missed while down.** Linear events sent during the restart window are not replayed; the
   intake loop's immediate first tick reconciles every tracked Task, ingests comments, and discovers
   new delegations from Linear's current state (`restart_window_linear.rs`).
7. **Cross-version.** A Run launched by the previous binary finishes under the new one, so the
   adapter's `run.json` stays tolerant: new fields are `#[serde(default)]`, unknown fields are
   ignored, and a pinned fixture of the previous release's record is exercised
   (`worker_restart_survival.rs`).

## Consequences

- A deploy no longer fails because Tasks are active, and no longer destroys in-flight work.
- Run state and worker liveness stay in the durable store (the `runs` row, `last_polled_active_at`,
  `run.interrupted` events, the adapter's on-disk record) -- never only in daemon memory -- which is
  what UNF-644's phone-in / lease protocol will build on.
- `systemctl stop sergeant` no longer stops workers either. Stopping all work is a Task cancel (or,
  deliberately, `systemctl kill --kill-who=all sergeant`).
- **Known limitation:** an OpenAI Run does not survive a restart (its driving thread dies with the
  daemon). Drain therefore waits for in-flight OpenAI Runs, and a deploy while one is long-running
  can time out as before; a Run cut off anyway (`--bypass-drain`, a crash) is recovered by the
  existing idle-timeout path. Making it restart-durable means hosting its loop out of process with
  the same record/adoption protocol -- deliberately left for a follow-up.
- The first deploy of this change runs against a daemon whose drain still waits for every active
  Run and whose unit still has `PrivateTmp`. `deploy.sh` enforces a quiescent transition: against
  that daemon it refuses while any Run is active (unless `--bypass-drain`); see the EC2 runbook.

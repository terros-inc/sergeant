import { join } from "node:path";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { apiHandler } from "./api.ts";
import { isLoopbackHost } from "./auth.ts";
import { driveCancel, pendingCancels, recordCancel, taskDir } from "./cancel.ts";
import { runLoop, type LoopResult } from "./loop.ts";
import { admissionOrder, Slot } from "./slots.ts";
import { retroEvery } from "./retro.ts";
import { startFeedbackLoop } from "./service-feedback.ts";
import { newWork, resumableTasks } from "./service-intake.ts";
import { lockStateDir } from "./service-lock.ts";
import { createServiceServer } from "./service-http.ts";
import type { Service, ServiceDeps, ServiceOptions } from "./service-options.ts";
import { serviceWebhooks } from "./service-webhooks.ts";
import { Wake } from "./wake.ts";

// The long-running Sergeant 2 process (UNF-719): a thin shell over the per-task loop, not a workflow
// engine. Intake polls Linear for open issues delegated to the V2 agent (UNF-724) and runs each one's
// existing loop (loop.ts), at most `maxTasks` holding a slot at a time (slots.ts). Linear's list only
// discovers new work, and a task starts only from Todo (TECH-4989): an issue in Triage or Backlog waits
// until a human moves it there. Every task already under way locally (its `state.json`) with no loop
// resumes at every intake, listed or not, holding no slot until it has work to do: its loop's own live
// checks continue it, stop it (cancel.ts), or see it through after its merge. Each task loop already re-reads its runs,
// its PRs and their checks, and the Linear conversation every poll, and takes a reasoning turn only
// when those changed, so no webhook is needed: one (webhooks.ts, TECH-4937) only ends a loop's wait
// or runs an intake sooner. Nothing is kept but each task's own `state.json` and a
// recorded stop not yet done (`cancel.json`, cancel.ts): a loop that ends (idle, failed) resumes on a
// later intake, and a restarted process rereads everything and continues, repeating some work. One
// process per state directory, held by an OS file lock, so the task limit and one turn per task hold.
// The same server answers the client API (api.ts) that the `sgt` CLI uses. Feedback that arrives
// after a task's work landed is swept separately (feedback.ts) and may file an ordinary Backlog
// follow-up, which nothing here starts: a human moves it to Todo and delegates it, like any issue.

export type { Service, ServiceDeps, ServiceOptions } from "./service-options.ts";

export async function startService(opts: ServiceOptions, deps: ServiceDeps): Promise<Service> {
  if (opts.trustLoopback && !isLoopbackHost(opts.host ?? "127.0.0.1")) throw new Error(`--trust-loopback is refused on a non-loopback --host (${opts.host})`);
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const release = await lockStateDir(opts.stateDir);
  const maxTasks = opts.maxTasks ?? 2;
  const graceMs = (opts.waitingGraceMinutes ?? 15) * 60_000;
  const abort = new AbortController();
  const active = new Map<string, Promise<void>>();
  // Each running loop's slot: released while it waits past the grace (slots.ts).
  const slots = new Map<string, Slot>();
  // When and how each task loop last ended: an unchanged ending (an idle task readmitted every intake,
  // say) is not logged again, and a loop that ended since the latest intake waits for the next.
  const ended = new Map<string, { at: number; outcome: LoopResult["outcome"] | "failed"; detail: string }>();
  let lastIntake: { at: string; error?: string } | undefined;
  let intakeStartedAt = 0;
  // The delegated issues intake would run at the last intake, in admission order, and each task's wake (API).
  let ordered: DelegatedIssue[] = [];
  let delegated: string[] = [];
  // Each open delegated issue's place in admission order; a task Linear no longer lists goes last.
  let rank = new Map<string, number>();
  // Each Todo issue a blocker held up at the last intake, and the line logged for it: logged again only when it changes.
  const blocked = new Map<string, string>();
  const byRank = (a: string, b: string) => (rank.get(a) ?? rank.size) - (rank.get(b) ?? rank.size);
  const wakes = new Map<string, Wake>();
  const wakeOf = (issueId: string) => {
    const wake = wakes.get(issueId) ?? new Wake();
    wakes.set(issueId, wake);
    return wake;
  };
  // Ends the intake loop's wait: a webhook naming a delegated issue with no loop, or a delegation change.
  const intakeWake = new Wake();

  /** Runs the task's loop; `released`, it holds no slot until it has work to do (`Slot.work`). */
  const admit = (issueId: string, released = false) => {
    if (active.has(issueId)) return;
    const slot = new Slot(() => schedule());
    slot.released = released;
    let outcome: LoopResult["outcome"] | "failed" = "failed";
    let detail = "";
    const loop = runLoop(
      {
        issueId,
        enrolledRepositories: opts.enrolledRepositories,
        dir: join(opts.stateDir, "tasks", issueId),
        ...(opts.pollSeconds !== undefined && { pollSeconds: opts.pollSeconds }),
        ...(opts.waitingGraceMinutes !== undefined && { waitingGraceMinutes: opts.waitingGraceMinutes }),
        ...(opts.idleMinutes !== undefined && { idleMinutes: opts.idleMinutes }),
        ...(opts.budget && { budget: opts.budget }),
        ...(opts.repositoryBudget && { repositoryBudget: opts.repositoryBudget }),
        ...(opts.auditSampleRate !== undefined && { auditSampleRate: opts.auditSampleRate }),
        ...(opts.progressComments !== undefined && { progressComments: opts.progressComments }),
        log: (line) => log(`${issueId}: ${line}`),
        signal: abort.signal,
        wake: wakeOf(issueId),
        slot,
      },
      { ...deps, exclusive: (step) => locked(issueId, step) },
    )
      .then(
        (result) => {
          ({ outcome, detail } = result);
          if (ended.get(issueId)?.outcome !== outcome) log(`${issueId}: loop ended ${outcome}: ${result.detail}`);
        },
        // A failed iteration ends the loop; the next intake admits it again.
        (e: Error) => log(`${issueId}: loop failed, retrying on a later intake: ${(detail = e.message)}`),
      )
      .finally(() => {
        if (active.get(issueId) === loop) active.delete(issueId);
        if (slots.get(issueId) === slot) slots.delete(issueId);
        ended.set(issueId, { at: Date.now(), outcome, detail });
        schedule();
      });
    active.set(issueId, loop);
    slots.set(issueId, slot);
  };

  // TECH-5008: releases each slot held past the grace by a waiting task, then gives every free slot
  // to the task that wants one: first a released task with work again (its human answered or its CI
  // finished, say), then a new Todo issue in admission order. A woken task (`sgt task wake`) goes first. A loop that ended since
  // the latest intake waits for the next one, so an idle task is not readmitted at once, over and over.
  const freeSlots = () => maxTasks - [...slots.values()].filter((s) => !s.released).length;
  const schedule = (freshIssues: DelegatedIssue[] = []) => {
    if (abort.signal.aborted) return;
    for (const [issueId, slot] of slots) {
      if (slot.released || slot.waitingSince === undefined || Date.now() - slot.waitingSince < graceMs) continue;
      slot.released = true;
      slot.waitingSince = undefined;
      log(`${issueId}: waiting past the grace; its task slot is free until it has work again`);
    }
    let free = freeSlots();
    if (free <= 0) return;
    const woken = (id: string) => (wakes.get(id)?.pending ? 0 : 1);
    const queued = [
      ...[...slots].filter(([, s]) => s.wanted).map(([id]) => id).sort(byRank),
      ...freshIssues.map((issue) => issue.identifier).filter((id) => !active.has(id) && (ended.get(id)?.at ?? 0) < intakeStartedAt),
    ].sort((a, b) => woken(a) - woken(b));
    for (const issueId of queued) {
      if (free-- <= 0) break;
      const slot = slots.get(issueId);
      if (!slot) {
        admit(issueId);
        continue;
      }
      slot.released = false;
      slot.wanted = false;
      log(`${issueId}: has work again; admitted to a task slot`);
      wakeOf(issueId).interrupt();
    }
  };

  // A task stop recorded and not yet done (cancel.ts): driven at once, again at every intake until the
  // runner confirms its runs stopped, and so after a restart too, whatever the issue's delegation or
  // state is by then. One step per task at a time, so a request's own drive is the one
  // that answers it; it is not held to the task limit. The same per-task lock holds a run's start from
  // its delegation check to the runner (execute.ts), so a cancel lists every run that got past it.
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(ref: string, step: () => Promise<T>): Promise<T> => {
    const next = (locks.get(ref) ?? Promise.resolve()).catch(() => {}).then(step);
    locks.set(ref, next);
    void next
      .finally(() => {
        if (locks.get(ref) === next) locks.delete(ref);
      })
      .catch(() => {});
    return next;
  };
  const serialized = <T>(ref: string, step: () => Promise<T>): Promise<T> => {
    const next = locked(ref, step);
    // The task's loop, polled now, finds its delegation gone and ends.
    void next.finally(() => active.has(ref) && wakeOf(ref).interrupt()).catch(() => {});
    return next;
  };
  const drive = (ref: string) => driveCancel(taskDir(opts.stateDir, ref), ref, deps, opts.enrolledRepositories, log);

  const intake = async () => {
    for (const ref of await pendingCancels(opts.stateDir)) {
      await serialized(ref, () => drive(ref)).catch((e: Error) => log(`${ref}: cancel not yet done, retrying next intake: ${e.message}`));
    }
    const startedAt = Date.now();
    let listed: DelegatedIssue[] | undefined;
    let failed: Error | undefined;
    try {
      listed = (await deps.delegatedIssues()).sort(admissionOrder);
      rank = new Map(listed.map((issue, n) => [issue.identifier, n]));
    } catch (e) {
      failed = e as Error;
    }
    // Every task under way locally resumes, whether or not Linear lists it, taking free slots in
    // admission order; one past them runs its live checks with no slot. One seen through after its
    // merge does not resume. An unreadable `state.json` holds up no other task, nor discovery.
    const resumable = await resumableTasks(opts.stateDir, active, log);
    // A loop that already ended resumes cheaply and asks for a slot only if its live checks find work.
    // This leaves the same intake free to admit newly listed Todo work instead of letting unchanged
    // local tasks reclaim every slot on each periodic intake.
    for (const ref of resumable.sort(byRank)) admit(ref, ended.has(ref) || freeSlots() <= 0);
    if (failed) throw failed;
    ordered = await newWork(opts.stateDir, listed, { blocked, active, woken: (ref) => wakes.get(ref)?.pending === true }, log);
    delegated = ordered.map((issue) => issue.identifier);
    intakeStartedAt = startedAt;
    schedule(ordered);
  };

  const intakeLoop = (async () => {
    while (!abort.signal.aborted) {
      const at = new Date().toISOString();
      try {
        await intake();
        lastIntake = { at };
      } catch (e) {
        lastIntake = { at, error: (e as Error).message };
        log(`intake failed, retrying next interval: ${lastIntake.error}`);
      }
      await intakeWake.sleep((opts.intakeSeconds ?? 120) * 1000, abort.signal);
    }
  })();

  const feedbackLoop = startFeedbackLoop(opts, deps, log, abort.signal);
  // The retro checks hourly whether one is due, and at once when a human asks (`sgt retro`).
  const retroWake = new Wake();
  const retroLoop = deps.retro ? retroEvery(60 * 60_000, retroWake, { stateDir: opts.stateDir, log, signal: abort.signal }, deps.retro) : Promise.resolve();

  const api = apiHandler({
    stateDir: opts.stateDir,
    enrolledRepositories: opts.enrolledRepositories,
    deps,
    ...(opts.repositoryBudget && { repositoryBudget: opts.repositoryBudget }),
    log,
    loop: (ref) => {
      if (active.has(ref)) return { status: "active" };
      const end = ended.get(ref);
      if (end) return { status: end.outcome, detail: end.detail };
      return delegated.includes(ref) ? { status: "queued" } : undefined;
    },
    // A task stopped in this process stays known, so its stop shows.
    known: () => [...new Set([...active.keys(), ...delegated, ...ended.keys()])],
    async wake(ref) {
      wakeOf(ref).request();
      if (active.has(ref)) return "active";
      await intake();
      if (active.has(ref)) return "admitted";
      if (delegated.includes(ref)) return "queued";
      wakes.delete(ref);
      return "not_delegated";
    },
    cancelTask: (ref, req, by) =>
      serialized(ref, async () => {
        const undelegated = await recordCancel(opts.stateDir, ref, { ...req, by }, deps);
        return { undelegated, ...(await drive(ref)) };
      }),
    ...(opts.humans && { callerOf: opts.humans.callerOf, linearClientId: opts.humans.linearClientId }),
    ...(opts.humans?.approverNames && { approverNames: opts.humans.approverNames }),
    trustLoopback: opts.trustLoopback ?? false,
    ...(opts.accounts && { accounts: opts.accounts }),
    ...(opts.admin && { admin: opts.admin }),
    ...(opts.enrollment && { enrollment: opts.enrollment }),
    ...(deps.retro && { requestRetro: () => retroWake.request() }),
  });
  const webhooks = serviceWebhooks(opts, deps, log, { wakes, active, delegated: () => delegated, intakeWake });
  const server =
    opts.port === undefined
      ? undefined
      : createServiceServer({ abort, lastIntake: () => lastIntake, slots, active, webhooks, api });
  if (server) await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
  const address = server?.address();

  return {
    port: typeof address === "object" && address ? address.port : undefined,
    async stop() {
      abort.abort();
      await intakeLoop;
      await feedbackLoop;
      await retroLoop;
      await Promise.all(active.values());
      await Promise.allSettled(locks.values());
      if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await release();
    },
  };
}

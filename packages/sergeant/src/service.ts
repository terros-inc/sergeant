import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sergeantVersion, type ApiError, type RepoSlug } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { apiHandler } from "./api.ts";
import { fromThisHost, send } from "./api-http.ts";
import { isLoopbackHost, type Caller } from "./auth.ts";
import type { BudgetWindow } from "./budget.ts";
import { driveCancel, pendingCancels, recordCancel } from "./cancel.ts";
import type { Ports } from "./execute.ts";
import { runLoop, type LoopResult } from "./loop.ts";
import { admissionOrder, Slot } from "./slots.ts";
import { Wake } from "./wake.ts";
import { WEBHOOK_PATHS, webhookHandler, type Nudge } from "./webhooks.ts";

// The long-running Sergeant 2 process (UNF-719): a thin shell over the per-task loop, not a workflow
// engine. Intake polls Linear for open issues delegated to the V2 agent (UNF-724) and runs each one's
// existing loop (loop.ts), at most `maxTasks` holding a slot at a time (slots.ts). Each task loop already re-reads its runs,
// its PRs and their checks, and the Linear conversation every poll, and takes a reasoning turn only
// when those changed, so no webhook is needed: one (webhooks.ts, TECH-4937) only ends a loop's wait
// or runs an intake sooner. Nothing is kept but each task's own `state.json` and a
// recorded API cancel not yet done (`cancel.json`, cancel.ts): a loop that ends (idle, stopped, failed) is admitted again on a later intake while its issue is still
// delegated, and a restarted process rereads everything and continues, repeating some work. One
// process per state directory, held by an OS file lock, so the task limit and one turn per task hold.
// The same server answers the client API (api.ts) that the `sgt` CLI uses.

export type ServiceOptions = {
  enrolledRepositories: RepoSlug[];
  /** Holds `tasks/<issue identifier>/`, one task loop's directory each. */
  stateDir: string;
  /** Task slots: tasks running or waiting on a human within the grace; further delegated issues wait for a free one. */
  maxTasks?: number;
  /** How long a task waiting on a human keeps its slot before the next task in order gets it. */
  waitingGraceMinutes?: number;
  intakeSeconds?: number;
  /** Each task loop's poll interval, and how long it stays with nothing changing and nothing running. */
  pollSeconds?: number;
  idleMinutes?: number;
  /** The budget window of a task that starts; a task already started keeps its stored one (loop.ts). */
  budget?: Partial<BudgetWindow>;
  /** Each task loop's audit sample rate (loop.ts); omitted, the loop's default. */
  auditSampleRate?: number;
  /** Port for `GET /health` and `GET /status`; omitted, no server. 0 picks a free one. */
  port?: number;
  /** Interface the server listens on: loopback unless set. Never publish `/status`. */
  host?: string;
  /** Webhook signing secrets: each source with one gets its `POST /webhooks/<source>` endpoint. */
  webhookSecrets?: { linear?: string; github?: string };
  /** The least time between two webhook wakes of one task loop, or of intake (`Wake.nudge`). */
  webhookGapSeconds?: number;
  /** Who may call the client API with a Linear login, and the client id `sgt login` uses (auth.ts). */
  humans?: { callerOf: (accessToken: string) => Promise<Caller>; linearClientId: string };
  /** Trusts a loopback caller with no login as an operator: for development on one machine, refused unless `host` is 127.0.0.1 or ::1. */
  trustLoopback?: boolean;
  log?: (line: string) => void;
};

export type ServiceDeps = Ports & {
  reasoner: Reasoner;
  /** Open issues delegated to the V2 agent, with their status, priority, and creation time. */
  delegatedIssues: () => Promise<DelegatedIssue[]>;
  /** Removes the issue's delegation to the V2 agent: a human's cancel through the API. */
  undelegate?: (issueId: string) => Promise<void>;
};

export type Service = {
  /** Where `GET /health` listens, once started. */
  port: number | undefined;
  /** Stops intake and resolves once every task loop has ended at its next poll. */
  stop(): Promise<void>;
};

export async function startService(opts: ServiceOptions, deps: ServiceDeps): Promise<Service> {
  if (opts.trustLoopback && !isLoopbackHost(opts.host ?? "127.0.0.1")) throw new Error(`--trust-loopback is refused on a non-loopback --host (${opts.host})`);
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const release = await lockStateDir(opts.stateDir);
  const maxTasks = opts.maxTasks ?? 2;
  const graceMs = (opts.waitingGraceMinutes ?? 15) * 60_000;
  const abort = new AbortController();
  const active = new Map<string, Promise<void>>();
  // Each running loop's slot: released while it waits on a human past the grace (slots.ts).
  const slots = new Map<string, Slot>();
  // When and how each task loop last ended: an unchanged ending (an idle task readmitted every intake,
  // say) is not logged again, and a loop that ended since the latest intake waits for the next.
  const ended = new Map<string, { at: number; outcome: LoopResult["outcome"] | "failed"; detail: string }>();
  let lastIntake: { at: string; error?: string } | undefined;
  let intakeStartedAt = 0;
  // The open issues delegated to the V2 agent at the last intake, in admission order, and each task's wake (API).
  let ordered: DelegatedIssue[] = [];
  let delegated: string[] = [];
  const wakes = new Map<string, Wake>();
  const wakeOf = (issueId: string) => {
    const wake = wakes.get(issueId) ?? new Wake();
    wakes.set(issueId, wake);
    return wake;
  };
  // Ends the intake loop's wait: a webhook naming a delegated issue with no loop, or a delegation change.
  const intakeWake = new Wake();

  const admit = (issueId: string) => {
    if (active.has(issueId)) return;
    const slot = new Slot(() => schedule());
    let outcome: LoopResult["outcome"] | "failed" = "failed";
    let detail = "";
    const loop = runLoop(
      {
        issueId,
        enrolledRepositories: opts.enrolledRepositories,
        dir: join(opts.stateDir, "tasks", issueId),
        ...(opts.pollSeconds !== undefined && { pollSeconds: opts.pollSeconds }),
        ...(opts.idleMinutes !== undefined && { idleMinutes: opts.idleMinutes }),
        ...(opts.budget && { budget: opts.budget }),
        ...(opts.auditSampleRate !== undefined && { auditSampleRate: opts.auditSampleRate }),
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

  // TECH-5008: releases each slot held past the grace by a task waiting on a human, then gives every
  // free slot to the highest-ordered task that wants one: a released task whose human answered, or a
  // delegated issue with no loop. A woken task (`sgt task wake`) goes first. A loop that ended since
  // the latest intake waits for the next one, so an idle task is not readmitted at once, over and over.
  const schedule = () => {
    if (abort.signal.aborted) return;
    for (const [issueId, slot] of slots) {
      if (slot.released || slot.waitingSince === undefined || Date.now() - slot.waitingSince < graceMs) continue;
      slot.released = true;
      slot.waitingSince = undefined;
      log(`${issueId}: waiting on a human past the grace; its task slot is free until the human answers`);
    }
    let free = maxTasks - [...slots.values()].filter((s) => !s.released).length;
    if (free <= 0) return;
    const woken = (id: string) => (wakes.get(id)?.pending ? 0 : 1);
    const queued = ordered
      .map((issue) => issue.identifier)
      .filter((id) => (active.has(id) ? slots.get(id)?.wanted : (ended.get(id)?.at ?? 0) < intakeStartedAt))
      .sort((a, b) => woken(a) - woken(b));
    for (const issueId of queued) {
      if (free-- <= 0) break;
      const slot = slots.get(issueId);
      if (!slot) {
        admit(issueId);
        continue;
      }
      slot.released = false;
      slot.wanted = false;
      log(`${issueId}: the human answered; admitted to a task slot again`);
      wakeOf(issueId).interrupt();
    }
  };

  // A task cancel recorded through the API and not yet confirmed (cancel.ts): driven at once, again
  // at every intake until the runner confirms its runs stopped, and so after a restart too, whether or
  // not the issue is still delegated. One step per task at a time, so a request's own drive is the one
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
  const drive = (ref: string) => driveCancel(opts.stateDir, ref, deps, log);

  const intake = async () => {
    for (const ref of await pendingCancels(opts.stateDir)) {
      await serialized(ref, () => drive(ref)).catch((e: Error) => log(`${ref}: cancel not yet done, retrying next intake: ${e.message}`));
    }
    const startedAt = Date.now();
    const issues = new Map((await deps.delegatedIssues()).map((issue) => [issue.identifier, issue]));
    ordered = [...issues.values()].sort(admissionOrder);
    delegated = ordered.map((issue) => issue.identifier);
    intakeStartedAt = startedAt;
    schedule();
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

  const api = apiHandler({
    stateDir: opts.stateDir,
    enrolledRepositories: opts.enrolledRepositories,
    deps,
    log,
    loop: (ref) => {
      if (active.has(ref)) return { status: "active" };
      const end = ended.get(ref);
      if (end) return { status: end.outcome, detail: end.detail };
      return delegated.includes(ref) ? { status: "queued" } : undefined;
    },
    known: () => [...new Set([...active.keys(), ...delegated])],
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
        await recordCancel(opts.stateDir, ref, { ...req, by }, deps);
        return drive(ref);
      }),
    ...(opts.humans && { callerOf: opts.humans.callerOf, linearClientId: opts.humans.linearClientId }),
    trustLoopback: opts.trustLoopback ?? false,
  });
  // A webhook ends the wait of each loop watching what it names, and runs an intake for a delegated
  // issue with no loop (one that ended idle, say) or a delegation change. Both coalesce: each wakes at
  // most once per `webhookGapSeconds`. An issue or PR no task knows is ignored; the polls cover it.
  const gapMs = (opts.webhookGapSeconds ?? 5) * 1000;
  const nudge = ({ keys, intake }: Nudge) => {
    const named = new Set(keys);
    let admit = intake;
    for (const [issueId, wake] of wakes) {
      if (!named.has(issueId) && !wake.watched.some((k) => named.has(k))) continue;
      if (active.has(issueId)) wake.nudge(gapMs);
      else if (delegated.includes(issueId)) admit = true;
    }
    if (delegated.some((id) => named.has(id) && !active.has(id))) admit = true;
    if (admit) intakeWake.nudge(gapMs);
  };
  const webhooks = webhookHandler({
    secrets: opts.webhookSecrets ?? {},
    agentUserId: deps.agentUserId,
    enrolledRepositories: opts.enrolledRepositories,
    nudge,
    log,
  });
  const webhookPaths = new Set<string>(Object.values(WEBHOOK_PATHS));
  const { version } = sergeantVersion();

  const server =
    opts.port === undefined
      ? undefined
      : createServer((req, res) => {
          // `/health` and the webhooks are the only paths the host's proxy publishes, so `/health` says
          // only whether serve is healthy: not stopping, and its latest intake succeeded. Task ids and
          // intake errors are private, served on `/status` to loopback only, with Sergeant's git version.
          // `/status` refuses any other caller as `/v1` does, so its privacy does not rest on the proxy.
          const ok = !abort.signal.aborted && !lastIntake?.error;
          if (req.method === "GET" && req.url === "/status" && !fromThisHost(req)) {
            const refused: ApiError = { error: { code: "unauthorized", message: "/status answers only a caller on the Sergeant host" } };
            send(res, { status: 401, json: refused });
          } else if (req.method === "GET" && (req.url === "/health" || req.url === "/status")) {
            res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
            const released = [...slots].filter(([, s]) => s.released).map(([id]) => id);
            const detail = req.url === "/status" && { version, stopping: abort.signal.aborted, tasks: [...active.keys()], released, lastIntake };
            res.end(JSON.stringify({ ok, ...detail }));
          } else if (webhookPaths.has(new URL(req.url ?? "/", "http://localhost").pathname)) {
            webhooks(req, res);
          } else {
            api(req, res);
          }
        });
  if (server) await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
  const address = server?.address();

  return {
    port: typeof address === "object" && address ? address.port : undefined,
    async stop() {
      abort.abort();
      await intakeLoop;
      await Promise.all(active.values());
      await Promise.allSettled(locks.values());
      if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await release();
    },
  };
}

/**
 * Holds `<stateDir>/service.lock` until released or this process exits, refusing while another
 * process, or another service in this one, holds it. The exclusion is SQLite's exclusive lock, an
 * OS file lock, so a dead holder's is released with the process and there is no stale lock to take
 * over. The file is never removed: a remover could unlink it under a starter that just opened it,
 * and the next starter would lock a fresh file beside it. `service.pid` only names the holder.
 */
async function lockStateDir(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "service.lock"), { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    const holder = (await readFile(join(stateDir, "service.pid"), "utf8").catch(() => "")).trim();
    throw new Error(`a Sergeant service${holder && ` (pid ${holder})`} already serves ${stateDir}: ${(e as Error).message}`);
  }
  await writeFile(join(stateDir, "service.pid"), `${process.pid}\n`);
  return async () => db.close();
}

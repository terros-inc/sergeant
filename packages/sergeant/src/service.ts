import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { RepoSlug } from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { apiHandler } from "./api.ts";
import { driveCancel, pendingCancels, recordCancel } from "./cancel.ts";
import type { Ports } from "./execute.ts";
import { runLoop, Wake, type LoopResult } from "./loop.ts";

// The long-running Sergeant 2 process (UNF-719): a thin shell over the per-task loop, not a workflow
// engine. Intake polls Linear for open issues delegated to the V2 agent (UNF-724) and runs each one's
// existing loop (loop.ts), at most `maxTasks` at a time. Each task loop already re-reads its runs,
// its PRs and their checks, and the Linear conversation every poll, and takes a reasoning turn only
// when those changed, so no webhook is needed. Nothing is kept but each task's own `state.json` and a
// recorded API cancel not yet done (`cancel.json`, cancel.ts): a loop that ends (idle, stopped, failed) is admitted again on a later intake while its issue is still
// delegated, and a restarted process rereads everything and continues, repeating some work. One
// process per state directory, held by an OS file lock, so the task limit and one turn per task hold.
// The same server answers the loopback client API (api.ts) that the `sgt` CLI uses.

export type ServiceOptions = {
  enrolledRepositories: RepoSlug[];
  /** Holds `tasks/<issue identifier>/`, one task loop's directory each. */
  stateDir: string;
  /** Task loops running at once; further delegated issues wait for a free slot. */
  maxTasks?: number;
  intakeSeconds?: number;
  /** Each task loop's poll interval, and how long it stays with nothing changing and nothing running. */
  pollSeconds?: number;
  idleMinutes?: number;
  /** Port for `GET /health` and `GET /status`; omitted, no server. 0 picks a free one. */
  port?: number;
  /** Interface the server listens on: loopback unless set. Never publish `/status`. */
  host?: string;
  log?: (line: string) => void;
};

export type ServiceDeps = Ports & {
  reasoner: Reasoner;
  /** Open issues delegated to the V2 agent, by identifier. */
  delegatedIssues: () => Promise<string[]>;
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
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const release = await lockStateDir(opts.stateDir);
  const maxTasks = opts.maxTasks ?? 2;
  const abort = new AbortController();
  const active = new Map<string, Promise<void>>();
  // When and how each task loop last ended: a slot goes to the issue that waited longest, and an
  // unchanged ending (an idle task readmitted every intake, say) is not logged again.
  const ended = new Map<string, { at: number; outcome: LoopResult["outcome"] | "failed"; detail: string }>();
  let lastIntake: { at: string; error?: string } | undefined;
  // The open issues delegated to the V2 agent at the last intake, and each task's wake (API).
  let delegated: string[] = [];
  const wakes = new Map<string, Wake>();
  const wakeOf = (issueId: string) => {
    const wake = wakes.get(issueId) ?? new Wake();
    wakes.set(issueId, wake);
    return wake;
  };

  const admit = (issueId: string) => {
    if (active.has(issueId)) return;
    let outcome: LoopResult["outcome"] | "failed" = "failed";
    let detail = "";
    const loop = runLoop(
      {
        issueId,
        enrolledRepositories: opts.enrolledRepositories,
        dir: join(opts.stateDir, "tasks", issueId),
        ...(opts.pollSeconds !== undefined && { pollSeconds: opts.pollSeconds }),
        ...(opts.idleMinutes !== undefined && { idleMinutes: opts.idleMinutes }),
        log: (line) => log(`${issueId}: ${line}`),
        signal: abort.signal,
        wake: wakeOf(issueId),
      },
      deps,
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
        ended.set(issueId, { at: Date.now(), outcome, detail });
      });
    active.set(issueId, loop);
  };

  // A task cancel recorded through the API and not yet confirmed (cancel.ts): driven at once, again
  // at every intake until the runner confirms its runs stopped, and so after a restart too, whether or
  // not the issue is still delegated. One step per task at a time, so a request's own drive is the one
  // that answers it; it is not held to the task limit.
  const closing = new Map<string, Promise<unknown>>();
  const serialized = <T>(ref: string, step: () => Promise<T>): Promise<T> => {
    const next = (closing.get(ref) ?? Promise.resolve()).catch(() => {}).then(step);
    closing.set(ref, next);
    void next
      .finally(() => {
        if (closing.get(ref) === next) closing.delete(ref);
        // The task's loop, polled now, finds its delegation gone and ends.
        if (active.has(ref)) wakeOf(ref).interrupt();
      })
      .catch(() => {});
    return next;
  };
  const drive = (ref: string) => driveCancel(opts.stateDir, ref, deps, log);

  const intake = async () => {
    for (const ref of await pendingCancels(opts.stateDir)) {
      await serialized(ref, () => drive(ref)).catch((e: Error) => log(`${ref}: cancel not yet done, retrying next intake: ${e.message}`));
    }
    delegated = [...new Set(await deps.delegatedIssues())];
    if (abort.signal.aborted) return;
    const waiting = delegated.filter((id) => !active.has(id));
    // A woken task first, then the one that waited longest.
    const woken = (id: string) => (wakes.get(id)?.pending ? 0 : 1);
    waiting.sort((a, b) => woken(a) - woken(b) || (ended.get(a)?.at ?? 0) - (ended.get(b)?.at ?? 0));
    for (const issueId of waiting.slice(0, Math.max(0, maxTasks - active.size))) admit(issueId);
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
      await sleep((opts.intakeSeconds ?? 120) * 1000, undefined, { signal: abort.signal }).catch(() => {});
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
    cancelTask: (ref, req) =>
      serialized(ref, async () => {
        await recordCancel(opts.stateDir, ref, req, deps);
        return drive(ref);
      }),
  });
  const server =
    opts.port === undefined
      ? undefined
      : createServer((req, res) => {
          // `/health` is the one path the host's proxy publishes, so it says only whether serve is
          // healthy: not stopping, and its latest intake succeeded. Task ids and intake errors are
          // private, served on `/status` to loopback only.
          const ok = !abort.signal.aborted && !lastIntake?.error;
          if (req.method === "GET" && (req.url === "/health" || req.url === "/status")) {
            res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
            const detail = req.url === "/status" && { stopping: abort.signal.aborted, tasks: [...active.keys()], lastIntake };
            res.end(JSON.stringify({ ok, ...detail }));
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
      await Promise.allSettled(closing.values());
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

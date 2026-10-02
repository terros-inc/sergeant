import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { RepoSlug } from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import type { Ports } from "./execute.ts";
import { runLoop } from "./loop.ts";

// The long-running Sergeant 2 process (UNF-719): a thin shell over the per-task loop, not a workflow
// engine. Intake polls Linear for open issues delegated to the V2 agent (UNF-724) and runs each one's
// existing loop (loop.ts), at most `maxTasks` at a time. Each task loop already re-reads its runs,
// its PRs and their checks, and the Linear conversation every poll, and takes a reasoning turn only
// when those changed, so no webhook is needed. Nothing is kept but each task's own `state.json`: a
// loop that ends (idle, stopped, failed) is admitted again on a later intake while its issue is still
// delegated, and a restarted process rereads everything and continues, repeating some work. One
// process per state directory, held by an OS file lock, so the task limit and one turn per task hold.

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
  /** Port for `GET /health`; omitted, no server. 0 picks a free one. */
  port?: number;
  /** Interface `GET /health` listens on: loopback unless set. */
  host?: string;
  log?: (line: string) => void;
};

export type ServiceDeps = Ports & {
  reasoner: Reasoner;
  /** Open issues delegated to the V2 agent, by identifier. */
  delegatedIssues: () => Promise<string[]>;
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
  const ended = new Map<string, { at: number; outcome: string }>();
  let lastIntake: { at: string; error?: string } | undefined;

  const admit = (issueId: string) => {
    if (active.has(issueId)) return;
    let outcome = "failed";
    const loop = runLoop(
      {
        issueId,
        enrolledRepositories: opts.enrolledRepositories,
        dir: join(opts.stateDir, "tasks", issueId),
        ...(opts.pollSeconds !== undefined && { pollSeconds: opts.pollSeconds }),
        ...(opts.idleMinutes !== undefined && { idleMinutes: opts.idleMinutes }),
        log: (line) => log(`${issueId}: ${line}`),
        signal: abort.signal,
      },
      deps,
    )
      .then(
        (result) => {
          outcome = result.outcome;
          if (ended.get(issueId)?.outcome !== outcome) log(`${issueId}: loop ended ${outcome}: ${result.detail}`);
        },
        // A failed iteration ends the loop; the next intake admits it again.
        (e: Error) => log(`${issueId}: loop failed, retrying on a later intake: ${e.message}`),
      )
      .finally(() => {
        if (active.get(issueId) === loop) active.delete(issueId);
        ended.set(issueId, { at: Date.now(), outcome });
      });
    active.set(issueId, loop);
  };

  const intake = async () => {
    const waiting = [...new Set(await deps.delegatedIssues())].filter((id) => !active.has(id));
    waiting.sort((a, b) => (ended.get(a)?.at ?? 0) - (ended.get(b)?.at ?? 0));
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

  const server =
    opts.port === undefined
      ? undefined
      : createServer((req, res) => {
          if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, stopping: abort.signal.aborted, tasks: [...active.keys()], lastIntake }));
          } else {
            res.writeHead(404).end();
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

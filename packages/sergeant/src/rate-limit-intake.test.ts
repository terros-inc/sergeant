import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubRateLimitedError, LinearRateLimitedError } from "@terros/sergeant-contracts";
import { call } from "./api-fixtures.ts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-5923: every task loop that failed on Linear's rate limit was readmitted at the next intake, two
// minutes later, and read Linear again at once, so the spent budget never refilled.
// TECH-5941: such a loop showed as `failed` until its reset, though it resumes on its own.

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

const underWay = async (...refs: string[]) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-rate-limit-test-"));
  const now = new Date().toISOString();
  for (const ref of refs) {
    await mkdir(join(dir, "tasks", ref), { recursive: true });
    await writeFile(join(dir, "tasks", ref, "state.json"), JSON.stringify({ issueId: ref, turns: 1, recentTurns: [], startedAt: now, runIds: [], owner: { id: "user-ann", name: "Ann", admittedAt: now } }));
  }
};

test("a loop that failed on Linear's rate limit is not readmitted before the limit resets", async () => {
  await underWay("UNF-1");
  const reads: number[] = [];
  const PAUSE_MS = 600;
  const deps = {
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [],
    linear: {
      readConversation: async () => {
        reads.push(Date.now());
        throw new LinearRateLimitedError(new Date(reads[0]! + PAUSE_MS).toISOString());
      },
    },
    runner: { status: async () => Promise.reject(new Error("no runs")) },
  } as unknown as ServiceDeps;
  const service = await startService({ enrolledRepositories: [], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, slowPollMinutes: 0.0001, log: () => {} }, deps);
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(1), { timeout: 5_000 });
    // Dozens of intakes while the limit holds: none readmits the loop.
    await sleep(PAUSE_MS / 2);
    expect(reads).toHaveLength(1);
    // Once it resets, the next intake does.
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1), { timeout: 5_000 });
    expect(reads[1]! - reads[0]!).toBeGreaterThanOrEqual(PAUSE_MS);
  } finally {
    await service.stop();
  }
});

test("a rate-limited task is listed as paused until its reset, then active again; a real failure stays failed", async () => {
  await underWay("UNF-1", "UNF-2", "UNF-3");
  const PAUSE_MS = 3_000;
  const until = new Date(Date.now() + PAUSE_MS).toISOString();
  const reads: Record<string, number> = {};
  // Once resumed, a loop's read waits here, so its task stays active until the test ends.
  let release = (_: Error) => {};
  const held = new Promise<never>((_, reject) => (release = reject));
  held.catch(() => {});
  const deps = {
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [],
    linear: {
      readConversation: async (ref: string) => {
        reads[ref] = (reads[ref] ?? 0) + 1;
        if (ref === "UNF-3") throw new Error("Linear answered 500");
        if (reads[ref] > 1) return held;
        throw ref === "UNF-1" ? new GitHubRateLimitedError(until) : new LinearRateLimitedError(until);
      },
    },
    runner: { status: async () => Promise.reject(new Error("no runs")) },
  } as unknown as ServiceDeps;
  const service = await startService({ enrolledRepositories: [], stateDir: dir, intakeSeconds: 0.05, pollSeconds: 0, slowPollMinutes: 0.0001, port: 0, trustLoopback: true, log: () => {} }, deps);
  const tasks = async () => Object.fromEntries((await call(service.port ?? 0, "GET", "/v1/tasks")).json.tasks.map((t: { ref: string }) => [t.ref, t]));
  try {
    await vi.waitFor(async () => {
      const t = await tasks();
      expect(t["UNF-1"]).toMatchObject({ status: "paused", statusDetail: `rate-limited by GitHub until ${until}`, paused: { provider: "GitHub", until } });
      expect(t["UNF-2"]).toMatchObject({ status: "paused", statusDetail: `rate-limited by Linear until ${until}`, paused: { provider: "Linear", until } });
      expect(t["UNF-3"]).toMatchObject({ status: "failed", statusDetail: "Linear answered 500" });
      expect(t["UNF-3"].paused).toBeUndefined();
    }, { timeout: 5_000 });
    expect(Date.now()).toBeLessThan(Date.parse(until));
    // After the reset, the next intake resumes both on its own.
    await vi.waitFor(async () => {
      const t = await tasks();
      expect([t["UNF-1"].status, t["UNF-2"].status]).toEqual(["active", "active"]);
      expect(t["UNF-1"].paused).toBeUndefined();
    }, { timeout: 5_000 });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(until));
    await vi.waitFor(async () => expect((await tasks())["UNF-3"].status).toBe("failed"), { timeout: 5_000 });
  } finally {
    release(new Error("test over"));
    await service.stop();
  }
}, 30_000);

// TECH-6208: a stopped task whose stop a rate limit held up logged the same refusal at every poll and
// intake, every few seconds for the whole pause, and buried the real signal. It is paused like any
// other task now, named in the rate-limit event, and the adapter's one log line is the only one.
test("a stop held up by a rate limit pauses its task without logging the refusal at every poll", async () => {
  await underWay("UNF-1");
  await writeFile(join(dir, "tasks", "UNF-1", "cancel.json"), JSON.stringify({ reason: "the issue was moved to Backlog", requestId: "req-1", at: new Date().toISOString() }));
  const until = new Date(Date.now() + 60_000).toISOString();
  let reads = 0;
  const deps = {
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [],
    linear: {
      readConversation: async () => {
        reads++;
        throw new LinearRateLimitedError(until);
      },
    },
    runner: { status: async () => Promise.reject(new Error("no runs")) },
  } as unknown as ServiceDeps;
  const logs: string[] = [];
  const paused: string[] = [];
  const apiUsage = { taskPaused: (provider: string, ref: string) => void paused.push(`${provider} ${ref}`), usage: () => { throw new Error("not read"); } };
  const service = await startService({ enrolledRepositories: [], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, slowPollMinutes: 0.0001, log: (l) => logs.push(l), apiUsage }, deps);
  try {
    await vi.waitFor(() => expect(reads).toBeGreaterThan(20), { timeout: 5_000 });
    expect(paused).toEqual(["linear UNF-1"]);
    expect(logs.filter((l) => l.includes("rate limit"))).toEqual([]);
  } finally {
    await service.stop();
  }
});

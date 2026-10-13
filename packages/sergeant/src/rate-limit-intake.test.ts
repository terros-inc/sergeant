import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { LinearRateLimitedError } from "@terros/sergeant-contracts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-5923: every task loop that failed on Linear's rate limit was readmitted at the next intake, two
// minutes later, and read Linear again at once, so the spent budget never refilled.

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a loop that failed on Linear's rate limit is not readmitted before the limit resets", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-rate-limit-test-"));
  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify({ issueId: "UNF-1", turns: 1, recentTurns: [], startedAt: now, runIds: [], owner: { id: "user-ann", name: "Ann", admittedAt: now } }));
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
  const service = await startService({ enrolledRepositories: [], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, log: () => {} }, deps);
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

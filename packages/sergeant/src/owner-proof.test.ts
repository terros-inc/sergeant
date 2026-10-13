import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation } from "@terros/sergeant-contracts";
import { apiCalls } from "./api-calls.ts";
import { DEFAULT_BUDGET } from "./budget.ts";
import type { Ports } from "./execute.ts";
import { checkStop, OWNER_RECHECK_JITTER_MS, OWNER_RECHECK_MS, type PollContext } from "./poll-checks.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5974: a restart used to drop the in-memory ownership proof, so all ~44 active loops reread their
// full delegation history from Linear at the same instant, which tripped Linear's rate limit. The proof
// is now kept in state.json, so a restart that reloads a still-valid proof reads nothing, and the rereads
// that do fall due are spread across a per-issue jitter rather than bursting at once.

const owner = { id: "user-ann", name: "Ann", admittedAt: "2026-10-13T00:00:00.000Z" };
const N = 44;
const issueIds = Array.from({ length: N }, (_, i) => `TECH-${5900 + i}`);

function liveOf(issueId: string): Conversation {
  return { issue: { id: `i-${issueId}`, identifier: issueId, stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, assignee: owner, linkedPullRequests: [] }, humanComments: [], agentComments: [] } as unknown as Conversation;
}

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A loop's poll context, with a counter for the Linear calls each ownership reread makes. */
function taskCtx(issueId: string, provenAt: string | undefined, calls: { ownership: number }): PollContext {
  const state = { issueId, startedAt: owner.admittedAt, owner, ownerProvenAt: provenAt, budget: { window: DEFAULT_BUDGET } } as unknown as TaskState;
  const deps = { agentUserId: "agent-v2", linear: { readTaskOwner: async () => (calls.ownership++, { owner }) } } as unknown as Ports;
  return { opts: { issueId, dir }, deps, state, log: () => {}, save: async () => {} } as unknown as PollContext;
}

/** The ownership rereads N loops make on their first poll after a restart, given how each reloads its proof. */
async function restartReads(provenAt: (issueId: string) => string | undefined): Promise<number> {
  const calls = { ownership: 0 };
  for (const id of issueIds) expect(await checkStop(liveOf(id), [], taskCtx(id, provenAt(id), calls))).toBeUndefined();
  return calls.ownership;
}

test("a restart rereads every proof without persistence, and none with a still-valid persisted proof", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-owner-proof-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Before TECH-5974 a restart dropped the in-memory proof: every one of the ~44 loops reread at once.
    expect(await restartReads(() => undefined)).toBe(N);

    // After it, a proof proven just before the restart is reloaded from state.json and not redone.
    const provenAt = new Date().toISOString();
    expect(await restartReads(() => provenAt)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("rereads that fall due after a restart spread across the jitter window, not in one burst", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-owner-proof-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const calls = { ownership: 0 };
    // Every loop was proven at the same instant just before the restart, the worst case for a stampede.
    const provenAt = new Date().toISOString();
    const ctxs = issueIds.map((id) => taskCtx(id, provenAt, calls));
    const poll = async () => {
      for (const ctx of ctxs) await checkStop(liveOf(ctx.opts.issueId), [], ctx);
    };

    // Within the recheck window nothing is reread.
    vi.setSystemTime(Date.parse(provenAt) + OWNER_RECHECK_MS - 1);
    await poll();
    expect(calls.ownership).toBe(0);

    // From the window's end through its jitter, poll each minute and record how many reread in each.
    const perMinute: number[] = [];
    for (let minute = 0; minute <= OWNER_RECHECK_JITTER_MS / 60_000; minute++) {
      vi.setSystemTime(Date.parse(provenAt) + OWNER_RECHECK_MS + minute * 60_000);
      const before = calls.ownership;
      await poll();
      perMinute.push(calls.ownership - before);
    }

    // Every proof is eventually reread exactly once, but no single minute carries the whole burst.
    expect(calls.ownership).toBe(N);
    expect(Math.max(...perMinute)).toBeLessThan(N);
  } finally {
    vi.useRealTimers();
  }
});

test("an ownership reread is attributed to the `ownership check` source (TECH-5942 counters)", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-owner-proof-"));
  const counter = apiCalls(() => {});
  // The Linear adapter's calls run through a counting fetch; readTaskOwner stands in for its two requests
  // (the ownership snapshot and one history page), both made inside owner.ts's `withSource("ownership check")`.
  const fetchLinear = counter.counting("linear", (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch);
  const deps = {
    agentUserId: "agent-v2",
    linear: {
      readTaskOwner: async () => {
        await fetchLinear("https://api.linear.app/graphql");
        await fetchLinear("https://api.linear.app/graphql");
        return { owner };
      },
    },
  } as unknown as Ports;
  const ctx = { opts: { issueId: "TECH-5900", dir }, deps, state: { issueId: "TECH-5900", startedAt: owner.admittedAt, owner, budget: { window: DEFAULT_BUDGET } } as unknown as TaskState, log: () => {}, save: async () => {} } as unknown as PollContext;

  expect(await checkStop(liveOf("TECH-5900"), [], ctx)).toBeUndefined();

  const ownership = counter.status().filter((c) => c.source === "ownership check");
  expect(ownership).toHaveLength(1);
  expect(ownership[0]).toMatchObject({ provider: "linear", calls: 2 });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation } from "@terros/sergeant-contracts";
import { apiCalls } from "./api-calls.ts";
import { DEFAULT_BUDGET } from "./budget.ts";
import type { Ports } from "./execute.ts";
import { OWNER_READ_BURST, OWNER_READ_SPACING_MS, OwnerReadPacer } from "./owner-pace.ts";
import { checkStop, type PollContext } from "./poll-checks.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5974: a restart used to drop the in-memory ownership proof, so all ~44 active loops reread their
// full delegation history from Linear at the same instant, which tripped Linear's rate limit. The proof
// is now kept in state.json, so a restart that reloads a still-valid proof reads nothing, and the rereads
// that fall due together on the next poll tick are paced by one shared pacer rather than bursting at once.

const owner = { id: "user-ann", name: "Ann", admittedAt: "2026-10-13T00:00:00.000Z" };
const N = 44;
/** The service's default safety-net poll (`slowPollMinutes`), the cadence an idle loop polls on. */
const SLOW_POLL_MS = 15 * 60_000;
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

test("on the real ~15-minute poll cadence a restart's rechecks are paced, not one 44-task burst", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-owner-proof-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const restart = Date.now();
    const calls: number[] = [];
    const pacer = new OwnerReadPacer(OWNER_READ_SPACING_MS, OWNER_READ_BURST, async (ms) => {
      calls.push(Math.floor((Date.now() + ms - restart) / 60_000));
    });
    const provenAt = new Date(restart).toISOString();
    const counted = { ownership: 0 };
    const ctxs = issueIds.map((id) => ({ ...taskCtx(id, provenAt, counted), opts: { issueId: id, dir, ownerReads: pacer } }) as unknown as PollContext);
    const unpaced = issueIds.map((id) => taskCtx(id, provenAt, { ownership: 0 }));

    // The restart itself, with every proof persisted and still valid: no reread at all.
    for (const ctx of ctxs) await checkStop(liveOf(ctx.opts.issueId), [], ctx);
    expect(counted.ownership).toBe(0);

    // The next poll tick, a full safety-net interval later: every recheck has fallen due on the same tick,
    // jitter and all. Unpaced, all 44 reread in that instant (the reviewer's finding).
    vi.setSystemTime(restart + SLOW_POLL_MS);
    const before = { ownership: 0 };
    for (const ctx of unpaced) {
      (ctx.deps.linear as unknown as { readTaskOwner: () => Promise<unknown> }).readTaskOwner = async () => (before.ownership++, { owner });
      await checkStop(liveOf(ctx.opts.issueId), [], ctx);
    }
    expect(before.ownership).toBe(N);

    // Paced, each loop's reread waits its turn: all 44 still reread exactly once, a few at once and then
    // one every 10 seconds, so no minute carries more than the burst plus six.
    for (const ctx of ctxs) await checkStop(liveOf(ctx.opts.issueId), [], ctx);
    expect(counted.ownership).toBe(N);
    const perMinute = new Map<number, number>();
    for (const m of calls) perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(OWNER_READ_BURST + 60_000 / OWNER_READ_SPACING_MS);
    // Spread over about seven minutes, all before the next poll tick.
    expect(Math.max(...calls) - Math.min(...calls)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...calls)).toBeLessThan(2 * SLOW_POLL_MS / 60_000);
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

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, issue, merge, review, saved, scenario, start, stopAfter, turnOf, worker } from "./budget-scenario.ts";

// UNF-728: runaway time is a material harm Sergeant must prevent. An exhausted task budget, or a human
// undelegating the issue, must cancel running work for real (an unconfirmed cancel is retried, never
// taken as stopped), and an exhausted budget must refuse every new effect until a human's reply to the
// one budget question opens a fresh window. These hold across a crash at any point and a restart.

afterEach(cleanup);

test("exhausted wall time cancels the running worker, asks once, refuses effects, and a reply opens a fresh window", async () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const before = human("c0", threeHoursAgo, "Please go ahead.");
  let w = worker("running");
  let cancels = 0;
  const started: string[] = [];
  const decisions: string[][] = [];
  let stopAt = Infinity;

  const { result, posted, merged } = await scenario({
    state: { startedAt: threeHoursAgo, runIds: ["run_w"] },
    conversation: { humanComments: [before] },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async (id) => (id === "run_w" ? w : worker("running")),
      // The first attempt is not confirmed: the run is not stopped until the runner says so.
      cancel: async () => {
        if (++cancels === 1) throw new Error("docker did not answer");
        w = worker("canceled");
      },
    },
    reasoner: async (situation) => {
      decisions.push(situation.conversation.humanComments.map((c) => c.id));
      return turnOf([start]);
    },
    onPoll: async (poll, live) => {
      if (poll >= stopAt) await writeFile(join(dir, "STOP"), "");
      if (started.length > 0) stopAt = Math.min(stopAt, poll + 1);
      // A human answers some polls after the question appears.
      if (live.agentComments.length > 0 && live.humanComments.length === 1 && poll > 6) {
        const at = new Date(Date.parse(live.agentComments[0]?.createdAt ?? "") + 1_000).toISOString();
        return { ...live, humanComments: [before, human("c1", at, "Extend, one more window.")] };
      }
      return live;
    },
  });

  expect(result.outcome).toBe("stopped");
  expect(cancels).toBe(2);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  expect(posted[0]).toContain("worker canceled");
  expect(posted[0]).toContain("Extend: continue in a fresh window");
  // No turn until the human replied; then one in the fresh window, which starts. The old comment
  // before the question opened nothing.
  expect(decisions).toEqual([["c0", "c1"]]);
  const { budget, recentTurns } = await saved();
  expect(recentTurns[0]?.outcomes).toEqual([expect.stringMatching(/^start_worker: done/)]);
  expect(budget.since).not.toBe(threeHoursAgo);
  expect(budget.priorRuns).toEqual(["run_w"]);
  expect(merged).toEqual([]);
  expect(started).toHaveLength(1);
});

test("observed spend at the limit refuses an otherwise allowed merge and asks instead", async () => {
  let turns = 0;
  const { result, posted, merged } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w", "run_review"], turnCostUsd: 1.5 },
    runner: {
      start: async () => {},
      status: async (id) => (id === "run_w" ? worker("succeeded", 13.5) : review),
      cancel: async () => {},
    },
    reasoner: async () => (turns++, turnOf([merge])),
    onPoll: stopAfter(3),
  });

  expect(result.outcome).toBe("stopped");
  expect(turns).toBe(0);
  expect(merged).toEqual([]);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("spent $25.00 of $25.00");
});

test("a reasoning turn's own cost counts before its proposals run", async () => {
  const started: string[] = [];
  const { posted } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [], turnCostUsd: 24.5 },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => turnOf([start], 1),
    onPoll: stopAfter(4),
  });

  expect(started).toEqual([]);
  expect((await saved()).recentTurns[0]?.outcomes[0]).toMatch(/^start_worker: denied by B1 \(spent \$25\.50 of \$25\.00\)/);
  expect(posted[0]).toContain("spent $25.50 of $25.00");
});

test("a deadline that passes during the live reads before a start refuses the start", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started: string[] = [];
  let turned = false;
  await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [] },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => ((turned = true), turnOf([start])),
    onPoll: async (poll, live) => {
      // The executor's live Linear read, after the turn, takes until past the deadline.
      if (turned) {
        vi.setSystemTime(Date.now() + 3 * 3_600_000);
        turned = false;
      }
      return stopAfter(4)(poll, live);
    },
  });

  expect(started).toEqual([]);
  expect((await saved()).recentTurns[0]?.outcomes[0]).toMatch(/^start_worker: denied by B1 \(wall time exhausted/);
});

test("a start whose runner call fails after starting the run lets no other start through in its turn", async () => {
  const started: string[] = [];
  let turns = 0;
  await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [] },
    runner: {
      // The run starts, but its response is lost: the run may be running.
      start: async (spec) => {
        started.push(spec.runId);
        throw new Error("response lost");
      },
      status: async (id) => ({ ...worker("running"), runId: id }),
      cancel: async () => {},
    },
    reasoner: async () => turnOf(turns++ === 0 ? [start, start] : []),
    onPoll: stopAfter(3),
  });

  expect(started).toHaveLength(1);
  const state = await saved();
  expect(state.runIds).toEqual(started);
  expect(state.recentTurns[0]?.outcomes).toEqual([
    "start_worker: failed (response lost)",
    expect.stringMatching(/^start_worker: denied by R4 /),
  ]);
});

test("a restart keeps the task's stored budget window whatever the options say", async () => {
  let turns = 0;
  const { posted } = await scenario({
    state: { startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), runIds: [], budget: { window: { wallMinutes: 5, costUsd: 1 } } },
    runner: { start: async () => {}, status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([start])),
    onPoll: stopAfter(3),
    loop: { budget: { wallMinutes: 120, costUsd: 25 } },
  });

  expect(turns).toBe(0);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  expect((await saved()).budget.window).toEqual({ wallMinutes: 5, costUsd: 1 });
});

test.each([
  ["Extend, one more window.", [start]],
  ["Accept as-is.", []],
])("a budget question posted before a crash is found again, never asked twice, and its reply %j is honored", async (reply, actions) => {
  const asked = new Date(Date.now() - 60_000).toISOString();
  const answeredAt = new Date(Date.parse(asked) + 1_000).toISOString();
  const question = { id: commentIdFor(budgetQuestionKey(issue.id, undefined)), createdAt: asked, body: "**Question for you** ... Continue?" };
  const started: string[] = [];
  const { result, posted } = await scenario({
    // The question is on Linear, but nothing about it reached state.json.
    state: { startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), runIds: [] },
    conversation: { agentComments: [question], humanComments: [human("c1", answeredAt, reply)] },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("succeeded", 0), cancel: async () => {} },
    // Either reply opens a fresh window; reasoning reads which it was, and only "Extend" works on.
    reasoner: async (situation) => turnOf(situation.recentTurns.length === 0 ? actions : []),
    onPoll: (_poll, live) => live,
  });

  expect(result.outcome).toBe("idle");
  expect(posted).toEqual([]);
  expect((await saved()).budget.since).toBe(answeredAt);
  expect(started).toHaveLength(actions.length);
});

import { readdir } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import type { ProposedAction, RunRecord } from "@terros/sergeant-contracts";
import { closedKey } from "./accepted.ts";
import { cleanup, dir, human, issue, saved, scenario, start, turnOf } from "./budget-scenario.ts";

// TECH-5232: a worker that verified an issue needs no change used to leave Sergeant asking a human to
// close it (TECH-5093 already covered on main, TECH-5100 obsolete). Now the task closes the issue
// itself through the accepted ending: one evidence comment, the issue Done or Canceled, the task set
// aside. A close is terminal and visible, so it must land once and never over a PR in flight.

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const evidence = "Covered on main by abc1234: src/retry.ts caps retries, retry.test.ts covers it.";
const close: ProposedAction = { kind: "close_issue", state: "done", evidence };
const verified: RunRecord = {
  runId: "run_w",
  role: "worker",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "Nothing to change: already on main.", pullRequests: [], knownGaps: [], followups: [] },
};
const runner = (started: string[]) => ({
  start: async (spec: { runId: string }) => void started.push(spec.runId),
  status: async (id: string) => (id === "run_w" ? verified : { ...verified, runId: id, status: "running" as const, report: null }),
  cancel: async () => {},
});
const task = { startedAt: ago(10), runIds: ["run_w"], turnCostUsd: 0 };
const noPr = { issue: { ...issue, linkedPullRequests: [] } };

test("a verified nothing-to-change closes the issue with one evidence comment and ends the task, asking nothing", async () => {
  const started: string[] = [];
  let turns = 0;
  const { result, posted, closed } = await scenario({
    state: task,
    conversation: noPr,
    runner: runner(started),
    reasoner: async () => (turns++, turnOf([close, start])),
    onPoll: (_poll, live) => live,
  });

  expect(result).toEqual({ outcome: "accepted", detail: "Sergeant closed the issue as Done: nothing to change" });
  expect(turns).toBe(1);
  expect(started).toEqual([]);
  expect(closed).toEqual(["done"]);
  expect(posted).toEqual([expect.stringMatching(new RegExp(`^Sergeant closed this issue as Done.*\\*\\*Evidence:\\*\\* ${evidence}.*move the issue back to Todo`, "s"))]);
  const files = await readdir(dir);
  expect(files).not.toContain("state.json");
  expect(files).not.toContain("accepted.json");
  expect(files.some((f) => /^state\.accepted-.+\.json$/.test(f))).toBe(true);
});

test("a task with a PR is refused the close and goes on, closing nothing and posting nothing", async () => {
  const { result, posted, closed } = await scenario({
    state: task,
    runner: runner([]),
    reasoner: async () => turnOf([{ ...close, state: "canceled" }]),
    onPoll: (_poll, live) => live,
  });

  expect(result.outcome).toBe("idle");
  expect(closed).toEqual([]);
  expect(posted).toEqual([]);
  expect((await saved()).recentTurns.at(-1)?.outcomes).toEqual([expect.stringMatching(/^close_issue: denied by C1 \(the task has PRs \(o\/canary#7\)/)]);
});

test("a close whose comment post failed is decided again by a fresh turn, its evidence posted once under the same key", async () => {
  const keys: string[] = [];
  let turns = 0;
  const { result, posted, closed } = await scenario({
    state: task,
    conversation: noPr,
    runner: runner([]),
    reasoner: async () => (turns++, turnOf([close])),
    onPoll: (_poll, live) => live,
    beforePost: ({ key }) => {
      keys.push(key);
      if (keys.length === 1) throw new Error("socket hang up");
    },
  });

  expect(result.detail).toBe("Sergeant closed the issue as Done: nothing to change");
  expect(turns).toBe(2);
  expect(closed).toEqual(["done"]);
  expect(posted).toHaveLength(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toMatch(new RegExp(`^${closedKey("i1", "")}`));
});

// TECH-5236: the close used to be saved with the turn and made on the next pass, which rechecked only
// delegation, so a human comment or a PR that came in between was overtaken. Now the evidence and the
// close are made on the very read the Gate allowed (C1-C4); anything newer denies it and wakes a turn.

test("a close is made on the read the Gate allowed, before any later read, so later input is never overtaken", async () => {
  let polls = 0;
  let postedOnPoll = 0;
  const { result, closed, live } = await scenario({
    state: task,
    conversation: noPr,
    runner: runner([]),
    reasoner: async () => turnOf([close]),
    // The pass after the closing turn is where the deferred close used to run: a human objects there.
    onPoll: (poll, live) => ((polls = poll), poll === 3 ? { ...live, humanComments: [human("c1", ago(0), "wait, this still needs work")] } : live),
    beforePost: () => void (postedOnPoll = polls),
  });

  expect(postedOnPoll).toBe(2);
  expect(closed).toEqual(["done"]);
  expect(live.issue.stateType).toBe("completed");
  expect(result.outcome).toBe("accepted");
});

test("a human comment posted while the closing turn reasoned denies the close (C4), and a fresh turn reads it", async () => {
  const seen: number[] = [];
  const { closed, posted } = await scenario({
    state: task,
    conversation: noPr,
    runner: runner([]),
    reasoner: async (s) => (seen.push(s.conversation.humanComments.length), turnOf(seen.length === 1 ? [close] : [])),
    onPoll: (poll, live) => (poll === 2 ? { ...live, humanComments: [human("c1", ago(0), "wait, this still needs work")] } : live),
  });

  expect(closed).toEqual([]);
  expect(posted).toEqual([]);
  expect(seen).toEqual([0, 1]);
  const turns = (await saved()).recentTurns;
  expect(turns.at(-2)?.outcomes).toEqual([expect.stringMatching(/^close_issue: denied by C4 /)]);
});

test("a PR linked while the closing turn reasoned denies the close (C1), posting nothing", async () => {
  const { closed, posted } = await scenario({
    state: task,
    conversation: noPr,
    runner: runner([]),
    reasoner: async () => turnOf([close]),
    onPoll: (poll, live) => (poll === 2 ? { ...live, issue: { ...live.issue, linkedPullRequests: [{ repo: "o/canary", number: 9 }] } } : live),
  });

  expect(closed).toEqual([]);
  expect(posted).toEqual([]);
  expect((await saved()).recentTurns.at(-1)?.outcomes).toEqual([expect.stringMatching(/^close_issue: denied by C1 \(the task has PRs \(o\/canary#9\)/)]);
});

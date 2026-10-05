import { readdir } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import type { ProposedAction, RunRecord } from "@terros/sergeant-contracts";
import { closedKey } from "./accepted.ts";
import { cleanup, dir, issue, saved, scenario, start, turnOf } from "./budget-scenario.ts";

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

test("a close whose comment post failed is replayed once resumed, under the same key and with no new turn", async () => {
  const keys: string[] = [];
  const failed = await scenario({
    state: task,
    conversation: noPr,
    runner: runner([]),
    reasoner: async () => turnOf([close]),
    onPoll: (_poll, live) => live,
    beforePost: ({ key }) => {
      keys.push(key);
      throw new Error("socket hang up");
    },
  }).catch((e: Error) => e);
  expect(failed).toBeInstanceOf(Error);
  expect(await readdir(dir)).toContain("state.json");

  let turns = 0;
  const { result, closed } = await scenario({
    conversation: noPr,
    runner: runner([]),
    reasoner: async () => (turns++, turnOf([start])),
    onPoll: (_poll, live) => live,
    beforePost: ({ key }) => void keys.push(key),
  });

  expect(result.detail).toBe("Sergeant closed the issue as Done: nothing to change");
  expect(turns).toBe(0);
  expect(closed).toEqual(["done"]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toMatch(new RegExp(`^${closedKey("i1", "")}`));
});

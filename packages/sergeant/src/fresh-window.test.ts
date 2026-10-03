import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, issue, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5059: a human's answer to one of Sergeant's questions gives the task a fresh budget window from
// the answer. Without it, an answer to a question that waited long enough was met at once by a budget
// question, and the human had to answer twice. A task that runs away in its fresh window must still be
// stopped at that window's end, and asked once.

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const question = (at: string) => ({ id: "q1", createdAt: at, body: `${QUESTION_HEADING}\n\nAt once, or after 30 days?` });

test("a question answered after the window would have expired continues without a budget question", async () => {
  const answeredAt = ago(1);
  const started: string[] = [];
  const { posted } = await scenario({
    // Two hours of wall time from four hours ago, and more than the $25 already spent.
    state: { startedAt: ago(240), runIds: ["run_w"], turnCostUsd: 5 },
    conversation: { agentComments: [question(ago(180))], humanComments: [human("c1", answeredAt, "After 30 days.")] },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async (id) => (id === "run_w" ? worker("succeeded", 30) : { ...worker("running"), runId: id }),
      cancel: async () => {},
    },
    reasoner: async () => turnOf([start]),
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(posted).toEqual([]);
  expect(started).toHaveLength(1);
  const { budget, recentTurns } = await saved();
  expect(recentTurns.at(-1)?.outcomes).toEqual([expect.stringMatching(/^start_worker: done/)]);
  expect(budget.since).toBe(answeredAt);
  expect(budget.priorRuns).toEqual(["run_w"]);
});

test("a runaway task still stops at its fresh window's end and asks once", async () => {
  const answeredAt = ago(240);
  let w = worker("running");
  let cancels = 0;
  let turns = 0;
  let polls = 0;
  let seen: string[] = [];
  const { result, posted } = await scenario({
    // The answer opened a fresh window four hours ago, and the worker started in it is still running.
    state: { startedAt: ago(300), runIds: ["run_w"], budget: { window: { wallMinutes: 120, costUsd: 25 }, since: answeredAt } },
    conversation: { agentComments: [question(ago(270))], humanComments: [human("c1", answeredAt, "After 30 days.")] },
    runner: {
      start: async () => {},
      status: async () => w,
      cancel: async () => void (cancels++, (w = worker("canceled"))),
    },
    reasoner: async () => (turns++, turnOf([start])),
    onPoll: async (poll, live) => {
      polls = poll;
      seen = live.agentComments.map((c) => c.id);
      if (poll >= 10) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(result.outcome).toBe("stopped");
  expect(polls).toBe(10);
  expect(cancels).toBe(1);
  expect(turns).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  // The old answer opened nothing more, and the question is the fresh window's own.
  expect((await saved()).budget.since).toBe(answeredAt);
  expect(seen).toEqual(["q1", commentIdFor(budgetQuestionKey(issue.id, answeredAt))]);
});

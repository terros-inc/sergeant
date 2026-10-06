import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, conversationRevision, type RunRecord } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, head, human, issue, repo, scenario, turnOf } from "./budget-scenario.ts";

// TECH-5259: a run with no usable report is retried at once only when no human said anything since
// the last turn. The reply to a budget question opens a fresh window and must wake a turn that reads
// it (poll-checks.ts); a retry on the old focus started first would act before anyone read it.

afterEach(cleanup);

test("a report-less review and a human's reply to the budget question: a turn reads the reply, no retry starts first", async () => {
  const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const asked = new Date(Date.now() - 60_000).toISOString();
  const question = { id: commentIdFor(budgetQuestionKey(issue.id, startedAt)), createdAt: asked, body: "**Question for you** ... Continue?" };
  const reply = human("c1", new Date(Date.parse(asked) + 1_000).toISOString(), "Extend, and look at the retry first.");
  const malformed: RunRecord = { runId: "run_r1", role: "reviewer", status: "succeeded", provider: "p", model: "m", report: null, reportProblem: "malformed", reportError: "✖ Invalid input → at verdict" };
  const started: string[] = [];
  const turns: { comments: string[]; startedBefore: number }[] = [];

  const { result } = await scenario({
    // The turn that started the review saw the conversation before the question and its reply.
    state: {
      startedAt,
      lastTurnAt: startedAt,
      runIds: ["run_r1"],
      seen: { revision: conversationRevision({ issue, humanComments: [], agentComments: [] }), issue: "unused" },
      starts: { run_r1: { kind: "start_reviewer", subject: [{ repo, number: 7, headSha: head }], focus: "Check the retry." } },
    },
    conversation: { agentComments: [question], humanComments: [reply] },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => malformed, cancel: async () => {} },
    reasoner: async (situation) => {
      turns.push({ comments: situation.conversation.humanComments.map((c) => c.id), startedBefore: started.length });
      return turnOf([]);
    },
    onPoll: (_poll, live) => live,
  });

  expect(result.outcome).toBe("idle");
  // One turn, which read the reply, and nothing was started before it or after.
  expect(turns).toEqual([{ comments: ["c1"], startedBefore: 0 }]);
  expect(started).toEqual([]);
  const lines = (await readFile(join(dir, "report-recoveries.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([
    expect.objectContaining({ runId: "run_r1", problem: "malformed", recovery: "none", reason: "the conversation changed since the last turn, so reasoning reads it first and decides" }),
  ]);
});

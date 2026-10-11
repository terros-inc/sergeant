import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING, type Conversation } from "@terros/sergeant-contracts";
import { createLinearPort } from "@terros/sergeant-linear";
import { answeredBudgetQuestion, budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, issue, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5803: a task waiting on a Linear blocker kept its budget window running while it waited. The
// window ran out with nothing to do, and when the blocker was done nothing reopened it, so the task
// stayed held by an exhausted budget until a human commented. Its last blocker going (completed,
// canceled, or the relation removed: the Linear adapter reads all three as no open blocker,
// linear.test.ts) now opens a fresh window, as a human's answer does.

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const blocked = (live: Conversation, blockedBy: string[]): Conversation => ({ ...live, issue: { ...live.issue, blockedBy } });
// Started four hours ago with a two-hour window, and its $25 already spent: exhausted both ways, and
// the window's budget question asked and unanswered.
const startedAt = ago(240);
const budgetAsked = { id: commentIdFor(budgetQuestionKey(issue.id, startedAt)), createdAt: ago(120), body: `${QUESTION_HEADING}\n\nSergeant stopped this task: its budget is exhausted.` };

async function exhaustedWhileBlocked(blockersAt: (poll: number) => string[] | Promise<string[]>) {
  const started: string[] = [];
  let turns = 0;
  const run = await scenario({
    state: { startedAt, runIds: ["run_w"], lastFingerprint: "before" },
    conversation: { agentComments: [budgetAsked] },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async (id) => (id === "run_w" ? worker("succeeded", 30) : { ...worker("running"), runId: id }),
      cancel: async () => {},
    },
    reasoner: async () => (turns++, turnOf([start])),
    onPoll: async (poll, live) => {
      if (poll >= 5 || started.length > 0) await writeFile(join(dir, "STOP"), "");
      return blocked(live, await blockersAt(poll));
    },
  });
  return { ...run, started, turns };
}

test("an exhausted task whose last blocker goes resumes in a fresh window, with no human comment", async () => {
  const { posted, started, turns } = await exhaustedWhileBlocked((poll) => (poll < 3 ? ["UNF-2"] : []));

  // Held by the exhausted budget while blocked; the unblock alone wakes a turn that starts work.
  expect(posted).toEqual([]);
  expect(turns).toBe(1);
  expect(started).toHaveLength(1);
  const state = (await saved()) as Awaited<ReturnType<typeof saved>> & { blockedBy: string[]; unblockedAt: string[] };
  expect(state.blockedBy).toEqual([]);
  expect(state.unblockedAt).toHaveLength(1);
  expect(state.budget.since).toBe(state.unblockedAt[0]);
  expect(state.budget.window).toEqual({ wallMinutes: 120, costUsd: 25 });
  expect(state.budget.priorRuns).toEqual(["run_w"]);
  expect(Date.parse(state.budget.since ?? "")).toBeGreaterThan(Date.parse(startedAt));
});

// The Linear adapter reads an issue's relations 50 at a time; past the first page they once counted as a
// blocker that never went, so an issue with more than 50 could never be unblocked.
test("an exhausted task with more than 50 relations resumes once every real blocker goes", async () => {
  const relation = (type: string, identifier: string, stateType: string) => ({ type, issue: { identifier, state: { type: stateType } } });
  const related = (n: number, from: number) => Array.from({ length: n }, (_, i) => relation("related", `UNF-${from + i}`, "started"));
  let gone = false;
  const pages = () => ({
    first: { nodes: [...related(49, 100), relation("blocks", "UNF-2", gone ? "completed" : "started")], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    c1: {
      nodes: [...related(30, 200), relation("blocks", "UNF-3", gone ? "canceled" : "unstarted"), ...(gone ? [] : [relation("blocks", "UNF-4", "started")])],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.includes("SergeantInverseRelations")) return Response.json({ data: { issue: { inverseRelations: pages().c1 } } });
    const comments = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const fields = { ...issue, state: { name: issue.state, type: issue.stateType }, labels: { nodes: [] }, attachments: { nodes: [] } };
    return Response.json({ data: { issue: { ...fields, inverseRelations: pages().first, comments } } });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });
  const { posted, started, turns } = await exhaustedWhileBlocked(async (poll) => {
    gone = poll >= 3;
    return (await linear.readConversation(issue.identifier)).issue.blockedBy ?? [];
  });
  expect(posted).toEqual([]);
  expect(turns).toBe(1);
  expect(started).toHaveLength(1);
  const state = (await saved()) as Awaited<ReturnType<typeof saved>> & { unblockedAt: string[] };
  expect(state.unblockedAt).toHaveLength(1);
  expect(state.budget.since).toBe(state.unblockedAt[0]);
});

test("one blocker of two going, or a task never seen blocked, opens no window", async () => {
  const { turns } = await exhaustedWhileBlocked((poll) => (poll < 3 ? ["UNF-2", "UNF-3"] : ["UNF-3"]));
  expect(turns).toBe(0);
  expect((await saved()).budget.since).toBeUndefined();
  await cleanup();

  const never = await exhaustedWhileBlocked(() => []);
  expect(never.turns).toBe(0);
  expect((await saved()).budget.since).toBeUndefined();
});

// A budget question asked in an unblock's window is keyed by that window's start, which no human comment
// or review gives, so it is known from the unblocks the task recorded: a reply to it can accept the work.
test("a reply to a budget question asked in an unblock's window is a reply to the budget question", () => {
  const unblockedAt = ago(150);
  const asked = { id: commentIdFor(budgetQuestionKey(issue.id, unblockedAt)), createdAt: ago(30), body: `${QUESTION_HEADING}\n\nContinue?` };
  const replyAt = ago(1);
  const conversation: Conversation = { issue, agentComments: [asked], humanComments: [human("c1", replyAt, "Accept it as it is.")] };
  // The reply has opened a window of its own by the time a turn reads it.
  expect(answeredBudgetQuestion(conversation, { taskStart: startedAt, windowStart: replyAt, unblockedAt: [unblockedAt] }, [])).toBe(true);
  expect(answeredBudgetQuestion(conversation, { taskStart: startedAt, windowStart: replyAt }, [])).toBe(false);
});

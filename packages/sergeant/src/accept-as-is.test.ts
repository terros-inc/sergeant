import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING, type AgentComment, type HumanComment, type ProposedAction } from "@terros/sergeant-contracts";
import { acceptedKey } from "./accepted.ts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, pr, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5118: "accept as-is" in reply to the budget question ends the task. Before, the reply opened a
// fresh window like any answer, reasoning proposed nothing, and once that window ran out the task asked
// the budget question again: TECH-4978 was answered "stop" three times and asked a fourth. Any other
// reply to it still opens a fresh window and the work goes on (TECH-5059). TECH-5120: the accepted
// ending says so in one keyed comment, so the human knows Sergeant has stopped and the rest is theirs.

afterEach(cleanup);

const acknowledged = `Sergeant has stopped: the work was accepted as it is. [${pr.repo}#${pr.number}](${pr.url}) and this issue are yours to merge or close.`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const accept: ProposedAction = { kind: "accept_as_is" };
const budgetAsked: AgentComment = {
  id: commentIdFor(budgetQuestionKey("i1", undefined)),
  createdAt: ago(60),
  body: `${QUESTION_HEADING}\n\nSergeant stopped this task: its budget is exhausted (wall time exhausted). Continue?`,
};
// A task whose first window ran out: two hours of wall time from four hours ago, and $30 spent.
const exhausted = { startedAt: ago(240), runIds: ["run_w"], turnCostUsd: 0 };
const runner = (started: string[]) => ({
  start: async (spec: { runId: string }) => void started.push(spec.runId),
  status: async (id: string) => (id === "run_w" ? worker("succeeded", 30) : { ...worker("running"), runId: id }),
  cancel: async () => {},
});

const clarify: AgentComment = { id: "q2", createdAt: ago(30), parentId: budgetAsked.id, body: `${QUESTION_HEADING}\n\nStop here, or continue?` };
test.each<[string, AgentComment[], HumanComment[]]>([
  ["the accept-as-is option", [budgetAsked], [human("c1", ago(1), "2")]],
  ["a clarifying question in the budget question's thread", [budgetAsked, clarify], [human("c1", ago(45), "hmm"), human("c2", ago(1), "Stop here.")]],
])("accepting the work as it is in reply to %s ends the task, asking nothing again", async (_case, agentComments, humanComments) => {
  const started: string[] = [];
  let turns = 0;
  const { result, posted } = await scenario({
    state: exhausted,
    conversation: { agentComments, humanComments },
    runner: runner(started),
    reasoner: async () => (turns++, turnOf([accept, start])),
    onPoll: async (poll, live) => {
      // A loop that went on would ask the budget question again once this window ran out.
      if (poll >= 5) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(result).toEqual({ outcome: "accepted", detail: "a human accepted the work as it is" });
  expect(turns).toBe(1);
  expect(started).toEqual([]);
  expect(posted).toEqual([acknowledged]);
  // Set aside like a stopped task's, so intake resumes it no more.
  const files = await readdir(dir);
  expect(files).not.toContain("state.json");
  expect(files.some((f) => /^state\.accepted-.+\.json$/.test(f))).toBe(true);
});

test.each([
  ["extend", "1"],
  ["steer", "Just fix the failing lint check, then stop."],
])("an %s reply to the budget question still opens a fresh window and the work goes on", async (_case, reply) => {
  const answeredAt = ago(1);
  const started: string[] = [];
  const { result, posted } = await scenario({
    state: exhausted,
    conversation: { agentComments: [budgetAsked], humanComments: [human("c1", answeredAt, reply)] },
    runner: runner(started),
    reasoner: async () => turnOf([start]),
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(result.outcome).toBe("stopped");
  expect(started).toHaveLength(1);
  expect(posted).toEqual([]);
  expect((await saved()).budget.since).toBe(answeredAt);
});

test("a reply posted while the accepting turn reasoned denies the accept, and gets its fresh window", async () => {
  const answeredAt = ago(2);
  const steer = human("c2", ago(1), "Actually, just fix the failing lint check, then stop.");
  const started: string[] = [];
  const turns: number[] = [];
  const { result, posted } = await scenario({
    state: exhausted,
    conversation: { agentComments: [budgetAsked], humanComments: [human("c1", answeredAt, "2")] },
    runner: runner(started),
    // The first turn read only "2" and accepts; the steer lands before its live check. The next turn reads it.
    reasoner: async (situation) => (turns.push(situation.conversation.humanComments.length), turnOf(turns.length === 1 ? [accept] : [start])),
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      return turns.length > 0 && live.humanComments.length === 1 ? { ...live, humanComments: [...live.humanComments, steer] } : live;
    },
  });

  expect(result.outcome).toBe("stopped");
  expect(turns).toEqual([1, 2]);
  expect(started).toHaveLength(1);
  expect(posted).toEqual([]);
  const { budget, recentTurns } = await saved();
  expect(budget.since).toBe(answeredAt);
  expect(recentTurns.at(-2)?.outcomes).toEqual([expect.stringMatching(/^accept_as_is: denied by Q2 \(the conversation changed since/)]);
  expect(await readdir(dir)).not.toContain("accepted.json");
});

test("accept_as_is after an answer to any other question is refused, and the task goes on", async () => {
  const answeredAt = ago(1);
  const question = { id: "q1", createdAt: ago(60), body: `${QUESTION_HEADING}\n\nShip it as it is, or add the migration?` };
  const { result } = await scenario({
    state: exhausted,
    conversation: { agentComments: [question], humanComments: [human("c1", answeredAt, "As it is.")] },
    runner: runner([]),
    reasoner: async () => turnOf([accept]),
    onPoll: (_poll, live) => live,
  });

  // The loop goes on until nothing changes (an idle guard of 0 minutes here), not ended as accepted.
  expect(result.outcome).toBe("idle");
  const { budget, recentTurns } = await saved();
  expect(budget.since).toBe(answeredAt);
  expect(recentTurns.at(-1)?.outcomes).toEqual(["accept_as_is: denied by Q2 (no human has replied to Sergeant's budget question)"]);
});

test("a turn retried after its acknowledgment reached Linear posts no second one", async () => {
  const reply = human("c1", ago(1), "2");
  const keys: string[] = [];
  // Linear takes the comment but the response is lost: the loop fails before setting the task aside.
  const failed = await scenario({
    state: exhausted,
    conversation: { agentComments: [budgetAsked], humanComments: [reply] },
    runner: runner([]),
    reasoner: async () => turnOf([accept]),
    onPoll: (_poll, live) => live,
    beforePost: ({ key }) => {
      keys.push(key);
      throw new Error("socket hang up");
    },
  }).catch((e: Error) => e);
  expect(failed).toBeInstanceOf(Error);
  expect(await readdir(dir)).toContain("state.json");

  // The next intake resumes the task; the turn it committed no fingerprint for is taken again.
  const delivered = { id: commentIdFor(acceptedKey("i1", reply.id)), createdAt: ago(0.5), body: acknowledged };
  const { result, live } = await scenario({
    conversation: { agentComments: [budgetAsked, delivered], humanComments: [reply] },
    runner: runner([]),
    reasoner: async () => turnOf([accept]),
    onPoll: (_poll, live) => live,
    beforePost: ({ key }) => void keys.push(key),
  });

  expect(result.outcome).toBe("accepted");
  expect(keys).toEqual([acceptedKey("i1", reply.id), acceptedKey("i1", reply.id)]);
  expect(live.agentComments.filter((c) => c.body === acknowledged)).toHaveLength(1);
});

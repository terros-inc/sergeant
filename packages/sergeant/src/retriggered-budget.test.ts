import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING, type AgentComment, type Conversation } from "@terros/sergeant-contracts";
import { acceptedKey } from "./accepted.ts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, pr, scenario, turnOf, worker } from "./budget-scenario.ts";

// TECH-5145: the first window's budget question was keyed `0` for every task. A re-triggered task that
// ran out of its first window then asked under the earlier task's key, Linear deduplicated it, and the
// task found the earlier, answered question: it neither waited nor could go on (B1), and no human was
// asked. Its first window's question is now keyed by its own start.

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const acknowledged = `Sergeant has stopped: the work was accepted as it is. [${pr.repo}#${pr.number}](${pr.url}) and this issue are yours to merge or close.`;

// The earlier task asked its budget question ten hours ago and was accepted as it is; the human then
// re-triggered it. The fresh task started four hours ago and spent $30 of its first window.
const startedAt = ago(240);
const oldReply = human("c-old", ago(590), "2");
const earlierTask = (key: string): AgentComment[] => [
  { id: commentIdFor(key), createdAt: ago(600), body: `${QUESTION_HEADING}\n\nSergeant stopped this task: its budget is exhausted. Continue?` },
  { id: commentIdFor(acceptedKey("i1", oldReply.id)), createdAt: ago(589), body: acknowledged },
];

test.each([
  ["before TECH-5145, under the shared key", "budget-question:i1:0"],
  ["under the earlier task's own key", budgetQuestionKey("i1", ago(720))],
])("a re-triggered task asks its own budget question and waits for a reply to it (earlier question asked %s)", async (_case, earlierKey) => {
  const ownQuestion = commentIdFor(budgetQuestionKey("i1", startedAt));
  let turns = 0;
  let turnsBeforeReply = -1;
  let pollsWaited = 0;
  const { result, posted, live } = await scenario({
    state: { startedAt, runIds: ["run_w"], turnCostUsd: 0 },
    conversation: { agentComments: earlierTask(earlierKey), humanComments: [oldReply] },
    runner: { start: async () => {}, status: async () => worker("succeeded", 30), cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([{ kind: "accept_as_is" }])),
    onPoll: (_poll, live): Conversation => {
      const asked = live.agentComments.find((c) => c.id === ownQuestion);
      // The human replies only after the loop has waited on the question for a few polls.
      if (!asked || live.humanComments.length > 1 || ++pollsWaited < 5) return live;
      turnsBeforeReply = turns;
      const at = new Date(Date.parse(asked.createdAt) + 1_000).toISOString();
      return { ...live, humanComments: [...live.humanComments, human("c-new", at, "2")] };
    },
  });

  // Posted as a comment of its own, and nothing happened until the human replied to it.
  expect(posted[0]).toMatch(/budget is exhausted/);
  expect(turnsBeforeReply).toBe(0);
  // The reply to this task's question is what accepts, and the acknowledgment is this task's own.
  expect(result).toEqual({ outcome: "accepted", detail: "a human accepted the work as it is" });
  expect(turns).toBe(1);
  expect(posted).toEqual([expect.stringMatching(/budget is exhausted/), acknowledged]);
  expect(live.agentComments.map((c) => c.id)).toEqual([
    commentIdFor(earlierKey),
    commentIdFor(acceptedKey("i1", oldReply.id)),
    ownQuestion,
    commentIdFor(acceptedKey("i1", "c-new")),
  ]);
});

test("a first-window question posted under the old shared key since the task started is still found and not asked twice", async () => {
  // A task running when TECH-5145 deployed had already asked under `0`; its restarted loop must wait on that.
  const asked = { id: commentIdFor("budget-question:i1:0"), createdAt: ago(60), body: `${QUESTION_HEADING}\n\nContinue?` };
  let turns = 0;
  const { posted } = await scenario({
    state: { startedAt, runIds: ["run_w"], turnCostUsd: 0 },
    conversation: { agentComments: [asked] },
    runner: { start: async () => {}, status: async () => worker("succeeded", 30), cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([])),
    onPoll: async (poll, live) => {
      if (poll >= 5) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(posted).toEqual([]);
  expect(turns).toBe(0);
});

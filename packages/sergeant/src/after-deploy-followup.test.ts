import { expect, test } from "vitest";
import { conversationRevision, type Conversation, type CreateFollowup, type ProposedAction } from "@terros/sergeant-contracts";
import { conversation, ports, pr, situation } from "./execute-fixtures.ts";
import { takeTurn } from "./index.ts";
import { outcomeComment } from "./outcome.ts";

// TECH-6146: a done-when item only production can prove ("after deploy, no new errors") used to make
// Sergeant ask a human whether to split it off, and the answer was always yes. Now reasoning files one
// ordinary keyed follow-up per such check in the turn that starts the worker on the rest, and the
// outcome lists each as not verified. Nothing new in code but that outcome line: create_followup's
// key is what keeps a re-run from filing a second issue.

const issue: Conversation = {
  ...conversation,
  issue: {
    ...conversation.issue,
    description: [
      "Reject empty input.",
      "",
      "**Done when:**",
      "* The parser rejects empty input, covered by a test.",
      "* After deploy, no new errors in the error tracker.",
      "",
      "**After deploy (not for workers):** Owner: the on-call engineer.",
      "* The dashboard's p95 latency stays flat for a day.",
    ].join("\n"),
  },
};
const live = { ...situation, conversation: issue, conversationRevision: conversationRevision(issue), runs: [], pullRequests: [] };

const check = (key: string, title: string): CreateFollowup => ({
  kind: "create_followup",
  key,
  title,
  category: "required_unfinished_work",
  why: "Only production can prove it, and no worker has production access.",
  description: `Check after deploy: ${title}`,
  relation: "related",
});
const errors = check("after-deploy-no-new-errors", "After deploy, no new errors in the error tracker");
const latency = check("after-deploy-p95-latency", "The dashboard's p95 latency stays flat for a day");
const start: ProposedAction = {
  kind: "start_worker",
  objective: "Make the parser reject empty input, with a test. Not verified (after deploy), and not your scope: no new errors after deploy; p95 latency.",
  repositories: [pr.repo],
};

test("each after-deploy check becomes one related follow-up in the turn that starts the worker, and a re-run files none again", async () => {
  const { p, filed, started } = ports({ conversation: issue });
  const reasoner = { turn: async () => ({ output: { summary: "s", actions: [errors, latency, start] }, model: "m", promptVersion: "p" }) };
  const { outcomes } = await takeTurn(live, { ...p, reasoner });

  // The production-only done-when item and the check already in the After-deploy section each get one
  // follow-up; the worker-provable item gets none and stays worker scope, and the worker starts in the same turn.
  expect(outcomes.map((o) => o.status)).toEqual(["done", "done", "done"]);
  expect(filed.map((f) => [f.key, f.relation])).toEqual([
    ["followup:tsk_1:after-deploy-no-new-errors", "related"],
    ["followup:tsk_1:after-deploy-p95-latency", "related"],
  ]);
  expect(started).toHaveLength(1);

  // A later turn, or a restarted loop that kept its follow-ups, proposes the same keys: nothing new is filed.
  const followups = outcomes.flatMap((o) => (o.status === "done" && o.followup ? [o.followup] : []));
  const again = await takeTurn({ ...live, followups }, { ...p, reasoner: { turn: async () => ({ output: { summary: "s", actions: [errors, latency] }, model: "m", promptVersion: "p" }) } });
  expect(again.outcomes).toMatchObject([{ status: "done", result: { alreadyFiled: true } }, { status: "done", result: { alreadyFiled: true } }]);
  expect(filed).toHaveLength(2);
});

test("the outcome lists each after-deploy check as not verified (after deploy), apart from other follow-ups", () => {
  const filed = [
    { key: "after-deploy-no-new-errors", title: "After deploy, no new errors in the error tracker", identifier: "UNF-101", url: "https://linear.app/x/issue/UNF-101" },
    { key: "retry-jitter", title: "Add jitter to retries", identifier: "UNF-102", url: "https://linear.app/x/issue/UNF-102" },
  ];
  const lines = outcomeComment({ ...pr, state: "merged" }, "c".repeat(40), situation.runs, filed, issue.issue).split("\n");
  expect(lines).toContain("- Not verified (after deploy): After deploy, no new errors in the error tracker, follow-up [UNF-101](https://linear.app/x/issue/UNF-101).");
  expect(lines).toContain("- Follow-ups filed: [UNF-102](https://linear.app/x/issue/UNF-102) Add jitter to retries.");
});

import { expect, test } from "vitest";
import { conversationRevision, type Conversation, type SituationReport } from "@terros/sergeant-contracts";
import { claudeCliReasoner } from "./reasoner.ts";

// Model output is untrusted. If a malformed or invented action got past this boundary, the
// executor could perform an effect nobody defined, or merge without naming the exact head.

const conversation: Conversation = {
  issue: {
    id: "i1",
    identifier: "UNF-1",
    url: "https://linear.app/x/issue/UNF-1",
    title: "T",
    description: "D",
    state: "Todo",
    delegate: null,
    linkedPullRequests: [],
  },
  humanComments: [],
  agentComments: [],
};
const situation: SituationReport = {
  taskId: "tsk_1",
  generatedAt: "2026-10-02T06:00:00.000Z",
  conversationRevision: conversationRevision(conversation),
  conversation,
  enrolledRepositories: ["trevorallred/canary"],
  pullRequests: [],
  runs: [],
  followups: [],
  budget: { window: { wallMinutes: 120, costUsd: 25 }, wallDeadline: "2999-01-01T00:00:00.000Z", spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 0, grants: [] },
  recentTurns: [],
};

const answering = (structured_output: unknown) =>
  claudeCliReasoner({ runCli: async () => JSON.stringify({ is_error: false, structured_output, total_cost_usd: 0.1 }) });

test("rejects model output that invents an action or merges without an exact head", async () => {
  const shell = { summary: "s", actions: [{ kind: "run_shell", command: "git push --force" }] };
  const noHead = { summary: "s", actions: [{ kind: "merge_pr", repo: "trevorallred/canary", number: 7, reviewStanding: { kind: "reviewed", reviewRunId: "run_r" } }] };
  const shortHead = { summary: "s", actions: [{ kind: "merge_pr", repo: "trevorallred/canary", number: 7, expectedHeadSha: "abc1234", reviewStanding: { kind: "reviewed", reviewRunId: "run_r" } }] };
  for (const out of [shell, noHead, shortHead, { actions: [] }]) {
    await expect(answering(out).turn(situation)).rejects.toThrow();
  }
  const ok = await answering({ summary: "Start the worker.", actions: [{ kind: "start_worker", objective: "Do UNF-1.", repositories: ["trevorallred/canary"] }] }).turn(situation);
  expect(ok.output.actions[0]?.kind).toBe("start_worker");
});

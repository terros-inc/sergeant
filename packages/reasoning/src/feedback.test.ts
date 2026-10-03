import { expect, test } from "vitest";
import type { FeedbackCase } from "@terros/sergeant-contracts";
import { claudeCliFeedbackJudge } from "./feedback.ts";

// The judgment decides whether Sergeant files an issue, so model output that claims a change without
// saying what it is must be refused rather than filed as an empty issue.

const input: FeedbackCase = {
  origin: {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Done", delegate: null, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  },
  mergedPullRequests: [],
  feedback: { key: "linear:c1", source: "linear_comment", author: "Ada", createdAt: "2026-10-02T08:00:00.000Z", body: "Cap retries at 5.", url: "https://linear.app/x/issue/UNF-1" },
  filed: [],
};
const answering = (structured_output: unknown) =>
  claudeCliFeedbackJudge({ runCli: async () => JSON.stringify({ is_error: false, structured_output, total_cost_usd: 0.01 }) });

test("accepts a judgment only with a reason, or a title and a delta", async () => {
  for (const out of [{ actionable: true, title: "Cap retries" }, { actionable: false }, { actionable: "yes", title: "t", delta: "d" }]) {
    await expect(answering(out).judge(input)).rejects.toThrow();
  }
  expect((await answering({ actionable: false, reason: "thanks" }).judge(input)).judgment).toEqual({ actionable: false, reason: "thanks" });
  expect((await answering({ actionable: true, title: "Cap retries", delta: "Cap at 5." }).judge(input)).costUsd).toBe(0.01);
});

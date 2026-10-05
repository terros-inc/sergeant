import { expect, test } from "vitest";
import { checkClose } from "./gate.ts";
import type { CloseIssue } from "./actions.ts";
import type { Conversation } from "./conversation.ts";
import type { RunRecord, WorkerReport } from "./runs.ts";

// TECH-5232: Sergeant closes an issue itself only when its own verification found nothing to change.
// Closing is terminal and seen by every human watching the issue, so each refusal below is a way a
// close could land on work that is not Sergeant's, has a PR in flight, or was never verified.

const rev = "1".repeat(64);
const issue: Conversation["issue"] = {
  id: "i1",
  identifier: "UNF-1",
  url: "https://linear.app/x/issue/UNF-1",
  title: "T",
  description: "D",
  state: "In Progress",
  stateType: "started",
  delegate: { id: "agent-v2", name: "Sergeant" },
  linkedPullRequests: [],
};
const verified = (over: Partial<RunRecord> = {}, pullRequests: WorkerReport["pullRequests"] = []) =>
  ({
    runId: "run_w",
    role: "worker",
    status: "succeeded",
    provider: "p",
    model: "m",
    report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "Already on main as abc1234.", pullRequests, knownGaps: [], followups: [] },
    ...over,
  }) as RunRecord;
const close: CloseIssue = { kind: "close_issue", state: "done", evidence: "Covered on main by abc1234 (src/retry.ts, retry.test.ts)." };
const facts = (over: Partial<Parameters<typeof checkClose>[1]> = {}) => ({ issue, agentUserId: "agent-v2", runs: [verified()], turnRevision: rev, liveRevision: rev, ...over });

test("a delegated issue with no PR, evidence, and a finished worker's verification may be closed, as Done or Canceled", () => {
  expect(checkClose(close, facts())).toEqual({ allowed: true });
  expect(checkClose({ ...close, state: "canceled", evidence: "Superseded by UNF-9." }, facts())).toEqual({ allowed: true });
});

const reportedPr = { repo: "o/canary", number: 7, headSha: "a".repeat(40), url: "https://github.com/o/canary/pull/7", closesIssue: true, review: { required: true, reason: "r" } };
test.each<[string, string, CloseIssue, ReturnType<typeof facts>]>([
  ["not delegated to Sergeant", "A1", close, facts({ issue: { ...issue, delegate: { id: "agent-v1", name: "Sergeant V1" } } })],
  ["already in a stop state", "A2", close, facts({ issue: { ...issue, state: "Backlog", stateType: "backlog" } })],
  ["a PR linked to the issue, even a human's", "C1", close, facts({ issue: { ...issue, linkedPullRequests: [{ repo: "o/canary", number: 7 }] } })],
  ["a PR a run reported, even one Linear does not link", "C1", close, facts({ runs: [verified({}, [reportedPr])] })],
  ["blank evidence", "C2", { ...close, evidence: "  \n" }, facts()],
  ["a run still going", "C3", close, facts({ runs: [verified(), verified({ runId: "run_r", role: "reviewer", status: "running", report: null })] })],
  ["no worker finished with a report", "C3", close, facts({ runs: [verified({ status: "failed", report: null })] })],
  ["the conversation changed since the turn", "C4", close, facts({ liveRevision: "2".repeat(64) })],
])("refused with %s", (_case, rule, action, f) => {
  expect(checkClose(action, f)).toMatchObject({ allowed: false, rule });
});

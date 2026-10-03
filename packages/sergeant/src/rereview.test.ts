import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type HumanPullRequestFeedback, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-4992: once a successor addressed the captain's requested changes, the new head was reviewed and
// green, yet the task sat blocked by M8 and nobody told the captain. Sergeant must ask on the issue once
// per head, never again on later polls or turns, and again when a newer head reaches the same point.

const [first, second, third] = ["a", "b", "c"].map((c) => c.repeat(40)) as [string, string, string];
const repo = "o/sales";
const url = `https://github.com/${repo}/pull/7`;
const at = "2026-10-03T02:00:00.000Z";
const prAt = (head: string): PullRequestFacts => ({
  repo, number: 7, url, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: head, mergedSha: null, baseRef: "main", body: "Fixes UNF-1", mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [captain],
});
const captain: HumanPullRequestFeedback = {
  id: "review:5", kind: "review", author: "captain", state: "CHANGES_REQUESTED", body: "Remove references to terros-wiki.", path: null, line: null, commitId: first, createdAt: at, updatedAt: at, url: `${url}#pullrequestreview-5`,
};
const approval = (runId: string, headSha: string): RunRecord => ({
  runId, role: "reviewer", status: "succeeded", provider: "p", model: "m",
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha }], verdict: "approve", findings: [], summary: "" },
});
const records = [approval("run_review_2", second), approval("run_review_3", third)];

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("asks the human who requested changes to re-review once per addressed, reviewed, green head", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-rereview-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: records.map((r) => r.runId), recentTurns: [] }));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr: PullRequestFacts = { ...prAt(second), checks: { sha: second, required: [{ name: "validate", state: "pending" }] } };
  const posted: { key: string; body: string; checks: string[] }[] = [];
  let turns = 0;

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, maxTurns: 3, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => structuredClone(live),
        // Linear then lists the comment under the id derived from its key, as the real adapter does.
        postComment: async ({ key, body }) => {
          posted.push({ key, body, checks: livePr.checks.required.map((c) => c.state) });
          live.agentComments.push({ id: commentIdFor(key), createdAt: new Date().toISOString(), body });
        },
        createFollowupIssue: async () => { throw new Error("unused"); },
        moveIssueToStarted: async () => ({ moved: false as const }),
      },
      github: { readPullRequest: async () => livePr, closePullRequest: async () => {}, mergePullRequest: async () => { throw new Error("unused"); } },
      runner: { start: async () => {}, status: async (id) => records.find((r) => r.runId === id) ?? Promise.reject(new Error("unknown")), cancel: async () => {} },
      reasoner: {
        async turn() {
          turns += 1;
          // 1: CI goes green on the reviewed head. 2: a human comments on the issue, waking another turn
          // at the same head. 3: a successor pushes a newer head, reviewed and green.
          if (turns === 1) livePr = prAt(second);
          if (turns === 2) live.humanComments.push({ id: "c1", author: { id: "u1", name: "Trevor" }, createdAt: at, updatedAt: at, body: "Any news?" });
          if (turns === 3) livePr = prAt(third);
          return { output: { summary: "waiting on the captain", actions: [] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("turn_limit");
  expect(posted.map((p) => p.key)).toEqual([`rereview:i1:${repo}#7:${second}`, `rereview:i1:${repo}#7:${third}`]);
  // Not while the first head's checks were still pending, before the first turn.
  expect(posted.map((p) => p.checks)).toEqual([["passed"], ["passed"]]);
  expect(posted[0]?.body).toContain("@captain");
  expect(posted[0]?.body).toContain(`[${repo}#7](${url})`);
  expect(posted[0]?.body).toContain("re-review it, or dismiss your review");
});

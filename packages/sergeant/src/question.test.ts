import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  commentIdFor,
  type Conversation,
  type MergePr,
  type ProposedAction,
  type PullRequestFacts,
  type RunRecord,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { takeTurn } from "./index.ts";
import { runLoop } from "./loop.ts";

// UNF-727: a human decision must never be silently abandoned or overtaken. Once Sergeant asks, the
// question is posted exactly once (even across a restart that lost local state), nothing happens on
// the task while it waits, and a human reply wakes a turn that sees both the question and the reply.

const head = "a".repeat(40);
const repo = "o/canary";
const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
const review: RunRecord = {
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
};
const worker: RunRecord = {
  runId: "run_worker",
  role: "worker",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
    knownGaps: [],
    followups: [],
  },
};
const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
const ask: ProposedAction = { kind: "ask_human", question: "Purge deleted accounts' data at once, or after 30 days?", options: ["At once", "After 30 days"] };
const reply = { id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "2, but make it configurable." };
const agent = { id: "agent-v2", name: "Sergeant" };

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a question is posted once, holds every effect until a human replies, and survives a restart", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-question-test-"));
  const stateFile = join(dir, "state.json");
  const beforeAsking = JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] });
  await writeFile(stateFile, beforeAsking);

  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const posted: { key: string; body: string }[] = [];
  const merged: unknown[] = [];
  const seen: SituationReport[] = [];
  // Each poll that finds the question already on the issue; `onWait` acts as the human or operator.
  let waits = 0;
  let onWait = async (_n: number) => {};

  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        async moveIssueToStarted() { return { moved: false as const }; },
        async readConversation() {
          if (live.agentComments.length > 0 && live.humanComments.length === 0) await onWait(++waits);
          return live;
        },
        // Like Linear: one comment per client id, however often it is posted.
        async postComment({ key, body }) {
          posted.push({ key, body });
          const id = commentIdFor(key);
          if (!live.agentComments.some((c) => c.id === id)) {
            live = { ...live, agentComments: [...live.agentComments, { id, createdAt: "2026-10-02T06:00:30.000Z", body }] };
          }
        },
        createFollowupIssue: async () => { throw new Error("unused"); },
      },
      github: {
        readPullRequest: async () => pr,
        mergePullRequest: async (req) => {
          merged.push(req);
          live = { ...live, issue: { ...live.issue, state: "Done" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          // A turn that asks and merges in one breath must not merge before the human answers.
          const actions = situation.conversation.humanComments.length === 0 ? [ask, merge] : [merge];
          return { output: { summary: "s", actions }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  // While waiting, the loop takes no turn and does not end on its idle guard; the operator stops it.
  onWait = async (n) => void (n === 3 && (await writeFile(join(dir, "STOP"), "")));
  expect((await run()).outcome).toBe("stopped");
  expect(seen).toHaveLength(1);
  expect(merged).toEqual([]);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.body).toMatch(/^\*\*Question for you\*\*\n\nPurge .*\n\nOptions:\n1\. At once\n2\. After 30 days\n/);
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as { recentTurns: { outcomes: string[] }[] };
  expect(saved.recentTurns[0]?.outcomes[1]).toMatch(/^merge_pr .*denied by Q1/);

  // Restart as if the process died before saving that turn: the wait comes from Linear alone, so
  // nothing is asked again. Then a human replies, and a turn that sees the question and the reply
  // resumes the task.
  await writeFile(stateFile, beforeAsking);
  await rm(join(dir, "STOP"));
  onWait = async (n) => void (n === 5 && (live = { ...live, humanComments: [reply] }));
  expect((await run()).outcome).toBe("done");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.conversation.humanComments).toEqual([reply]);
  expect(seen[1]?.conversation.agentComments[0]?.body).toContain("Purge deleted accounts' data");
  expect(merged).toHaveLength(1);
  expect(posted.filter((p) => p.key.startsWith("question:"))).toHaveLength(1);
});

const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] };
const start: ProposedAction = { kind: "start_worker", objective: "o", repositories: [repo] };
const followup: ProposedAction = { kind: "create_followup", key: "k", title: "T", description: "D", relation: "related" };

test("a turn that asks does nothing else, whatever order reasoning proposed", async () => {
  for (const actions of [[start, ask], [merge, ask], [followup, ask]]) {
    const effects: string[] = [];
    const situation: SituationReport = {
      taskId: "t",
      generatedAt: "2026-10-02T06:00:00.000Z",
      conversationRevision: "r",
      conversation: { issue, humanComments: [], agentComments: [] },
      enrolledRepositories: [repo],
      pullRequests: [pr],
      runs: [review],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, wallDeadline: "2999-01-01T00:00:00.000Z", spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 0, grants: [] },
      recentTurns: [],
      followups: [],
      uploads: [],
      refusedMerges: [],
    };
    const { outcomes } = await takeTurn(situation, {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => situation.conversation,
      moveIssueToStarted: async () => ({ moved: false as const }),
        postComment: async () => void effects.push("ask"),
        createFollowupIssue: async () => (effects.push("followup"), { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" }),
      },
      github: { readPullRequest: async () => pr, mergePullRequest: async () => (effects.push("merge"), { mergedSha: head }) },
      runner: { start: async () => void effects.push("start"), status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: { turn: async () => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p" }) },
    });
    expect(effects).toEqual(["ask"]);
    expect(outcomes.map((o) => o.status)).toEqual(["denied", "done"]);
  }
});

test("a question whose post failed or went unconfirmed is posted again until Linear shows it", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-question-test-"));
  let live: Conversation = { issue, humanComments: [], agentComments: [] };
  const merged: unknown[] = [];
  let turns = 0;
  let attempts = 0;
  let waits = 0;

  const outcome = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        async moveIssueToStarted() { return { moved: false as const }; },
        async readConversation() {
          if (live.agentComments.length > 0 && ++waits === 2) await writeFile(join(dir, "STOP"), "");
          return live;
        },
        // First Linear refuses the write outright; then it creates the comment but the reply is lost.
        async postComment({ key, body }) {
          attempts += 1;
          if (attempts === 1) throw new Error("Linear unavailable");
          live = { ...live, agentComments: [{ id: commentIdFor(key), createdAt: "2026-10-02T06:00:30.000Z", body }] };
          throw new Error("connection reset");
        },
        createFollowupIssue: async () => { throw new Error("unused"); },
      },
      github: { readPullRequest: async () => pr, mergePullRequest: async (req) => (merged.push(req), { mergedSha: head }) },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: { turn: async () => (turns++, { output: { summary: "s", actions: [ask, merge] }, model: "m", promptVersion: "p" }) },
    },
  );

  // Neither failure let the merge through or ended the wait on the idle guard; the operator stopped it.
  expect(outcome.outcome).toBe("stopped");
  expect(turns).toBe(1);
  expect(attempts).toBe(2);
  expect(merged).toEqual([]);
  expect(live.agentComments).toHaveLength(1);
});

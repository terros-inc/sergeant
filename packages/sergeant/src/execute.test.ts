import { expect, test } from "vitest";
import {
  conversationRevision,
  type Conversation,
  type GitHubPort,
  type MergePr,
  type ProposedAction,
  type PullRequestFacts,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { execute, type Ports } from "./execute.ts";
import { takeTurn } from "./index.ts";

// The Gate is only protective if the executor feeds it live facts. If the executor checked the
// turn's own snapshot instead, M4 and M10 would always pass and a merge could overtake a pushed
// head or a new human comment. This proves an allowed merge reaches the effect seam and a live
// change stops it there.

const head = "a".repeat(40);
const conversation: Conversation = {
  issue: {
    id: "i1",
    identifier: "UNF-1",
    url: "https://linear.app/x/issue/UNF-1",
    title: "T",
    description: "D",
    state: "In Progress",
    delegate: { id: "agent-v2", name: "Sergeant" },
    linkedPullRequests: [{ repo: "trevorallred/canary", number: 7 }],
  },
  humanComments: [],
  agentComments: [],
};
const pr: PullRequestFacts = {
  repo: "trevorallred/canary",
  number: 7,
  url: "https://github.com/trevorallred/canary/pull/7",
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "ci", state: "passed" }] },
  humanFeedback: [],
};
const situation: SituationReport = {
  taskId: "tsk_1",
  generatedAt: "2026-10-02T06:00:00.000Z",
  conversationRevision: conversationRevision(conversation),
  conversation,
  enrolledRepositories: [pr.repo],
  pullRequests: [pr],
  runs: [
    {
      runId: "run_review",
      role: "reviewer",
      status: "succeeded",
      provider: "anthropic",
      model: "m",
      report: { reportVersion: "s2-review-report/1", reviewed: [{ repo: pr.repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
    },
    {
      runId: "run_worker",
      role: "worker",
      status: "succeeded",
      provider: "anthropic",
      model: "m",
      report: {
        reportVersion: "s2-worker-report/1",
        outcome: "completed",
        summary: "",
        pullRequests: [{ repo: pr.repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
        knownGaps: [],
        followups: [],
      },
    },
  ],
  followups: [],
  refusedMerges: [],
  budget: { window: { wallMinutes: 120, costUsd: 25 }, wallDeadline: "2999-01-01T00:00:00.000Z", spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 0, grants: [] },
  recentTurns: [],
};
const merge: MergePr = { kind: "merge_pr", repo: pr.repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };

function ports(live: { pr?: Partial<PullRequestFacts>; conversation?: Conversation; moveFails?: boolean } = {}) {
  const merged: Parameters<GitHubPort["mergePullRequest"]>[0][] = [];
  const started: string[] = [];
  const sent: string[] = [];
  const moved: string[] = [];
  const filed: Parameters<Ports["linear"]["createFollowupIssue"]>[0][] = [];
  const p: Ports = {
    linear: {
      readConversation: async () => live.conversation ?? conversation,
      moveIssueToStarted: async (id) => {
        moved.push(id);
        if (live.moveFails) throw new Error("Linear unavailable");
        return { moved: true as const, from: "Todo", to: "In Progress" };
      },
      postComment: async () => {},
      createFollowupIssue: async (req) => {
        filed.push(req);
        return { identifier: `UNF-${100 + filed.length}`, url: `https://linear.app/x/issue/UNF-${100 + filed.length}` };
      },
    },
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    github: {
      readPullRequest: async () => ({ ...pr, ...live.pr }),
      mergePullRequest: async (req) => (merged.push(req), { mergedSha: "c".repeat(40) }),
    },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async () => { throw new Error("unused"); },
      cancel: async () => {},
      send: async (runId) => void sent.push(runId),
    },
  };
  return { p, merged, started, sent, moved, filed };
}

test("an exact-head reviewed merge reaches GitHub with the expected head", async () => {
  const { p, merged } = ports();
  expect(await execute(merge, situation, p)).toMatchObject({ status: "done" });
  expect(merged).toMatchObject([{ repo: pr.repo, number: 7, expectedHeadSha: head }]);
});

test("a head pushed or a human comment added after the turn's snapshot stops the merge", async () => {
  const pushed = ports({ pr: { headSha: "b".repeat(40) } });
  expect(await execute(merge, situation, pushed.p)).toMatchObject({ status: "denied", rule: "M4" });

  const stop = { id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Stop, don't merge yet." };
  const commented = ports({ conversation: { ...conversation, humanComments: [stop] } });
  expect(await execute(merge, situation, commented.p)).toMatchObject({ status: "denied", rule: "M10" });

  expect([...pushed.merged, ...commented.merged]).toEqual([]);
});

const followup = (key: string): ProposedAction => ({ kind: "create_followup", key, title: `Do ${key}`, description: `Why ${key}.`, relation: "related" });

test("an issue reassigned or undelegated after the turn's snapshot gets no new start and no merge", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  for (const delegate of [{ id: "agent-v1", name: "Sergeant V1" }, null]) {
    const { p, merged, started, filed } = ports({ conversation: { ...conversation, issue: { ...conversation.issue, delegate } } });
    expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect(await execute(start, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect(await execute(followup("a"), situation, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect([...merged, ...started, ...filed]).toEqual([]);
  }
});

test("a green, reviewed PR in an enrolled repo that Linear does not link to this issue is neither reviewed nor merged", async () => {
  // The turn's snapshot lists #7, but live Linear links only #8: a stale snapshot or a reasoning turn
  // that names an unrelated PR must not get it reviewed or merged.
  const live = { ...conversation, issue: { ...conversation.issue, linkedPullRequests: [{ repo: pr.repo, number: 8 }] } };
  const { p, merged, started } = ports({ conversation: live });
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "G3" });
  expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "M2" });
  expect([...merged, ...started]).toEqual([]);
});

test("a green, reviewed PR linked to this issue but not opened by Sergeant's worker App is neither reviewed nor merged", async () => {
  // Linear's GitHub integration links any PR whose branch, title, or body names the issue, so the
  // link alone is PR-controlled text. A human-opened PR for the task is not Sergeant's to merge either.
  const { p, merged, started } = ports({ pr: { author: "someone" } });
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "G3" });
  expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "M2" });
  expect([...merged, ...started]).toEqual([]);
});

const stop ={ id: "c9", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:02:00.000Z", updatedAt: "2026-10-02T06:02:00.000Z", body: "Stop, do not merge." };

test("a snapshot pairing the old conversation with the live revision cannot merge", async () => {
  // Reasoning saw no comment, but the supplied revision already describes the live "stop" comment.
  const live = { ...conversation, humanComments: [stop] };
  const incoherent = { ...situation, conversationRevision: conversationRevision(live) };
  const { p, merged } = ports({ conversation: live });
  expect(await execute(merge, incoherent, p)).toMatchObject({ status: "denied", rule: "M10" });
  expect(merged).toEqual([]);
});

test("two start_worker proposals in one turn start exactly one worker", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  const reasoner = { turn: async () => ({ output: { summary: "s", actions: [start, start] }, model: "m", promptVersion: "p" }) };
  const { p, started } = ports();
  const { outcomes } = await takeTurn({ ...situation, runs: [] }, { ...p, reasoner });
  expect(started).toHaveLength(1);
  expect(outcomes[1]).toMatchObject({ status: "denied", rule: "R4" });
});

// TECH-4947: a started worker makes the issue visibly In Progress, best effort. The move runs after
// the start is a done fact, only for a worker, and a failed status write never fails or blocks the start.
test("start_worker moves the issue to In Progress, and a failed move still leaves the start done", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  const ok = ports();
  expect(await execute(start, { ...situation, runs: [] }, ok.p)).toMatchObject({ status: "done" });
  expect([ok.started.length, ok.moved]).toEqual([1, ["i1"]]);

  const failing = ports({ moveFails: true });
  expect(await execute(start, { ...situation, runs: [] }, failing.p)).toMatchObject({ status: "done" });
  expect([failing.started.length, failing.moved]).toEqual([1, ["i1"]]);

  // A reviewer start never moves the issue: In Progress belongs to the worker starting.
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  const rv = ports();
  expect(await execute(review, { ...situation, runs: [] }, rv.p)).toMatchObject({ status: "done" });
  expect([rv.started.length, rv.moved]).toEqual([1, []]);
});

test("send_run to a run outside this task is refused before the runner", async () => {
  const { p, sent } = ports();
  const send = { kind: "send_run", runId: "run_foreign", message: "change course" } as const;
  expect(await execute(send, situation, p)).toMatchObject({ status: "denied", rule: "S1" });
  expect(sent).toEqual([]);
});

// UNF-729: a non-blocking finding becomes at most one follow-up issue. A key reasoning repeats, in the
// same turn or a later one, files nothing new, and a confused turn cannot flood Linear (F1).
test("a repeated follow-up key files one issue, and the per-task limit stops the rest", async () => {
  const actions = [followup("a"), followup("a"), followup("b"), followup("c"), followup("d")];
  const reasoner = { turn: async () => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p" }) };
  const { p, filed } = ports();
  const { outcomes } = await takeTurn(situation, { ...p, reasoner });
  expect(filed.map((f) => f.key)).toEqual(["followup:tsk_1:a", "followup:tsk_1:b", "followup:tsk_1:c"]);
  expect(filed[0]).toMatchObject({ originIssueId: "i1", relation: "related", description: expect.stringContaining(conversation.issue.url) });
  expect(outcomes.map((o) => o.status)).toEqual(["done", "done", "done", "done", "denied"]);
  expect(outcomes[1]).toMatchObject({ followup: { key: "a", identifier: "UNF-101" } });
  expect(outcomes[4]).toMatchObject({ rule: "F1" });

  // A later turn shown the filed follow-up gets it back without a second issue.
  const later = await execute(followup("a"), { ...situation, followups: [{ key: "a", title: "Do a", identifier: "UNF-101", url: "https://linear.app/x/issue/UNF-101" }] }, p);
  expect(later).toMatchObject({ status: "done", followup: { identifier: "UNF-101" } });
  expect(filed).toHaveLength(3);
});

// UNF-733: a merge ends the task. A turn that also starts work, before or after the merge, must not
// leave a live run on a merged task, and nothing is filed after the merge.
test("a merge in a turn with a start leaves no live run, and nothing runs after it", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do more.", repositories: [pr.repo] };
  const turnOf = async (actions: ProposedAction[]) => {
    const reasoner = { turn: async () => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p" }) };
    const run = ports();
    return { ...run, outcomes: (await takeTurn(situation, { ...run.p, reasoner })).outcomes };
  };

  const mergeFirst = await turnOf([merge, start, followup("a")]);
  expect(mergeFirst.merged).toHaveLength(1);
  expect([...mergeFirst.started, ...mergeFirst.filed]).toEqual([]);
  expect(mergeFirst.outcomes.slice(1)).toMatchObject([{ status: "denied", rule: "M11" }, { status: "denied", rule: "M11" }]);

  const startFirst = await turnOf([start, merge]);
  expect(startFirst.started).toHaveLength(1);
  expect(startFirst.merged).toEqual([]);
  expect(startFirst.outcomes[1]).toMatchObject({ status: "denied", rule: "M11" });

  const followupFirst = await turnOf([followup("a"), merge]);
  expect(followupFirst.outcomes.map((o) => o.status)).toEqual(["done", "done"]);
});

// TECH-4990: the reviewer's brief shows the humans' feedback on its PRs, read live as it starts, so a
// change a human requested after the deciding turn's snapshot still reaches the reviewer.
test("a reviewer starts with the live human feedback on its subject PRs, not the snapshot's", async () => {
  const requested = {
    id: "review:9", kind: "review" as const, author: "ada", state: "CHANGES_REQUESTED" as const, body: "Rename it.",
    path: null, line: null, commitId: head, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", url: `${pr.url}#pullrequestreview-9`,
  };
  const { p } = ports({ pr: { humanFeedback: [requested] } });
  const specs: Parameters<Ports["runner"]["start"]>[0][] = [];
  p.runner.start = async (spec) => void specs.push(spec);
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "done" });
  expect(specs).toMatchObject([{ role: "reviewer", pullRequests: [{ repo: pr.repo, number: 7, humanFeedback: [requested] }] }]);
});

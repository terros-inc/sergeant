import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING, type Conversation, type Finding, type ProposedAction, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { runLoop, type LoopOptions } from "./loop.ts";

// TECH-5227: the turn after a review finishes tells the round on the issue in about five lines: what
// changed, the verdict, what happens next, and the cost so far. A question or the closing merge that
// same turn carries it instead, so the round is still one comment, and no later turn or retry tells it
// again.

const repo = "o/canary";
const head = "a".repeat(40);
const agent = { id: "agent-v2", name: "Sergeant" };
const owner = { id: "user-ann", name: "Ann" };
const prUrl = `https://github.com/${repo}/pull/7`;
const open: PullRequestFacts = {
  repo, number: 7, url: prUrl, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: head, mergedSha: null, baseRef: "main",
  body: "Fixes UNF-1", mergeable: true, checks: { sha: head, required: [{ name: "validate", state: "passed" }] }, humanFeedback: [],
};
const worker: RunRecord = {
  runId: "run_worker", role: "worker", status: "succeeded", provider: "anthropic/claude-code", model: "m", costUsd: 1.5,
  account: { id: "person:user-ann:claudeWork", group: "registered", holder: "Ann <ann@example.com>" },
  report: {
    reportVersion: "s2-worker-report/1", outcome: "completed", knownGaps: [], followups: [],
    summary: "Retries failed Linear writes with backoff. Tests cover the retry.",
    pullRequests: [{ repo, number: 7, headSha: head, url: prUrl, closesIssue: true, review: { required: true, reason: "" } }],
  },
};
const reviewed = `Reviewed [${repo}#7](${prUrl}) at \`${head.slice(0, 12)}\``;
const changed = "**Progress:** Retries failed Linear writes with backoff.";
const accounts = "accounts: claudeWork, codexWork";
const soFar = `Cost so far: ~$2.10 estimated, not counting 1 run of unknown cost · 2 runs · 18 min · ${accounts}`;

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A task whose reviewer just finished; every turn proposes `actions`. Each `run()` is one loop. */
async function round(verdict: "approve" | "changes_requested", findings: Finding[], actions: ProposedAction[], options: Partial<LoopOptions> = {}) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-progress-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date(Date.now() - 18 * 60_000).toISOString(), turnCostUsd: 0.6, turns: 1, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  const review: RunRecord = {
    // Codex reports no dollar figure (TECH-5021): its cost is unknown, never $0.
    runId: "run_review", role: "reviewer", status: "succeeded", provider: "openai/codex", model: "m",
    account: { id: "person:user-ann:codexWork", group: "registered", holder: "Ann <ann@example.com>" },
    report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict, findings, summary: "" },
  };
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: owner, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let pr = open;
  const posted: { body: string; key: string }[] = [];
  let abort = new AbortController();
  let turns = 0;
  const run = () => {
    abort = new AbortController();
    return runLoop(
      { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, completionWaitMinutes: 0, signal: abort.signal, log: () => {}, ...options },
      {
        agentUserId: agent.id,
        workerLogin: "sergeant-worker[bot]",
        linear: {
          readConversation: async () => live,
          readTaskOwner: async () => ({ owner }),
          moveIssueToStarted: async () => ({ moved: false as const }),
          createFollowupIssue: async () => { throw new Error("unused"); },
          // Linear keeps one comment per key, as the adapter does.
          postComment: async (c) => {
            posted.push(c);
            const id = commentIdFor(c.key);
            if (!live.agentComments.some((a) => a.id === id)) live.agentComments.push({ id, createdAt: new Date().toISOString(), body: c.body });
          },
        },
        github: {
          readPullRequest: async () => pr,
          closePullRequest: async () => {},
          mergePullRequest: async () => {
            pr = { ...pr, state: "merged", mergedSha: "c".repeat(40) };
            live.issue = { ...live.issue, state: "Done", stateType: "completed" };
            return { mergedSha: "c".repeat(40) };
          },
        },
        runner: {
          start: async () => {},
          status: async (id) => (id === worker.runId ? worker : id === review.runId ? review : { ...worker, runId: id as never, status: "running", report: null }),
          cancel: async () => {},
        },
        reasoner: {
          async turn() {
            turns += 1;
            // Ends the loop once the turn's effects are done, except a merge's, which ends by itself.
            if (!actions.some((a) => a.kind === "merge_pr")) abort.abort();
            return { output: { summary: "s", actions }, model: "m", promptVersion: "p" };
          },
        },
      },
    );
  };
  /** A human comment, so the next loop takes a fresh turn. */
  const reply = () => live.humanComments.push({ id: `h${live.humanComments.length}`, author: { id: "u1", name: "Human" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), body: "ok" });
  return { run, reply, posted, turns: () => turns };
}

test("an approved round gets one short comment, and later turns post nothing more", async () => {
  const { run, reply, posted, turns } = await round("approve", [], []);
  await run();
  expect(posted).toEqual([{ issueId: "i1", key: "progress:i1:run_review", body: [changed, `${reviewed}: approved.`, "Next: merging once the PR is ready.", soFar].join("\n") }]);
  reply();
  await run();
  expect([turns(), posted.length]).toEqual([2, 1]);
});

test("blocking and non-blocking findings are counted, the first two named, and fixing them is next", async () => {
  const findings: Finding[] = [
    { id: "f1", severity: "non_blocking", description: "The retry has no jitter." },
    { id: "f2", severity: "blocking", description: "A 4xx is retried forever.\n```ts\nretry(e)\n```" },
    { id: "f3", severity: "nit", description: "Typo in a comment." },
  ];
  const { run, posted } = await round("changes_requested", findings, [{ kind: "start_worker", objective: "Fix the review's findings.", repositories: [repo] }]);
  await run();
  expect(posted.map((c) => c.body)).toEqual([
    [
      changed,
      `${reviewed}: changes requested: 1 blocking finding and 2 non-blocking findings.`,
      "- Blocking: A 4xx is retried forever.",
      "- Non-blocking: The retry has no jitter. (+1 more)",
      "Next: a worker fixes the findings.",
      soFar,
    ].join("\n"),
  ]);
});

test("a round that ends in a question is told in the question, never twice", async () => {
  const findings: Finding[] = [{ id: "f1", severity: "non_blocking", description: "Should 429s be retried too?" }];
  const ask: ProposedAction = { kind: "ask_human", question: "Retry 429s as well?" };
  const { run, reply, posted } = await round("approve", findings, [ask]);
  await run();
  expect(posted).toHaveLength(1);
  expect(posted[0]?.key).toMatch(/^question:/);
  expect(posted[0]?.body.startsWith(QUESTION_HEADING)).toBe(true);
  expect(posted[0]?.body).toContain(`${changed}\n${reviewed}: approved, with 1 non-blocking finding.\n- Non-blocking: Should 429s be retried too?\n${soFar}`);
  // The human answers and the next turn moves on: the round is not told again on its own.
  reply();
  await run();
  expect(posted.filter((c) => c.key.startsWith("progress:"))).toEqual([]);
});

test("a round that ends in the closing merge is told in the merge's outcome comment, with the task's total cost", async () => {
  const merge: ProposedAction = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
  const { run, posted } = await round("approve", [], [merge]);
  expect((await run()).outcome).toBe("done");
  expect(posted.map((c) => c.key)).toEqual([`outcome:i1:${repo}#7:${"c".repeat(40)}`]);
  expect(posted[0]?.body).toMatch(/^\*\*Merged\*\*/);
  // The total replaces the round's cost so far, so the comment says the cost once.
  const total = `- Cost: ~$2.10 estimated, not counting 1 run of unknown cost (Claude $1.50 · Codex unknown · Sergeant's turns $0.60) · 2 runs (1 worker, 1 review) · 18 min · ${accounts}`;
  expect(posted[0]?.body.endsWith(`\n${total}\n\n${changed}\n${reviewed}: approved.`)).toBe(true);
});

test("progressComments: false posts nothing for the round, and folds nothing into a merge", async () => {
  const off = await round("approve", [], [], { progressComments: false });
  await off.run();
  expect(off.posted).toEqual([]);
  const merge: ProposedAction = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
  const merged = await round("approve", [], [merge], { progressComments: false });
  await merged.run();
  expect(merged.posted[0]?.body).not.toContain("Reviewed");
});

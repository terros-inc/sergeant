import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type Finding, type ProposedAction, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { runLoop, type LoopOptions } from "./loop.ts";

// TECH-5227: every finished review is told on the issue in its own comment of about five lines after
// the next turn: what changed, the verdict, what happens next, and the cost so far. A question or a merge
// that same turn does not replace it, and no later turn tells it again.

const repo = "o/canary";
const head = "a".repeat(40);
const agent = { id: "agent-v2", name: "Sergeant" };
const owner = { id: "user-ann", name: "Ann" };
const prUrl = `https://github.com/${repo}/pull/7`;
const open: PullRequestFacts = {
  repo, number: 7, url: prUrl, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: head, mergedSha: null, baseRef: "main",
  body: "Fixes UNF-1", mergeable: true, mergeableState: "clean", checks: { sha: head, required: [{ name: "validate", state: "passed" }] }, humanFeedback: [],
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
// Sergeant's turns recorded before this one: $0.60, from before a budget window opened.
const soFar = `Cost so far: ~$2.10 estimated, not counting 1 run of unknown cost · 2 runs (1 worker, 1 review) · 18 min · ${accounts}`;

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * A task whose reviewer just finished, with `more` runs after it; every turn proposes `actions`. Each
 * `run()` is one loop. While `linearDown` is set, posting a comment fails.
 */
async function round(verdict: "approve" | "changes_requested", findings: Finding[], actions: ProposedAction[], options: Partial<LoopOptions> = {}, more: RunRecord[] = []) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-progress-test-"));
  const startedAt = new Date(Date.now() - 18 * 60_000).toISOString();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  // The task's first turn cost $0.60, then a human's answer opened a fresh budget window at zero spend
  // (budget.ts): only `turns.jsonl` still has it. Its $5 turn from before the task started is an earlier
  // task's, whose stop left the file behind.
  const budget = { window: { wallMinutes: 120, costUsd: 25 }, since: ago(5), priorRuns: [] };
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt, turnCostUsd: 0, budget, turns: 1, runIds: ["run_worker", "run_review", ...more.map((m) => m.runId)], recentTurns: [] }));
  const turnLine = (at: string, costUsd: number) => `${JSON.stringify({ at, turn: { costUsd } })}\n`;
  await writeFile(join(dir, "turns.jsonl"), turnLine(ago(2 * 24 * 60), 5) + turnLine(ago(10), 0.6));
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
  const linear = { down: false };
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
            if (linear.down) throw new Error("Linear is down");
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
          status: async (id) => [worker, review, ...more].find((r) => r.runId === id) ?? { ...worker, runId: id as never, status: "running", report: null },
          cancel: async () => {},
        },
        reasoner: {
          async turn() {
            turns += 1;
            // Ends the loop once the turn's effects are done, except a merge's, which ends by itself.
            if (!actions.some((a) => a.kind === "merge_pr")) abort.abort();
            return { output: { summary: "s", actions }, model: "m", promptVersion: "p", costUsd: 0.1 };
          },
        },
      },
    );
  };
  /** A human comment, so the next loop takes a fresh turn. */
  const reply = () => live.humanComments.push({ id: `h${live.humanComments.length}`, author: { id: "u1", name: "Human" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), body: "ok" });
  return { run, reply, posted, live, linear, turns: () => turns };
}

test("an approved round gets one short comment, and later turns post nothing more", async () => {
  const { run, reply, posted, turns } = await round("approve", [], []);
  await run();
  expect(posted).toEqual([{ issueId: "i1", key: "progress:i1:run_review", body: [changed, `${reviewed}: approved.`, "Next: merging once the PR is ready.", soFar].join("\n") }]);
  reply();
  await run();
  expect([turns(), posted.length]).toEqual([2, 1]);
});

test("two reviews that finish before the next turn each get a comment; one of an older head gets none", async () => {
  const again = (runId: string, headSha: string, findings: Finding[]): RunRecord => ({
    runId: runId as never, role: "reviewer", status: "succeeded", provider: "anthropic/claude-code", model: "m", costUsd: 0.4,
    account: { id: "person:user-ann:claudeWork", group: "registered", holder: "Ann <ann@example.com>" },
    report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha }], verdict: "approve", findings, summary: "" },
  });
  const more = [again("run_rerun", head, [{ id: "f1", severity: "nit", description: "Typo." }]), again("run_old", "b".repeat(40), [])];
  const { run, posted } = await round("approve", [], [], {}, more);
  await run();
  const cost = `Cost so far: ~$2.90 estimated, not counting 1 run of unknown cost · 4 runs (1 worker, 3 review) · 18 min · ${accounts}`;
  expect(posted).toEqual([
    { issueId: "i1", key: "progress:i1:run_review", body: [changed, `${reviewed}: approved.`, "Next: merging once the PR is ready.", cost].join("\n") },
    {
      issueId: "i1",
      key: "progress:i1:run_rerun",
      body: [changed, `${reviewed}: approved, with 1 non-blocking finding.`, "- Non-blocking: Typo.", "Next: merging once the PR is ready.", cost].join("\n"),
    },
  ]);
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

test("a round whose turn asks a question still gets its own comment, and the question carries no summary", async () => {
  const ask: ProposedAction = { kind: "ask_human", question: "Retry 429s as well?" };
  const { run, reply, posted } = await round("approve", [], [ask]);
  await run();
  expect(posted.map((c) => c.key)).toEqual([expect.stringMatching(/^question:/), "progress:i1:run_review"]);
  expect(posted[0]?.body).not.toContain("Reviewed");
  expect(posted[1]?.body).toBe([changed, `${reviewed}: approved.`, "Next: merging once the PR is ready.", soFar].join("\n"));
  // The human answers and the next turn moves on: the round is not told again.
  reply();
  await run();
  expect(posted.filter((c) => c.key.startsWith("progress:"))).toHaveLength(1);
});

test("a round whose turn makes the closing merge gets its own comment, and the outcome the task's total cost", async () => {
  const merge: ProposedAction = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
  const { run, posted } = await round("approve", [], [merge]);
  expect((await run()).outcome).toBe("done");
  expect(posted.map((c) => c.key)).toEqual(["progress:i1:run_review", `outcome:i1:${repo}#7:${"c".repeat(40)}`]);
  expect(posted[0]?.body).toBe([changed, `${reviewed}: approved.`, "Next: merged; Sergeant posts the outcome and the task's total cost.", soFar].join("\n"));
  // The total counts this turn's $0.10 too.
  const total = `- Cost: ~$2.20 estimated, not counting 1 run of unknown cost (Claude $1.50 · Codex unknown · Sergeant's turns $0.70) · 2 runs (1 worker, 1 review) · 18 min · ${accounts}`;
  expect(posted[1]?.body).toMatch(/^\*\*Merged\*\*/);
  expect(posted[1]?.body.endsWith(`\n${total}`)).toBe(true);
});

test("the task's total counts Sergeant's turns from before a budget window opened", async () => {
  // The round's turn asks; the human's answer opens a fresh window at zero spend; the next turn merges.
  const ask: ProposedAction = { kind: "ask_human", question: "Merge now?" };
  const merge: ProposedAction = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
  const actions: ProposedAction[] = [ask];
  const { run, reply, posted, live } = await round("approve", [], actions);
  await run();
  reply();
  // A second after the question, so it reads as the answer, however fast the test runs.
  const answer = live.humanComments.at(-1);
  if (answer) answer.createdAt = new Date(Date.now() + 1000).toISOString();
  actions.splice(0, 1, merge);
  expect((await run()).outcome).toBe("done");
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { turnCostUsd: number; budget: { since: string } };
  expect(state.turnCostUsd).toBe(0.1);
  // $0.60 from the first window, $0.10 for the question's turn and $0.10 for the merge's.
  const outcome = posted.find((c) => c.key.startsWith("outcome:"))?.body;
  expect(outcome).toContain("- Cost: ~$2.30 estimated, not counting 1 run of unknown cost (Claude $1.50 · Codex unknown · Sergeant's turns $0.80)");
});

test("progressComments: false posts no progress comment", async () => {
  const { run, posted } = await round("approve", [], [], { progressComments: false });
  await run();
  expect(posted).toEqual([]);
});

test("a failed progress post does not fail the turn, and the next turn posts it", async () => {
  const { run, reply, posted, linear, turns } = await round("approve", [], []);
  linear.down = true;
  await run();
  linear.down = false;
  reply();
  await run();
  expect([turns(), posted.map((c) => c.key)]).toEqual([2, ["progress:i1:run_review"]]);
});

import { commentIdFor, type AgentComment, type GitHubPort, type LinearPort, type PullRequestFacts } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { expiredChecksKey, recoverExpiredChecks, RETRIGGER_GRACE_MS } from "./expired-checks.ts";
import type { TaskState } from "./task-state.ts";

// TECH-6489: GitHub expired the workflow runs of approved PRs, their passed required checks vanished,
// and Sergeant read them as not reported yet and waited for days. These cases are the decisions that
// must hold: CI re-triggered on the same head, once; a failed or fruitless re-trigger told to the issue
// once rather than waited out; and a new head whose checks simply have not reported left waiting.

const head = "a".repeat(40);
const repo = "o/canary";
const worker = "sergeant-worker[bot]";
const issueId = "issue-1";

const pr = (state: "passed" | "missing" | "pending", over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  repo, number: 7, url: `https://github.com/${repo}/pull/7`, state: "open", draft: false, author: worker, headSha: head, mergedSha: null,
  baseRef: "main", body: "Fixes UNF-1", changedFiles: [], mergeable: true, mergeableState: "blocked",
  checks: { sha: head, required: [{ name: "validate", state }] }, humanFeedback: [],
  ...over,
});

function harness(opts: { retrigger?: Error; retentionDays?: number } = {}) {
  const state: Pick<TaskState, "passedChecks" | "checkRecoveries"> = { passedChecks: [], checkRecoveries: [] };
  const retriggered: { repo: string; number: number; expectedHeadSha: string }[] = [];
  const posted: { body: string; key: string }[] = [];
  let now = Date.parse("2026-10-01T10:00:00.000Z");
  const github = {
    retriggerChecks: async (req: (typeof retriggered)[number]) => {
      retriggered.push(req);
      if (opts.retrigger) throw opts.retrigger;
    },
    actionsRetentionDays: () => opts.retentionDays ?? 90,
  } as unknown as GitHubPort;
  const linear = { postComment: async (req: { body: string; key: string }) => void posted.push(req) } as unknown as LinearPort;
  const pass = (prs: PullRequestFacts[], agentComments: AgentComment[] = []) =>
    recoverExpiredChecks(prs, state, { github, linear, workerLogin: worker }, { issueId, agentComments, log: () => {}, save: async () => {}, now: () => now });
  return { state, retriggered, posted, pass, advance: (ms: number) => (now += ms) };
}

test("a required check that passed and then went missing on the same head re-runs CI on that head, once", async () => {
  const h = harness();
  expect(await h.pass([pr("passed")])).toBe(0);
  expect(await h.pass([pr("missing")])).toBe(1);
  expect(h.retriggered).toEqual([{ repo, number: 7, expectedHeadSha: head }]);
  expect(h.state.checkRecoveries).toEqual([expect.objectContaining({ headSha: head, checks: ["validate"], outcome: "retriggered", why: expect.stringMatching(/saw it pass on this head/) })]);

  // Still missing within the grace: no second re-trigger, and nothing told yet.
  h.advance(RETRIGGER_GRACE_MS - 1);
  expect(await h.pass([pr("missing")])).toBe(0);
  expect(h.retriggered).toHaveLength(1);
  expect(h.posted).toEqual([]);
  // Back and running: nothing more to do.
  await h.pass([pr("pending")]);
  expect(h.posted).toEqual([]);
});

const DAY_MS = 86_400_000;
const reviewOn = (commitId: string, createdAt: string): NonNullable<PullRequestFacts["botFeedback"]>[number] => ({
  id: "review:1", kind: "review", author: "sergeant-reviewer[bot]", state: "APPROVED", body: "", path: null, line: null, commitId, createdAt, updatedAt: createdAt, url: `https://github.com/${repo}/pull/7#pullrequestreview-1`,
});

test("a head reviewed longer ago than the repository's Actions retention counts as expired with no earlier pass on record", async () => {
  // A task already waiting when Sergeant started recording, or whose state was lost: the review on this
  // head proves how long it has been the head.
  const h = harness({ retentionDays: 7 });
  expect(await h.pass([pr("missing", { botFeedback: [reviewOn(head, "2026-09-20T10:00:00.000Z")] })])).toBe(1);
  expect(h.state.checkRecoveries[0]).toMatchObject({ why: expect.stringMatching(/has been the PR's head for longer than the repository keeps its Actions runs/) });
});

test("a new head with an old commit date waits for its first checks until it has been the head for longer than the retention", async () => {
  // A rebase, cherry-pick or push of an old commit: its commit date is weeks back, but it only just became
  // the head, and the only review is on the previous head. Only how long it has been the head counts.
  const h = harness({ retentionDays: 7 });
  const fresh = (over: Partial<PullRequestFacts> = {}) => pr("missing", { botFeedback: [reviewOn("b".repeat(40), "2026-09-01T10:00:00.000Z")], ...over });
  expect(await h.pass([fresh()])).toBe(0);
  h.advance(7 * DAY_MS);
  expect(await h.pass([fresh()])).toBe(0);
  expect(h.retriggered).toEqual([]);
  // Seen as the head, still missing every check, for longer than the retention: its runs expired.
  h.advance(1);
  expect(await h.pass([fresh()])).toBe(1);
  expect(h.retriggered).toEqual([{ repo, number: 7, expectedHeadSha: head }]);
});

test("a new head whose checks have not reported waits as before, even after its PR's previous head passed", async () => {
  const h = harness();
  await h.pass([pr("passed", { headSha: "b".repeat(40), checks: { sha: "b".repeat(40), required: [{ name: "validate", state: "passed" }] } })]);
  h.advance(RETRIGGER_GRACE_MS * 10);
  expect(await h.pass([pr("missing")])).toBe(0);
  expect(h.retriggered).toEqual([]);
  expect(h.posted).toEqual([]);
  expect(h.state.passedChecks).toEqual([{ repo, number: 7, headSha: head, since: "2026-10-01T12:30:00.000Z", checks: [] }]);
});

test.each<[string, Partial<PullRequestFacts>]>([
  ["a PR the worker App did not open", { author: "someone" }],
  ["a draft", { draft: true }],
  ["a conflicted PR", { mergeableState: "dirty" }],
])("%s is never toggled", async (_, over) => {
  const h = harness();
  await h.pass([pr("passed", over)]);
  expect(await h.pass([pr("missing", over)])).toBe(0);
  expect(h.retriggered).toEqual([]);
});

test("a re-trigger that fails is told to the issue at once, once, and never tried again on that head", async () => {
  const h = harness({ retrigger: new Error("could not convert o/canary#7 to draft: Resource not accessible by integration") });
  await h.pass([pr("passed")]);
  // Told: the caller rereads the issue before a turn, so the turn already sees the human wait.
  expect(await h.pass([pr("missing")])).toBe(1);
  expect(h.posted).toHaveLength(1);
  const [comment] = h.posted;
  expect(comment?.key).toBe(expiredChecksKey(issueId, pr("missing")));
  // What is missing, what Sergeant tried and how it failed, and what a human can do.
  expect(comment?.body).toContain("`validate`");
  expect(comment?.body).toContain("Resource not accessible by integration");
  expect(comment?.body).toContain("convert the PR to draft and back to ready for review");

  const shown = [{ id: commentIdFor(comment?.key ?? ""), createdAt: "2026-10-01T10:00:00.000Z", body: comment?.body ?? "" }];
  expect(await h.pass([pr("missing")], shown)).toBe(0);
  expect(h.retriggered).toHaveLength(1);
  expect(h.posted).toHaveLength(1);
});

test("a re-trigger that does not bring the check back within the grace is told to the issue once", async () => {
  const h = harness();
  await h.pass([pr("passed")]);
  await h.pass([pr("missing")]);
  h.advance(RETRIGGER_GRACE_MS);
  await h.pass([pr("missing")]);
  await h.pass([pr("missing")]);
  expect(h.retriggered).toHaveLength(1);
  expect(h.posted).toHaveLength(1);
  expect(h.posted[0]?.body).toMatch(/re-ran CI on that same head at 2026-10-01T10:00:00.000Z .* but the checks have not come back/);
});

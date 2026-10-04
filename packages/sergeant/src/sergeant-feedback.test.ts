import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { mergedOf, postFeedback } from "./after-merge.ts";
import { driveCancel } from "./cancel.ts";
import type { Ports } from "./execute.ts";
import * as stop from "./stop-fixtures.ts";

// TECH-5186: after the closing merge, a task's meaningful feedback becomes one short Sergeant feedback
// comment and the `sergeant-feedback` label, which TECH-5187's retro reads; a task with nothing worth
// keeping gets neither. A merge no reasoning turn made (a human's), and an issue completed in Linear
// without a recognized closing merge, take only the closing worker's explicit feedback. Delivery is the
// comment and the label: until both succeed the task is not marked posted, and a retry posts no second
// comment.

const repo = "o/canary";
const headSha = "a".repeat(40);
const mergedSha = "b".repeat(40);
const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D" };
const conversation: Conversation = {
  issue: { ...issue, state: "Done", stateType: "completed", delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: [{ repo, number: 7 }] },
  humanComments: [],
  agentComments: [],
};
const pr: PullRequestFacts = {
  repo, number: 7, url: `https://github.com/${repo}/pull/7`, state: "merged", draft: false, author: "sergeant-worker[bot]", headSha, mergedSha,
  baseRef: "main", body: "Fixes UNF-1", mergeable: null, checks: { sha: headSha, required: [] }, humanFeedback: [],
};
const worker = (feedback: string[] | undefined): RunRecord => ({
  runId: "run_worker", role: "worker", status: "succeeded", provider: "p", model: "m",
  report: {
    reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", knownGaps: [], followups: [], feedback,
    pullRequests: [{ repo, number: 7, headSha, url: pr.url, closesIssue: true, review: { required: false, reason: "docs" } }],
  },
});

function linear(addLabel: (issueId: string, name: string) => Promise<void>) {
  const comments: { body: string; key: string }[] = [];
  const deps = { agentUserId: "agent-v2", linear: { readConversation: async () => conversation, postComment: async (c: { body: string; key: string }) => void comments.push(c), addLabel } } as unknown as Ports;
  return { deps, comments };
}
const opts = { issueId: "UNF-1", enrolledRepositories: [repo], dir: "/unused" };

test("a human merge posts the closing worker's feedback once, labeled, at most three lines", async () => {
  const merged = mergedOf(pr, mergedSha, [worker(["CI took 20 minutes to start.", "  The brief\nhad no repo map. ", "Docs drifted.", "A fourth."])], [], issue);
  expect(merged.feedback).toBe("**Sergeant feedback:** CI took 20 minutes to start.\nThe brief had no repo map.\nDocs drifted.");

  const labels: string[] = [];
  const { deps, comments } = linear(async (id, name) => void labels.push(`${id}:${name}`));
  await postFeedback(merged, opts, deps, () => {}, async () => {});
  await postFeedback(merged, opts, deps, () => {}, async () => {});
  expect(comments).toEqual([{ issueId: "i1", body: merged.feedback, key: `feedback:i1:${repo}#7:${mergedSha}` }]);
  expect(labels).toEqual(["i1:sergeant-feedback"]);
});

test("nothing notable posts neither a comment nor a label", () => {
  for (const feedback of [undefined, [], ["Nothing notable."]]) expect(mergedOf(pr, mergedSha, [worker(feedback)], [], issue).feedback).toBeUndefined();
});

test("a label Linear refuses fails delivery, and the retry labels it without a second comment", async () => {
  const merged = mergedOf(pr, mergedSha, [worker(["Flaky CI."])], [], issue);
  const labels: string[] = [];
  let down = true;
  const { deps, comments } = linear(async (_, name) => {
    if (down) throw new Error("forbidden");
    labels.push(name);
  });
  await expect(postFeedback(merged, opts, deps, () => {}, async () => {})).rejects.toThrow("forbidden");
  expect(merged.feedbackPostedAt).toBeUndefined();
  down = false;
  await postFeedback(merged, opts, deps, () => {}, async () => {});
  // The fake records every post; Linear dedupes by key, so the same key twice is one comment.
  expect([new Set(comments.map((c) => c.key)).size, labels, merged.feedbackPostedAt !== undefined]).toEqual([1, ["sergeant-feedback"], true]);
});

test("a Linear port without addLabel fails delivery: no comment, not marked posted, and the stop is kept", async () => {
  const merged = mergedOf(pr, mergedSha, [worker(["Flaky CI."])], [], issue);
  const { deps, comments } = linear(undefined as never);
  await expect(postFeedback(merged, opts, deps, () => {}, async () => {})).rejects.toThrow(/sergeant-feedback/);
  expect([comments, merged.feedbackPostedAt]).toEqual([[], undefined]);

  const stopped = await stopping(stop.issue("completed", "Done"));
  delete stopped.deps.linear.addLabel;
  await expect(driveCancel(dir, "UNF-1", stopped.deps, [stop.repo], () => {})).rejects.toThrow(/sergeant-feedback/);
  expect(await readdir(dir)).toEqual(expect.arrayContaining(["cancel.json", "state.json"]));
});

test("review notes never fill the feedback when no reasoning picked it", () => {
  const notes: RunRecord = {
    runId: "run_r1", role: "reviewer", status: "succeeded", provider: "p", model: "m",
    report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha }], verdict: "approve", summary: "", findings: [{ id: "f1", severity: "non_blocking", description: "The retry has no jitter." }] },
  };
  expect(mergedOf(pr, mergedSha, [worker(undefined), notes], [], issue).feedback).toBeUndefined();
});

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/** UNF-1 stopping with a worker that wrote feedback. */
async function stopping(conversation: Conversation) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-feedback-test-"));
  await writeFile(join(dir, "state.json"), stop.state(["run_w1"]));
  await writeFile(join(dir, "cancel.json"), JSON.stringify({ reason: "the Linear issue was canceled or moved to Done", requestId: "r1", at: new Date().toISOString() }));
  const { deps, seen, wrote } = stop.fakes({ conversation });
  wrote.set("run_w1", { ...worker(["The brief had no repo map."]).report, pullRequests: [] } as never);
  const labels: string[] = [];
  deps.linear.addLabel = async (_, name) => void labels.push(name);
  return { deps, seen, labels };
}

test("an issue completed in Linear without a closing merge gets its feedback and label before the stop finishes", async () => {
  const { deps, seen, labels } = await stopping(stop.issue("completed", "Done"));
  const addLabel = deps.linear.addLabel;
  let down = true;
  deps.linear.addLabel = async (id, name) => (down ? ((down = false), Promise.reject(new Error("Linear is down"))) : addLabel?.(id, name));
  await expect(driveCancel(dir, "UNF-1", deps, [stop.repo], () => {})).rejects.toThrow("Linear is down");
  expect(await readdir(dir)).toEqual(expect.arrayContaining(["cancel.json", "state.json"]));
  await driveCancel(dir, "UNF-1", deps, [stop.repo], () => {});
  expect(seen.comments.map((c) => c.key)).toEqual(["cancel:i1:r1", "feedback:i1:stop:r1"]);
  expect(seen.comments[1]?.body).toBe("**Sergeant feedback:** The brief had no repo map.");
  expect(labels).toEqual(["sergeant-feedback"]);
  expect(await readdir(dir)).not.toContain("cancel.json");
});

test("a stop for Backlog, or for a Done issue no longer Sergeant's, posts no feedback", async () => {
  const undelegated = stop.issue("completed", "Done");
  undelegated.issue.delegate = null;
  for (const conversation of [stop.issue("backlog", "Backlog"), undelegated]) {
    const { deps, seen, labels } = await stopping(conversation);
    await driveCancel(dir, "UNF-1", deps, [stop.repo], () => {});
    expect([seen.comments.map((c) => c.key), labels]).toEqual([["cancel:i1:r1"], []]);
    await rm(dir, { recursive: true, force: true });
  }
});

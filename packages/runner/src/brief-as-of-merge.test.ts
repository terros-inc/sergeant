import { expect, test } from "vitest";
import type { Conversation, PullRequestFacts, PullRequestFeedback, RunSpec } from "@terros/sergeant-contracts";
import { reviewerBrief, type ReviewSubject } from "./brief.ts";

// TECH-6617: an audit of a merged PR judges what was known at its merge. A review or comment made after
// it (a bug report, a revert's reason) would let the auditor "find" a defect only hindsight showed, and
// count it as one nobody raised. A PR outside any Sergeant task may reference no Linear issue at all.

const head = "b".repeat(40);
const base = "c".repeat(40);
const mergedAt = "2026-10-20T12:00:00.000Z";
const subject: ReviewSubject = {
  repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", baseRef: "main", public: true, headSha: head, baseSha: base,
  title: "Speed up the sync", body: "Batches the writes.", path: "/workspace/o/r-pr7", dependencies: { state: "none" },
};
const item = (id: string, at: string, body: string, bot = false): PullRequestFeedback => ({
  id, kind: "comment", author: bot ? "lint-bot[bot]" : "ada", state: null, body, path: null, line: null, commitId: null, createdAt: at, updatedAt: at, url: `${subject.url}#${id}`,
});
const pr: PullRequestFacts = {
  repo: "o/r", number: 7, url: subject.url, state: "merged", draft: false, author: "ada", headSha: head, mergedSha: "d".repeat(40), mergedAt,
  baseRef: "main", body: subject.body, mergeable: null, mergeableState: "unknown", checks: { sha: head, required: [] },
  humanFeedback: [item("comment:1", "2026-10-20T11:00:00Z", "Batch size looks right."), item("comment:2", "2026-10-21T09:00:00Z", "This broke the nightly sync, reverting.")],
  botFeedback: [item("comment:3", "2026-10-20T12:00:00Z", "Lint passed.", true), item("comment:4", "2026-10-22T00:00:00Z", "Revert opened.", true)],
};
const audit: Extract<RunSpec, { role: "reviewer" }> = {
  runId: "run_audit-1", owner: { id: "owner", name: "the audit owner" }, role: "reviewer", repositories: ["o/r"],
  subject: [{ repo: "o/r", number: 7, headSha: head, baseSha: base }], pullRequests: [pr], feedbackCutoff: mergedAt,
};

test("an audit as of merge carries only feedback made by the merge, diffs from the explicit base, and takes the PR as the requirements without an issue", () => {
  const brief = reviewerBrief(audit, [subject], []);

  expect(brief).toContain("Batch size looks right.");
  expect(brief).toContain("Lint passed.");
  expect(brief).not.toContain("broke the nightly sync");
  expect(brief).not.toContain("Revert opened.");
  expect(brief).toContain(`Diff: \`git diff ${base}...HEAD\``);
  expect(brief).toContain("## Task (no Linear issue)");
  expect(brief).toContain("# Sergeant review brief — o/r#7 · run_audit-1");
  expect(brief).toMatch(/19\. Judge this head as of its merge/);
  expect(brief).toMatch(/Never infer a defect from a later rewrite, revert, or rollback/);

  // A referenced issue's comments after the merge are left out the same way.
  const conversation: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Faster sync", description: "Make the sync faster.", state: "Done", stateType: "completed", delegate: null, linkedPullRequests: [] },
    humanComments: [
      { id: "c1", author: { id: "u1", name: "Ada" }, body: "Keep the batch small.", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" },
      { id: "c2", author: { id: "u1", name: "Ada" }, body: "Rolled back after an incident.", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" },
    ],
    agentComments: [],
  } as Conversation;
  const withIssue = reviewerBrief({ ...audit, conversation }, [subject], []);
  expect(withIssue).toContain("Keep the batch small.");
  expect(withIssue).not.toContain("Rolled back after an incident.");

  // An ordinary review is unchanged: every comment, the live base, and no as-of-merge rule.
  const { feedbackCutoff: _, ...live } = audit;
  const ordinary = reviewerBrief({ ...live, conversation, subject: [{ repo: "o/r", number: 7, headSha: head }] }, [{ ...subject, baseSha: undefined }], []);
  expect(ordinary).toContain("broke the nightly sync");
  expect(ordinary).toContain("Diff: `git diff origin/main...HEAD`");
  expect(ordinary).not.toMatch(/19\. Judge this head/);
});

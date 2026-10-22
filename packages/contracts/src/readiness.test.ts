import { describe, expect, test } from "vitest";
import { classifyReadiness, type ReadinessDeclaration, type ReadinessPullRequestFacts, type ReadinessReview } from "./readiness.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const declaredAt = "2026-01-02T12:00:00.000Z";
const later = "2026-01-03T12:00:00.000Z";
const human = { login: "octocat", type: "User" as const };
const bot = { login: "acme-sergeant[bot]", type: "Bot" as const };

const declaration = (sha = A, over: Partial<ReadinessDeclaration> = {}): ReadinessDeclaration => ({
  id: "comment:1",
  body: `READY TO MERGE | SHA: ${sha}\n\nReason: checks and review passed.`,
  author: bot,
  performedViaGitHubAppId: 42,
  sergeantAppId: 42,
  createdAt: declaredAt,
  ...over,
});

const facts = (over: Partial<ReadinessPullRequestFacts> = {}): ReadinessPullRequestFacts => ({
  state: "merged",
  headSha: A,
  mergedAt: later,
  mergedBy: human,
  closedAt: later,
  reviews: [],
  mergedViaMergeQueue: false,
  addedToMergeQueueActor: null,
  ...over,
});

const review = (state: ReadinessReview["state"], over: Partial<ReadinessReview> = {}): ReadinessReview => ({
  author: human,
  state,
  commitId: A,
  submittedAt: "2026-01-03T10:00:00.000Z",
  ...over,
});

describe("classifyReadiness", () => {
  test("covers the worked merge examples, including squash and changed heads", () => {
    // merge_commit_sha is deliberately absent: only GitHub's retained pre-merge head participates.
    expect(classifyReadiness(declaration(), facts())).toEqual({ class: "AGREED", reason: "same_head" });
    expect(classifyReadiness(declaration(A), facts({ headSha: B }))).toEqual({ class: "DIFFERENT_HEAD", reason: "different_head" });
    expect(classifyReadiness(declaration(B), facts({ headSha: B }))).toEqual({ class: "AGREED", reason: "same_head" });
  });

  test("counts only a reviewer's latest undismissed decisive review on the declared head", () => {
    const closed = (reviews: ReadinessReview[]) => facts({ state: "closed", mergedAt: null, mergedBy: null, reviews });
    expect(classifyReadiness(declaration(), closed([review("CHANGES_REQUESTED")]))).toEqual({ class: "REJECTED", reason: "changes_requested" });
    expect(classifyReadiness(declaration(), closed([review("CHANGES_REQUESTED"), review("APPROVED", { submittedAt: "2026-01-03T11:00:00.000Z" })]))).toEqual({ class: "UNKNOWN", reason: "closed_unmerged" });
    expect(classifyReadiness(declaration(), closed([review("DISMISSED")]))).toEqual({ class: "UNKNOWN", reason: "closed_unmerged" });
    expect(classifyReadiness(declaration(), closed([review("CHANGES_REQUESTED", { commitId: B })]))).toEqual({ class: "UNKNOWN", reason: "closed_unmerged" });
    expect(classifyReadiness(declaration(), closed([]))).toEqual({ class: "UNKNOWN", reason: "closed_unmerged" });
  });

  test("leaves open, bot-merged, and temporally invalid outcomes unknown", () => {
    expect(classifyReadiness(declaration(), facts({ state: "open", mergedAt: null, mergedBy: null, closedAt: null }))).toEqual({ class: "UNKNOWN", reason: "pending" });
    expect(classifyReadiness(declaration(), facts({ mergedBy: bot }))).toEqual({ class: "UNKNOWN", reason: "not_human_merge" });
    expect(classifyReadiness(declaration(), facts({ mergedAt: "2026-01-01T12:00:00.000Z" }))).toEqual({ class: "UNKNOWN", reason: "uninterpretable" });
    expect(classifyReadiness(declaration(), facts({ mergedBy: null }))).toEqual({ class: "UNKNOWN", reason: "uninterpretable" });
  });

  test("attributes a merge-queue bot only when a human enqueued the PR", () => {
    expect(classifyReadiness(declaration(), facts({ mergedBy: bot, mergedViaMergeQueue: true, addedToMergeQueueActor: human }))).toEqual({ class: "AGREED", reason: "same_head" });
    expect(classifyReadiness(declaration(), facts({ mergedBy: bot, mergedViaMergeQueue: true, addedToMergeQueueActor: bot }))).toEqual({ class: "UNKNOWN", reason: "uninterpretable" });
  });

  test.each([
    ["another App", { performedViaGitHubAppId: 7 }],
    ["a human account", { author: human, performedViaGitHubAppId: null }],
    ["a malformed first line", { body: `READY TO MERGE | SHA: ${A.slice(1)}\nReason: x` }],
    ["an empty reason", { body: `READY TO MERGE | SHA: ${A}\nReason:   ` }],
  ])("rejects a declaration posted by or containing %s", (_name, over) => {
    expect(classifyReadiness(declaration(A, over), facts())).toEqual({ class: "UNKNOWN", reason: "uninterpretable" });
  });

  test("accepts a full 64-character SHA", () => {
    const sha = "c".repeat(64);
    expect(classifyReadiness(declaration(sha), facts({ headSha: sha }))).toEqual({ class: "AGREED", reason: "same_head" });
  });
});

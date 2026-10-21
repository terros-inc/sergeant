import { expect, test } from "vitest";
import type { GitHubPort, HumanPullRequestFeedback, PullRequestFacts, ReviewTier, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { execute } from "./execute.ts";
import { head, merge, ports, pr, situation } from "./execute-fixtures.ts";
import { handoffComment } from "./handoff.ts";

// TECH-6553: a head's review tier decides whether Sergeant may merge it. These run the real executor
// over a repository's live policy, so a tier that let Sergeant approve or merge a T3 or T4 head, merge
// a T2 head on one review, or merge anything new in a `human` repository fails here.

type HandToHuman = Parameters<NonNullable<GitHubPort["handToHuman"]>>[0];

function setup(policy: "sergeant" | "human" | undefined, tier: ReviewTier, live: Partial<PullRequestFacts> = {}) {
  const { p, merged } = ports({ pr: { reviewTier: { tier, rule: `\`src/a.ts\` matches ${tier} pattern \`src/**\``, humanTeam: "reviewers" }, ...live } });
  const handed: HandToHuman[] = [];
  const { mergePolicy: _, ...github } = p.github;
  p.github = { ...github, ...(policy && { mergePolicy: () => policy }), handToHuman: async (req) => (handed.push(req), { requested: [...req.reviewers, ...(req.teamReviewers ?? [])] }) };
  return { p, merged, handed };
}

const tiers = ["T0", "T1", "T2", "T3", "T4"] as const;

test.each([["human"], ["unset"]] as const)("a %s-policy repository with no opt-in hands every tier to a human, as before, and never merges", async (policy) => {
  for (const tier of tiers) {
    const { p, merged, handed } = setup(policy === "human" ? "human" : undefined, tier);
    const outcome = await execute(merge, situation, p);
    expect([tier, outcome.status, outcome.status === "denied" && outcome.rule, merged]).toEqual([tier, "denied", "H1", []]);
    expect(handed).toHaveLength(1);
    // The handoff names the tier and the review behind it on the PR and on the issue.
    expect(handed[0]?.comment).toContain(`Review tier: **${tier}**`);
    const issueComment = outcome.status === "denied" && outcome.refused ? handoffComment(outcome.refused) : "";
    expect(issueComment).toContain(`Review tier: **${tier}**`);
    expect(issueComment).toContain("a fresh review approved this exact head (reviewer run run_review)");
  }
});

test.each(["T3", "T4"] as const)("a %s head in a sergeant-policy repository is handed to a human, its map's team asked, never approved or merged", async (tier) => {
  const humanFeedback = [approval("maintainer"), approval("second")];
  const { p, merged, handed } = setup("sergeant", tier, { humanFeedback });
  const outcome = await execute(merge, { ...seen({ humanFeedback }), runs: [...situation.runs, secondReview] }, p);
  expect(merged).toEqual([]);
  expect(outcome).toMatchObject({ status: "denied", rule: "H1", reason: `review tier ${tier} requires human review and merge: handed to a human, review requested from reviewers` });
  expect(handed).toMatchObject([{ teamReviewers: ["reviewers"] }]);
  expect(handed[0]?.comment).toContain(`This PR is review tier ${tier}, so it requires human review and human merge whatever the repository's merge policy`);
});

test("a tier a worker raised to T3 on an earlier head still sends the new head to a human", async () => {
  const { p, merged, handed } = setup("sergeant", "T1");
  const raised: RunRecord = { ...worker, runId: "run_earlier", report: { ...worker.report!, pullRequests: [{ ...worker.report!.pullRequests[0]!, headSha: "e".repeat(40), raiseTier: { tier: "T3", reason: "edits an IAM trust policy" } }] } } as RunRecord;
  const outcome = await execute(merge, { ...situation, runs: [raised, ...situation.runs] }, p);
  expect(merged).toEqual([]);
  expect(handed).toHaveLength(1);
  expect(outcome).toMatchObject({ status: "denied", rule: "H1", refused: { human: { tier: { tier: "T3", rule: "raised to T3 by worker run_earlier: edits an IAM trust policy" } } } });
});

test("a T2 head merges on two independent approving reviews or a human approval of it, never on one review alone", async () => {
  const one = setup("sergeant", "T2");
  expect(await execute(merge, situation, one.p)).toMatchObject({ status: "denied", rule: "M16" });
  expect(one.merged).toEqual([]);

  const two = setup("sergeant", "T2");
  expect(await execute(merge, { ...situation, runs: [...situation.runs, secondReview] }, two.p)).toMatchObject({ status: "done" });
  expect(two.merged[0]?.evidence).toBe(
    "Review tier: **T2**, because `src/a.ts` matches T2 pattern `src/**`.\nReviews: a fresh review approved this exact head (reviewer run run_review); a fresh review approved this exact head (reviewer run run_review2).",
  );

  const humanFeedback = [approval("maintainer")];
  const human = setup("sergeant", "T2", { humanFeedback });
  expect(await execute(merge, seen({ humanFeedback }), human.p)).toMatchObject({ status: "done" });
  expect(human.merged[0]?.evidence).toContain("maintainer approved this exact head on GitHub");
});

test("the worker's not_required stands only for a T0 head", async () => {
  const skip = { ...merge, reviewStanding: { kind: "not_required", workerRunId: "run_worker" } } as const;
  const skipped: SituationReport = { ...situation, runs: [{ ...worker, report: { ...worker.report!, pullRequests: [{ ...worker.report!.pullRequests[0]!, review: { required: false, reason: "docs only" } }] } } as RunRecord] };
  const t1 = setup("sergeant", "T1");
  expect(await execute(skip, skipped, t1.p)).toMatchObject({ status: "denied", rule: "M16" });
  const t0 = setup("sergeant", "T0");
  expect(await execute(skip, skipped, t0.p)).toMatchObject({ status: "done" });
  expect([t1.merged.length, t0.merged.length]).toEqual([0, 1]);
});

/** The situation the deciding turn saw, with the same human feedback as the live read (M10). */
const seen = (live: Partial<PullRequestFacts>): SituationReport => ({ ...situation, pullRequests: [{ ...pr, ...live }] });
const worker = situation.runs.find((r) => r.role === "worker") as Extract<RunRecord, { role: "worker" }>;
const secondReview: RunRecord = { ...situation.runs.find((r) => r.role === "reviewer")!, runId: "run_review2", provider: "openai" } as RunRecord;
function approval(author: string): HumanPullRequestFeedback {
  return {
    id: `review:${author}`,
    kind: "review",
    author,
    state: "APPROVED",
    body: "",
    path: null,
    line: null,
    commitId: head,
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    url: `${pr.url}#pullrequestreview-1`,
    association: "MEMBER",
  };
}

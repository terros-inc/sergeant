import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, GitHubPort, PullRequestFacts, SituationReport } from "@terros/sergeant-contracts";
import { execute } from "./execute.ts";
import { conversation, head, merge, ports, pr, situation } from "./execute-fixtures.ts";
import { runLoop } from "./loop.ts";
import { Wake } from "./wake.ts";

// TECH-5244: Sergeant approved and merged a prod change in terros-inc/sales, a repository only humans
// should merge. In a `human` repository (and one with no policy) a head that passes every merge check
// is handed to a human, never approved or merged; once the human merges, the task finishes as usual.

type HandToHuman = Parameters<NonNullable<GitHubPort["handToHuman"]>>[0];
const profile = "https://linear.app/x/profiles/ann";
const withAssignee: Conversation = { ...conversation, issue: { ...conversation.issue, assignee: { id: "user-ann", name: "Ann", url: profile } } };

function humanPorts(policy: GitHubPort["mergePolicy"], live: { pr?: Partial<PullRequestFacts> } = {}) {
  const { p, merged } = ports({ ...live, conversation: withAssignee });
  const handed: HandToHuman[] = [];
  const { mergePolicy: _, ...github } = p.github;
  p.github = { ...github, ...(policy && { mergePolicy: policy }), handToHuman: async (req) => (handed.push(req), { requested: req.reviewers }) };
  p.githubLoginForLinearProfile = (url) => (url === profile ? "ann-gh" : undefined);
  return { p, merged, handed };
}

test.each([
  ["human", () => "human" as const],
  ["unset", undefined],
])("a %s-policy repository's green, approved head is handed to its assignee, never approved or merged", async (_, policy) => {
  const { p, merged, handed } = humanPorts(policy);
  const outcome = await execute(merge, situation, p);
  expect(merged).toEqual([]);
  expect(outcome).toMatchObject({ status: "denied", rule: "H1", refused: { repo: pr.repo, number: 7, headSha: head, human: { requested: ["ann-gh"] } } });
  expect(handed).toMatchObject([{ repo: pr.repo, number: 7, expectedHeadSha: head, reviewers: ["ann-gh"] }]);
  expect(handed[0]?.comment).toContain("merge policy is `human`");
  expect(handed[0]?.comment).toContain("Sergeant's reviewer (run_review) approved this head");
});

test("a head the merge checks refuse is not handed over either, and a draft is handed over only in a human repository", async () => {
  const red = humanPorts(() => "human", { pr: { checks: { sha: head, required: [{ name: "ci", state: "failed" }] } } });
  expect(await execute(merge, situation, red.p)).toMatchObject({ status: "denied", rule: "M5" });
  expect([red.handed, red.merged]).toEqual([[], []]);

  const draft = { pr: { draft: true, mergeableState: "draft" as const } };
  expect(await execute(merge, situation, humanPorts(() => "human", draft).p)).toMatchObject({ status: "denied", rule: "H1" });
  expect(await execute(merge, situation, ports(draft).p)).toMatchObject({ status: "denied", rule: "M7" });
});

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("in a human repository the task hands over once, waits, and finishes when a human merges", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-human-merge-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  let live: Conversation = withAssignee;
  let livePr: PullRequestFacts = pr;
  const handed: HandToHuman[] = [];
  const comments: { body: string; key: string }[] = [];
  const seen: SituationReport[] = [];
  const wake = new Wake();
  const [review, worker] = [situation.runs[0], situation.runs[1]];

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [pr.repo], dir, pollSeconds: 0, waitingGraceMinutes: 0, completionWaitMinutes: 0, wake, progressComments: false, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      githubLoginForLinearProfile: () => "ann-gh",
      linear: {
        readConversation: async () => live,
        postComment: async (c) => void comments.push(c),
        createFollowupIssue: async () => { throw new Error("unused"); },
        readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
        moveIssueToStarted: async () => ({ moved: false as const }),
      },
      github: {
        readPullRequest: async () => livePr,
        closePullRequest: async () => {},
        mergePolicy: () => "human",
        mergePullRequest: async () => { throw new Error("a human repository is never merged by Sergeant"); },
        handToHuman: async (req) => (handed.push(req), { requested: ["terros-inc/owners"] }),
      },
      runner: { start: async () => {}, status: async (id) => (id === worker?.runId ? worker : review!), cancel: async () => {} },
      reasoner: {
        async turn(s) {
          seen.push(s);
          // A wake owes a second turn, which M12 refuses; the human merges during it.
          if (seen.length === 1) wake.request();
          if (seen.length === 2) {
            livePr = { ...livePr, state: "merged", mergedSha: "c".repeat(40) };
            live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          }
          return { output: { summary: "merge", actions: [merge] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("done");
  expect(handed).toHaveLength(1);
  expect(seen[1]?.refusedMerges).toMatchObject([{ headSha: head, human: { requested: ["terros-inc/owners"] } }]);
  expect(seen[1]?.recentTurns.at(-1)?.outcomes[0]).toMatch(/denied by H1/);
  const handoff = comments.find((c) => c.key === `merge-handoff:i1:${pr.repo}#7:${head}`);
  expect(handoff?.body).toContain("merge policy is `human`, so Sergeant did not approve or merge it. Review is requested from terros-inc/owners.");
  expect(handoff?.body).toContain("Sergeant's reviewer (run_review) approved this head");
  expect(comments.map((c) => c.key.split(":")[0])).toEqual(["merge-handoff", "outcome"]);
});

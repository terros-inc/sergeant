import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, FeedbackCase, HumanPullRequestFeedback, PullRequestFacts } from "@terros/sergeant-contracts";
import { agent, pr, repo } from "./budget-scenario.ts";
import { sweepFeedback, type FeedbackDeps } from "./feedback.ts";
import { setAsideCompleted } from "./task-state.ts";

// TECH-5190: an issue whose task merged and was seen through, reopened and delegated again, has its
// `state.json` set aside (TECH-5182). Human feedback on that earlier merge's PRs must still be swept
// into follow-ups as it was before the reopen, however often the issue is reopened, and whatever the
// new episode is doing; while the issue's own comments, and its new PRs, stay the new episode's.

const worker = "sergeant-worker[bot]";
const at = (hour: number) => `2026-10-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
const onPr = (n: number, id: number, hour: number): HumanPullRequestFeedback => ({
  id: `review_comment:${id}`, kind: "review_comment", author: "bob", state: null, body: `Change ${id}.`, path: "a.ts", line: 1,
  commitId: null, createdAt: at(hour), updatedAt: at(hour), url: `https://github.com/${repo}/pull/${n}#discussion_r${id}`, association: "MEMBER",
});
const merged = (n: number, hour: number, humanFeedback: HumanPullRequestFeedback[], body = "Fixes UNF-1"): PullRequestFacts =>
  ({ ...pr, number: n, url: `https://github.com/${repo}/pull/${n}`, body, state: "merged", mergedSha: "b".repeat(40), mergedAt: at(hour), humanFeedback });
const open = (n: number, humanFeedback: HumanPullRequestFeedback[]): PullRequestFacts => ({ ...pr, number: n, url: `https://github.com/${repo}/pull/${n}`, humanFeedback });

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

type World = {
  /** Each earlier episode: when it recorded its merge and when it was seen through, in hours. */
  episodes: { merged: number; completed: number }[];
  prs: PullRequestFacts[];
  comments?: Conversation["humanComments"];
  /** Linear's state type of UNF-1 now; Todo, delegated, unless said otherwise. */
  stateType?: string;
  completedAt?: string;
  delegate?: typeof agent | null;
};

async function world(w: World) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-feedback-reopen-test-"));
  await writeFile(join(dir, "feedback.json"), JSON.stringify({ since: at(0), handled: {} }));
  const task = join(dir, "tasks", "UNF-1");
  await mkdir(task, { recursive: true });
  // Each episode is set aside on its reopen exactly as intake does it.
  for (const e of w.episodes) {
    const done = { repo, number: 7, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at: at(e.merged), completedAt: at(e.completed) };
    await writeFile(join(task, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: at(0), turns: 1, runIds: [], recentTurns: [], merged: done }));
    expect(await setAsideCompleted(task)).toBe(true);
  }
  await writeFile(join(task, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: at(20), turns: 1, runIds: [], recentTurns: [] }));
  const stateType = w.stateType ?? "unstarted";
  const delegate = w.delegate === undefined ? agent : w.delegate;
  const issue: Conversation["issue"] = {
    id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Retry uploads", description: "Retry failed uploads.",
    state: stateType, stateType, delegate, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: w.prs.map((p) => ({ repo, number: p.number })),
  };
  const filed: string[] = [];
  const judged: FeedbackCase[] = [];
  const deps: FeedbackDeps = {
    agentUserId: agent.id,
    workerLogin: worker,
    completedIssues: async () => (stateType === "completed" ? ["UNF-1"] : []),
    openIssues: async () => (stateType !== "completed" && delegate ? ["UNF-1"] : []),
    issueProgress: async () => ({ stateType, completedAt: w.completedAt ?? null }),
    github: { readPullRequest: async (_, n) => w.prs.find((p) => p.number === n) ?? Promise.reject(new Error(`unexpected PR ${n}`)) },
    linear: {
      readConversation: async () => ({ issue, humanComments: w.comments ?? [], agentComments: [] }),
      postComment: async () => {},
      createFollowupIssue: async (req) => (filed.push(req.key), { identifier: `UNF-${filed.length + 1}`, url: `https://linear.app/x/issue/UNF-${filed.length + 1}` }),
    },
    // PR feedback asks for a change; a comment on the issue does not, so filing stays under its limit.
    judge: {
      judge: async (c) => (
        judged.push(c),
        { judgment: c.feedback.source === "linear_comment" ? { actionable: false, reason: "chatter" } : { actionable: true, title: c.feedback.body, delta: "Change it." }, model: "m" }
      ),
    },
  };
  await sweepFeedback({ stateDir: dir, enrolledRepositories: [repo], log: () => {} }, deps);
  return { judged: judged.map((c) => c.feedback.key), filed };
}

const comment = (id: string, hour: number) => ({ id, author: { id: "u1", name: "Ada" }, createdAt: at(hour), updatedAt: at(hour), body: `Comment ${id}.` });

test("feedback on the earlier merge's PR is still filed while the reopened issue's new task is under way", async () => {
  const { judged, filed } = await world({
    episodes: [{ merged: 6, completed: 7 }],
    // Feedback on #7 before its merge was its own task's; after it, post-merge feedback, also after the reopen.
    // #9 is the new task's open PR, and the issue's comment is the new task's conversation.
    prs: [merged(7, 6, [onPr(7, 1, 5), onPr(7, 2, 8), onPr(7, 3, 21)]), open(9, [onPr(9, 4, 21)])],
    comments: [comment("reopen", 21)],
  });
  expect(judged).toEqual([`github:${repo}#7:review_comment:2`, `github:${repo}#7:review_comment:3`]);
  expect(filed).toEqual([`feedback:github:${repo}#7:review_comment:2`, `feedback:github:${repo}#7:review_comment:3`]);
});

test("feedback on the earlier merge's PR is filed after the reopened issue is taken back by a human, delegated to no one", async () => {
  const { judged } = await world({ episodes: [{ merged: 6, completed: 7 }], prs: [merged(7, 6, [onPr(7, 2, 21)])], comments: [comment("mine", 21)], delegate: null });
  expect(judged).toEqual([`github:${repo}#7:review_comment:2`]);
});

test("each of an issue reopened twice keeps its own merge's feedback, and the issue's comments are the latest episode's", async () => {
  const { judged } = await world({
    episodes: [
      { merged: 6, completed: 7 },
      { merged: 12, completed: 13 },
    ],
    prs: [
      merged(7, 6, [onPr(7, 1, 20)]),
      // The second episode's Part of PR: its 10:00 feedback came while that task was under way.
      merged(8, 9, [onPr(8, 2, 10), onPr(8, 3, 14)], "Part of UNF-1"),
      merged(9, 12, [onPr(9, 4, 11), onPr(9, 5, 15)]),
      merged(10, 18, []),
    ],
    // The third episode just landed: its own closing PR merged at 18:00, the issue Done at 18:30.
    stateType: "completed",
    completedAt: "2026-10-02T18:30:00.000Z",
    comments: [comment("third-task", 17), comment("after", 19)],
  });
  expect(judged.sort()).toEqual(
    ["linear:after", `github:${repo}#7:review_comment:1`, `github:${repo}#8:review_comment:3`, `github:${repo}#9:review_comment:5`].sort(),
  );
});

test("a comment on the reopened issue is its new task's, not feedback on the earlier merge, until that task lands", async () => {
  // The new task has opened no PR yet: the earlier closing merge does not make the issue landed.
  const { judged } = await world({ episodes: [{ merged: 6, completed: 7 }], prs: [merged(7, 6, [])], comments: [comment("reopen", 21)] });
  expect(judged).toEqual([]);
});

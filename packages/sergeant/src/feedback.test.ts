import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Conversation, FeedbackCase, FeedbackJudgment, HumanPullRequestFeedback, PullRequestFacts } from "@terros/sergeant-contracts";
import { agent, pr, repo } from "./budget-scenario.ts";
import { FEEDBACK_LIMITS, MAX_FEEDBACK_ATTEMPTS, sweepFeedback, type FeedbackDeps } from "./feedback.ts";

// TECH-4985: feedback that arrives after the completing PR merged, or after the issue is Done, must
// become exactly one ordinary follow-up (never delegated: the adapter files it in Backlog for the
// origin's owner), carrying the delta and links back; never one while the task is still active, for an
// acknowledgement, or a second one when the same feedback is seen again. Nothing may be dropped
// silently: a limit or a repeated failure says so on the issue.

const worker = "sergeant-worker[bot]";
const at = (hour: number) => `2026-10-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
const human = (id: string, hour: number, body: string) => ({ id, author: { id: "u1", name: "Ada" }, createdAt: at(hour), updatedAt: at(hour), body });
const onPr = (id: number, hour: number, body: string, association = "MEMBER"): HumanPullRequestFeedback => ({
  id: `review_comment:${id}`, kind: "review_comment", author: "bob", state: null, body, path: "a.ts", line: 1,
  commitId: null, createdAt: at(hour), updatedAt: at(hour), url: `https://github.com/${repo}/pull/7#discussion_r${id}`, association,
});

let dir = "";
// The lookback counts back from now: the clock is pinned to the evening of the day these hours are on.
beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: new Date(at(23)) }));
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

type World = {
  comments?: Conversation["humanComments"];
  prFeedback?: HumanPullRequestFeedback[];
  /** Linear's state type of UNF-1; Done (completed at 06:01) unless said otherwise. */
  stateType?: string;
  delegate?: typeof agent | null;
  /** PR #7, Sergeant's closing PR: merged at 06:00 unless said otherwise. */
  closing?: Partial<PullRequestFacts>;
  since?: string;
  judge?: FeedbackDeps["judge"]["judge"];
  /** When this host's local task record says UNF-1's closing PR merged; no record unless said. */
  taskMergedAt?: string;
  /** A comment Linear fails to post. */
  commentFails?: (key: string) => boolean;
};

async function world(w: World) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-feedback-test-"));
  await writeFile(join(dir, "feedback.json"), JSON.stringify({ since: w.since ?? at(0), handled: {} }));
  if (w.taskMergedAt) {
    await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
    const merged = { repo, number: 7, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at: w.taskMergedAt };
    await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: at(0), turns: 1, runIds: [], recentTurns: [], merged }));
  }
  const stateType = w.stateType ?? "completed";
  const posted = new Map<string, string>();
  const issue: Conversation["issue"] = {
    id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Retry uploads", description: "Retry failed uploads.",
    state: stateType, stateType, delegate: w.delegate === undefined ? agent : w.delegate, assignee: { id: "user-ann", name: "Ann" },
    linkedPullRequests: [{ repo, number: 7 }, { repo, number: 8 }, { repo: "o/unenrolled", number: 1 }],
  };
  const prs: Record<number, PullRequestFacts> = {
    7: { ...pr, state: "merged", mergedSha: "b".repeat(40), mergedAt: at(6), humanFeedback: w.prFeedback ?? [], ...w.closing },
    // A human's own PR on the issue: not Sergeant's work.
    8: { ...pr, number: 8, url: `https://github.com/${repo}/pull/8`, author: "ada", state: "merged", mergedAt: at(5), humanFeedback: [onPr(99, 9, "Human PR.")] },
  };
  // Linear refuses a second issue under the same client-supplied id: one issue per key.
  const issues = new Map<string, Parameters<FeedbackDeps["linear"]["createFollowupIssue"]>[0]>();
  const judged: FeedbackCase[] = [];
  const identifier = (key: string) => `UNF-${[...issues.keys()].indexOf(key) + 2}`;
  let reads = 0;
  const deps: FeedbackDeps = {
    agentUserId: agent.id,
    workerLogin: worker,
    completedIssues: async () => (stateType === "completed" ? ["UNF-1"] : []),
    openIssues: async () => (stateType !== "completed" && w.delegate !== null ? ["UNF-1"] : []),
    issueProgress: async () => (reads++, { stateType, completedAt: stateType === "completed" ? "2026-10-02T06:01:00.000Z" : null }),
    github: { readPullRequest: async (r, n) => (r === repo && prs[n]) || Promise.reject(new Error(`unexpected PR ${r}#${n}`)) },
    linear: {
      // Sergeant's own comments come back as the issue's agent comments, as on Linear.
      readConversation: async () => ({
        issue,
        humanComments: w.comments ?? [],
        agentComments: [...posted.values()].map((body, i) => ({ id: `a${i}`, createdAt: at(12), body })),
      }),
      postComment: async ({ key, body }) => {
        if (w.commentFails?.(key)) throw new Error("Linear API request failed (503)");
        posted.set(key, body);
      },
      createFollowupIssue: async (req) => {
        if (!issues.has(req.key)) issues.set(req.key, req);
        return { identifier: identifier(req.key), url: `https://linear.app/x/issue/${identifier(req.key)}` };
      },
      findFollowupIssue: async (key) => {
        const issue = issues.get(key);
        return issue && { identifier: identifier(key), url: `https://linear.app/x/issue/${identifier(key)}`, title: issue.title };
      },
    },
    judge: {
      async judge(c) {
        judged.push(c);
        if (w.judge) return w.judge(c);
        const judgment: FeedbackJudgment = /thanks/i.test(c.feedback.body)
          ? { actionable: false, reason: "an acknowledgement" }
          : { actionable: true, title: `Change: ${c.feedback.body}`, delta: "Merged: retries forever. Wanted: cap them. Change: cap at 5." };
        return { judgment, model: "m" };
      },
    },
  };
  const sweep = () => sweepFeedback({ stateDir: dir, enrolledRepositories: [repo], log: () => {} }, deps);
  return { sweep, issues, posted, judged, reads: () => reads };
}

test("actionable feedback after the merge files one ordinary, undelegated follow-up with the delta and links, once", async () => {
  const { sweep, issues, posted, judged } = await world({
    comments: [
      // While the task was open, its own loop handled this; it is not post-merge feedback.
      human("before", 5, "Please also log retries."),
      human("thanks", 7, "Thanks, looks great!"),
      human("cap", 8, "Retries should be capped at 5."),
    ],
    prFeedback: [onPr(1, 5, "Before the merge: the open task's review."), onPr(2, 9, "Name the constant MAX_RETRIES."), onPr(3, 9, "Drive-by.", "NONE")],
  });

  await sweep();
  // Only post-merge feedback from trusted humans on Sergeant's own merged PR and the issue is judged,
  // oldest first; the acknowledgement files nothing.
  expect(judged.map((c) => c.feedback.key)).toEqual(["linear:thanks", "linear:cap", `github:${repo}#7:review_comment:2`]);
  expect([...issues.values()].map((i) => i.title)).toEqual(["Change: Retries should be capped at 5.", "Change: Name the constant MAX_RETRIES."]);
  // The second judgment saw the first follow-up, so it can tell a repeat from a new change.
  expect(judged[2]?.filed).toEqual([expect.stringContaining("[UNF-2](https://linear.app/x/issue/UNF-2)")]);

  const [fromComment, fromReview] = [...issues.values()];
  // No delegate, no state, no assignee from here: the adapter's follow-up rule files it in Backlog for the owner.
  expect(fromComment).toEqual({ originIssueId: "i1", relation: "related", key: "feedback:linear:cap", title: expect.any(String), description: expect.any(String) });
  for (const text of ["Merged: retries forever. Wanted: cap them. Change: cap at 5.", "> Retries should be capped at 5.", "[UNF-1](https://linear.app/x/issue/UNF-1)", `https://github.com/${repo}/pull/7`]) {
    expect(fromComment?.description).toContain(text);
  }
  expect(fromReview?.description).toContain(`[a review comment](https://github.com/${repo}/pull/7#discussion_r2)`);
  expect(fromReview?.description).not.toContain("pull/8");
  expect([...posted.values()][0]).toContain("in Backlog and not delegated; move it to Todo and delegate it to Sergeant");

  // Duplicate delivery: the same feedback seen again is neither judged nor filed again.
  await sweep();
  expect(judged).toHaveLength(3);
  // Even with feedback.json lost, the follow-up's key, and so its Linear id, is the same: no second
  // issue. What was filed is found in Linear and not judged again; the acknowledgement is, and its
  // judgment sees what was filed from Linear itself.
  await writeFile(join(dir, "feedback.json"), JSON.stringify({ since: at(0), handled: {} }));
  await sweep();
  expect(issues.size).toBe(2);
  expect(judged.map((c) => c.feedback.key).slice(3)).toEqual(["linear:thanks"]);
  expect(judged.at(-1)?.filed).toHaveLength(2);
});

test("feedback after the completing PR merged is filed even while the issue is not Done", async () => {
  // merged_not_done, a reopened issue, or an automation landing in a non-completed state.
  const { sweep, issues } = await world({ stateType: "started", comments: [human("cap", 8, "Retries should be capped at 5.")] });
  await sweep();
  expect([...issues.keys()]).toEqual(["feedback:linear:cap"]);
});

test("an open issue whose closing PR merged before the lookback is no longer read or judged; a recent one still is", async () => {
  // TECH-5049: merged long ago and never Done, it was read on every pass for good.
  const comments = [human("cap", 8, "Retries should be capped at 5.")];
  const longAgo = "2026-09-01T06:00:00.000Z";
  const known = await world({ stateType: "started", comments, closing: { mergedAt: longAgo }, taskMergedAt: longAgo });
  await known.sweep();
  expect([known.reads(), known.judged]).toEqual([0, []]);
  await rm(dir, { recursive: true, force: true });

  // Without this host's record of the merge, the issue is read, but its old landing is no longer watched.
  const unknown = await world({ stateType: "started", comments, closing: { mergedAt: longAgo } });
  await unknown.sweep();
  expect([unknown.reads(), unknown.judged]).toEqual([1, []]);
  await rm(dir, { recursive: true, force: true });

  const recent = await world({ stateType: "started", comments, taskMergedAt: at(6) });
  await recent.sweep();
  expect([...recent.issues.keys()]).toEqual(["feedback:linear:cap"]);
});

test("files nothing while the task is still active, for open work a human took back, or from before the first sweep", async () => {
  const comments = [human("cap", 8, "Retries should be capped at 5.")];
  const scenarios: World[] = [
    { stateType: "started", comments, closing: { state: "open", mergedSha: null, mergedAt: null } },
    // A `Part of` PR merged; the task goes on.
    { stateType: "started", comments, closing: { body: "Part of UNF-1" } },
    { stateType: "started", comments, delegate: null },
    { comments, since: at(10) },
  ];
  for (const scenario of scenarios) {
    const w = await world(scenario);
    await w.sweep();
    expect([w.judged, [...w.issues.values()]]).toEqual([[], []]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a limit on follow-ups or judgments says so on the issue instead of dropping feedback silently", async () => {
  const many = Array.from({ length: FEEDBACK_LIMITS.followups + 2 }, (_, i) => human(`c${i}`, 8 + i, `Change number ${i}.`));
  const { sweep, issues, judged, posted } = await world({ comments: many });
  await sweep();
  await sweep();
  expect(issues.size).toBe(FEEDBACK_LIMITS.followups);
  expect(judged).toHaveLength(FEEDBACK_LIMITS.followups);
  expect(posted.get("feedback-limit:i1")).toContain(`starting with Ada's ([a comment](https://linear.app/x/issue/UNF-1))`);

  const chatter = Array.from({ length: FEEDBACK_LIMITS.judgments + 2 }, (_, i) => human(`t${i}`, 7, `Thanks ${i}`));
  const talk = await world({ comments: chatter });
  await talk.sweep();
  expect(talk.judged).toHaveLength(FEEDBACK_LIMITS.judgments);
  expect(talk.posted.has("feedback-limit:i1")).toBe(true);
});

test("a judgment that keeps failing is given up with a comment and does not block later feedback; a corrupt record is set aside", async () => {
  const { sweep, issues, judged, posted } = await world({
    comments: [human("bad", 8, "Garbled."), human("cap", 9, "Retries should be capped at 5.")],
    judge: async (c) => {
      if (c.feedback.body === "Garbled.") throw new Error("malformed model output");
      return { judgment: { actionable: true, title: "Cap retries", delta: "Cap at 5." }, model: "m" };
    },
  });
  for (let i = 0; i < MAX_FEEDBACK_ATTEMPTS + 1; i++) await sweep();
  expect(judged.filter((c) => c.feedback.key === "linear:bad")).toHaveLength(MAX_FEEDBACK_ATTEMPTS);
  expect(posted.get("feedback-failed:linear:bad")).toContain("could not act on Ada's feedback");
  expect([...issues.keys()]).toEqual(["feedback:linear:cap"]);

  await writeFile(join(dir, "feedback.json"), "{ not json");
  await sweep();
  expect((await readdir(dir)).some((f) => f.startsWith("feedback.json.corrupt-"))).toBe(true);
});

test("a follow-up filed before its marker comment failed gets the marker without a second judgment, and counts toward the limit", async () => {
  // TECH-5049: judged again, the feedback could be found not actionable, leaving the follow-up uncounted
  // and unseen by later judgments.
  const comments = [human("c0", 8, "Change number 0.")];
  let outage = true;
  const { sweep, issues, judged, posted } = await world({
    comments,
    commentFails: (key) => outage && key.endsWith(":filed:i1"),
    judge: async (c) => ({
      judgment: judged.length > 1 && c.feedback.key === "linear:c0" ? { actionable: false, reason: "changed its mind" } : { actionable: true, title: c.feedback.body, delta: "Do it." },
      model: "m",
    }),
  });
  await sweep();
  expect([issues.size, posted.size]).toEqual([1, 0]);

  outage = false;
  await sweep();
  expect(judged).toHaveLength(1);
  expect([...posted.values()]).toEqual([expect.stringContaining("[UNF-2](https://linear.app/x/issue/UNF-2) Change number 0.")]);

  comments.push(...Array.from({ length: FEEDBACK_LIMITS.followups }, (_, i) => human(`c${i + 1}`, 9 + i, `Change number ${i + 1}.`)));
  await sweep();
  expect(judged[1]?.filed).toEqual([expect.stringContaining("[UNF-2]")]);
  expect(issues.size).toBe(FEEDBACK_LIMITS.followups);
  expect(posted.get("feedback-limit:i1")).toContain(`${FEEDBACK_LIMITS.followups} follow-ups filed`);
});

test("a follow-up whose marker was posted before a crash cut its record short counts once toward the limit", async () => {
  // Marked on the origin, but the crash came before save(): the next pass finds the follow-up and its
  // marker both. Counted twice, A, B, B reached the limit and stopped C with a public comment.
  const comments = [human("a", 8, "Change A."), human("b", 9, "Change B.")];
  const { sweep, issues, judged, posted } = await world({ comments });
  await sweep();
  const file = join(dir, "feedback.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  delete record.handled["linear:b"];
  await writeFile(file, JSON.stringify(record));

  comments.push(human("c", 10, "Change C."));
  await sweep();
  expect(judged.map((c) => c.feedback.key)).toEqual(["linear:a", "linear:b", "linear:c"]);
  expect(judged[2]?.filed).toEqual([expect.stringContaining("[UNF-2]"), expect.stringContaining("[UNF-3]")]);
  expect(issues.size).toBe(3);
  expect(posted.has("feedback-limit:i1")).toBe(false);
});

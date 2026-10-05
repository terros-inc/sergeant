import { expect, test } from "vitest";
import type { HumanPullRequestFeedback, PullRequestFacts, RunSpec } from "@terros/sergeant-contracts";
import { reviewerBrief, workerBrief } from "./brief.ts";
import { HUMAN_FEEDBACK_BOUND, renderHumanFeedback } from "./brief-common.ts";

// TECH-5022: human PR feedback is bounded in both briefs, so a long review thread cannot crowd out the
// rest of the brief. Under the bound it renders exactly as before; over it, the newest stays whole
// and every cut item says so and links to its full text.

const head = "b".repeat(40);
const pr = (number: number, humanFeedback: HumanPullRequestFeedback[]): PullRequestFacts => ({
  repo: "o/r",
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [] },
  humanFeedback,
});

/** The `n`th comment, made at minute `n`, with `body`. */
const comment = (n: number, body: string, number = 7): HumanPullRequestFeedback => {
  const at = `2026-10-03T02:${String(n).padStart(2, "0")}:00Z`;
  return {
    id: `comment:${n}`, kind: "comment", author: "ada", state: null, body, path: null, line: null, commitId: null,
    createdAt: at, updatedAt: at, url: `https://github.com/o/r/pull/${number}#issuecomment-${n}`,
  };
};

const conversation: RunSpec["conversation"] = {
  issue: {
    id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D",
    state: "In Progress", stateType: "started", delegate: null, linkedPullRequests: [],
  },
  humanComments: [],
  agentComments: [],
};

/** Both briefs for these PRs, with the human feedback lines of each. */
function briefs(pullRequests: PullRequestFacts[]): { brief: string; feedback: string }[] {
  const base = { runId: "run_1", owner: { id: "ann", name: "Ann" }, repositories: ["o/r"], pullRequests, conversation };
  const subjects = pullRequests.map((p) => ({ repo: p.repo, number: p.number, headSha: head }));
  const reviewer = reviewerBrief({ ...base, role: "reviewer", subject: subjects }, [], []);
  const worker = workerBrief({ ...base, role: "worker", objective: "o", context: { pullRequests, runs: [] } }, []);
  return [reviewer, worker].map((brief) => ({
    brief,
    feedback: brief.split("\n").filter((l) => l.startsWith("    - ") || l.startsWith("      > ")).join("\n"),
  }));
}

const lines = (text: string) => text.split("\n").map((l) => `      > ${l}`).join("\n");

test("feedback under the bound renders every item whole, as before", () => {
  const human = [comment(1, "a".repeat(20_000)), comment(2, "Line one.\nLine two."), comment(3, "b".repeat(20_000))];
  for (const { brief, feedback } of briefs([pr(7, human)])) {
    expect(feedback).toBe(human.map(renderHumanFeedback).join("\n"));
    expect(brief).not.toContain("cut to keep");
  }
});

test("over the bound the newest items stay whole and older ones are cut, each linking to its full text", () => {
  // Ten 8 KB comments over two PRs, interleaved in time: about 80 KB in all.
  const body = (n: number) => `Request ${n}.\n${String.fromCharCode(96 + n).repeat(8_000)}`;
  const seven = [1, 3, 5, 7, 9].map((n) => comment(n, body(n), 7));
  const eight = [2, 4, 6, 8, 10].map((n) => comment(n, body(n), 8));
  for (const { feedback } of briefs([pr(7, seven), pr(8, eight)])) {
    expect(feedback.length).toBeLessThanOrEqual(HUMAN_FEEDBACK_BOUND);
    // Every item keeps its header, in the same order as before.
    expect(feedback.split("\n").filter((l) => l.startsWith("    - "))).toEqual(
      [...seven, ...eight].map((f) => renderHumanFeedback(f).split("\n")[0]),
    );
    // The newest five are whole, across both PRs.
    for (const f of [...seven, ...eight].filter((f) => Number(f.id.split(":")[1]) >= 6)) expect(feedback).toContain(renderHumanFeedback(f));
    // The next older one keeps part of its body; the oldest keep only their first line.
    const partial = `${lines(body(5)).slice(0, 2_000)}`;
    expect(feedback).toContain(partial);
    expect(feedback).toMatch(new RegExp(`> \\[… \\d+ more characters cut to keep this brief's PR feedback within 48 KB; the full text is at https://github.com/o/r/pull/7#issuecomment-5\\]`));
    for (const n of [1, 2, 3, 4]) {
      expect(feedback).toContain(`      > Request ${n}.\n      > [… 8001 more characters cut to keep this brief's PR feedback within 48 KB; the full text is at https://github.com/o/r/pull/${n % 2 ? 7 : 8}#issuecomment-${n}]`);
    }
  }
});

test("one very large item keeps as much as fits, and newer items stay whole", () => {
  const huge = "x".repeat(500_000);
  const human = [comment(1, "Short and older."), comment(2, `Rewrite all of it:\n${huge}`), comment(3, "Newer.\nStill whole.")];
  for (const { brief, feedback } of briefs([pr(7, human)])) {
    expect(feedback.length).toBeLessThanOrEqual(HUMAN_FEEDBACK_BOUND);
    expect(feedback.length).toBeGreaterThan(HUMAN_FEEDBACK_BOUND - 300);
    expect(feedback).toContain(renderHumanFeedback(human[2]!));
    // An older item whose whole body is its short first line is never cut.
    expect(feedback).toContain(renderHumanFeedback(human[0]!));
    expect(feedback).toContain("      > Rewrite all of it:\n      > xxxx");
    expect(feedback).toMatch(/> \[… \d+ more characters cut to keep this brief's PR feedback within 48 KB; the full text is at https:\/\/github.com\/o\/r\/pull\/7#issuecomment-2\]/);
    // The rest of the brief is still there.
    expect(brief).toContain("## Rules");
  }
});

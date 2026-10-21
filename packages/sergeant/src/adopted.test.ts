import { afterEach, expect, test } from "vitest";
import type { ProposedAction, PullRequestFacts } from "@terros/sergeant-contracts";
import { execute } from "./execute.ts";
import { cleanup, pr as loopPr, scenario, start as loopStart, stopAfter, turnOf, worker } from "./budget-scenario.ts";
import { conversation, ports, pr, situation } from "./execute-fixtures.ts";

// TECH-6164: the branch or PR a human or another agent started, that a worker takes over, is named on the
// issue when the worker is started, before the run starts and so before any other Sergeant comment on its
// work, and only once however many workers start. Sergeant never reviews such a PR, so no progress comment
// would name it either.

const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
const linkedPr = (number: number, author: string): PullRequestFacts => ({ ...pr, number, url: `https://github.com/${pr.repo}/pull/${number}`, author });

test("a worker start names the taken-over PR and exact-ID branch first and once; resembling and Sergeant's own branches are not named", async () => {
  const issue = { ...conversation.issue, linkedPullRequests: [3, 4].map((number) => ({ repo: pr.repo, number })) };
  const { p } = ports({ conversation: { ...conversation, issue } });
  const events: string[] = [];
  const keys = new Set<string>();
  p.linear.postComment = async ({ key, body }) => {
    if (keys.has(key)) return; // Linear posts at most once per key.
    keys.add(key);
    events.push(`comment: ${body}`);
  };
  p.github.branches = async () => ["main", "grok/unf-1", "sergeant/unf-1-own", "dev/unf-10-other", "xunf-1"];
  p.runner.start = async (spec) => void events.push(`start ${spec.role}`);
  // #3 another agent's PR linked to the issue; #4 the worker App's own.
  const facts = { ...situation, runs: [], pullRequests: [linkedPr(3, "grok[bot]"), linkedPr(4, p.workerLogin)] };

  expect(await execute(start, facts, p)).toMatchObject({ status: "done" });
  expect(await execute(start, facts, p)).toMatchObject({ status: "done" });
  expect(events).toHaveLength(3);
  expect(events[0]).toMatch(/^comment: Sergeant took over /);
  expect(events[0]).toContain(`[${pr.repo}#3](https://github.com/${pr.repo}/pull/3), which grok[bot] opened`);
  expect(events[0]).toContain(`branch \`grok/unf-1\` in ${pr.repo}`);
  expect(events[0]).not.toMatch(/#4|unf-10|xunf|unf-1-own/);
  expect(events.slice(1)).toEqual(["start worker", "start worker"]);
});

test("a worker start with nothing someone else started posts no takeover comment", async () => {
  const { p, started } = ports();
  const posted: string[] = [];
  p.linear.postComment = async ({ key }) => void posted.push(key);
  p.github.branches = async () => ["main", "sergeant/unf-1-own", "grok/unf-12"];
  expect(await execute(start, { ...situation, runs: [] }, p)).toMatchObject({ status: "done" });
  expect([posted, started.length]).toEqual([[], 1]);
});

afterEach(cleanup);

test("a takeover notice whose post failed at the start is posted on a later poll, once, before the worker's question", async () => {
  let failures = 1;
  let turns = 0;
  const { posted, live } = await scenario({
    // The linked PR #7 another agent opened, which the worker takes over.
    pullRequest: () => ({ ...loopPr, author: "grok[bot]" }),
    beforePost: ({ key }) => {
      if (key.startsWith("adopted:") && failures-- > 0) throw new Error("Linear is down");
    },
    // The worker ends at once, so the next turn asks a question.
    runner: { start: async () => {}, status: async (runId) => ({ ...worker("succeeded"), runId }), cancel: async () => {} },
    reasoner: async () => turnOf(++turns === 1 ? [loopStart] : [{ kind: "ask_human", question: "Which way?" }]),
    onPoll: stopAfter(5),
  });
  expect(turns).toBeGreaterThan(1);
  const notices = live.agentComments.filter((c) => c.body.startsWith("Sergeant took over "));
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toContain("o/canary#7](https://github.com/o/canary/pull/7), which grok[bot] opened");
  // Posted first among Sergeant's comments on the work, though the start's attempt failed.
  expect(posted[0]).toBe(notices[0]?.body);
  expect(posted.filter((b) => b.startsWith("Sergeant took over "))).toHaveLength(1);
  expect(posted.some((b) => b.includes("Which way?"))).toBe(true);
});

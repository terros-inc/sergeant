import type { PullRequestFacts } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import type { Ports } from "./execute.ts";
import { pr } from "./execute-fixtures.ts";
import { pullRequestPolls } from "./poll.ts";
import { Wake } from "./wake.ts";

// TECH-5336: every task loop reread every PR, its checks, and its feedback every minute, and with eight
// tasks that spent GitHub's hourly allowance. With webhooks delivered, a PR is reread when an event
// names it; the interval is only the fallback. A missed reread delays a merge or hides a red check, so
// each reason to reread must still reread.
test("with webhooks, PRs are reread on an event naming them, a mergeability still computing, or the fallback interval", async () => {
  let live: PullRequestFacts = pr;
  let reads = 0;
  const deps = { github: { readPullRequest: async () => (reads++, live) } } as unknown as Ports;
  const clock = { now: 0 };
  const wake = new Wake();
  const polls = pullRequestPolls(300_000, wake, () => clock.now);
  const read = () => polls.read([], [{ repo: pr.repo, number: pr.number }], [pr.repo], deps);

  await read();
  clock.now = 60_000;
  await read();
  expect(reads).toBe(1);

  wake.github = true;
  await read();
  expect([reads, wake.github]).toEqual([2, false]);

  live = { ...pr, mergeable: null, mergeableState: "unknown" };
  polls.forget();
  await read();
  await read();
  expect(reads).toBe(4);

  live = pr;
  await read();
  clock.now = 359_000;
  await read();
  expect(reads).toBe(5);
  clock.now = 360_000;
  await read();
  expect(reads).toBe(6);

  // Without webhooks, every pass reads.
  const every = pullRequestPolls(undefined, wake, () => clock.now);
  await every.read([], [{ repo: pr.repo, number: pr.number }], [pr.repo], deps);
  await every.read([], [{ repo: pr.repo, number: pr.number }], [pr.repo], deps);
  expect(reads).toBe(8);
});

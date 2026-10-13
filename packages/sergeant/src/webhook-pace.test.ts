import { expect, test } from "vitest";
import type { Ports } from "./execute.ts";
import { pr } from "./execute-fixtures.ts";
import type { LoopOptions } from "./loop-options.ts";
import { pullRequestPollMs, pullRequestPolls, waitMs } from "./poll.ts";
import { Wake } from "./wake.ts";
import { DELIVERING_MS, REFUSED_IN_A_ROW, SILENT_MS, webhookHealth } from "./webhook-health.ts";

// TECH-5942: Sergeant hit GitHub's rate limit every few hours while its webhooks were not delivering at
// all. Webhooks are now the primary signal and polling only their backup: a waiting task polls and
// rereads its PRs at the slow safety interval whether or not deliveries arrive, since falling back to
// fast polling when they stop would multiply Linear and GitHub load at the worst time. Only what no
// webhook announces (a run in flight, a mergeability GitHub is computing, a merge retry) polls fast.
test("a waiting task polls at the slow safety interval whether or not webhooks deliver", async () => {
  const clock = { now: 0 };
  const health = webhookHealth({ linear: "l", github: "g" }, () => {}, () => clock.now);
  const opts: Pick<LoopOptions, "githubPollSeconds" | "slowPollSeconds"> = { githubPollSeconds: 300, slowPollSeconds: 900 };
  let reads = 0;
  const deps = { github: { readPullRequest: async () => (reads++, pr) } } as unknown as Ports;
  const polls = pullRequestPolls(pullRequestPollMs(opts), new Wake(), () => clock.now);
  const read = () => polls.read([], [{ repo: pr.repo, number: pr.number }], [pr.repo], deps);
  /** The polls a waiting loop makes over `minutes`, and its PR reads, from a fresh read (as after a turn). */
  const over = async (minutes: number) => {
    const before = reads;
    let passes = 0;
    polls.forget();
    for (const end = clock.now + minutes * 60_000; clock.now < end; clock.now += waitMs(opts, 60_000, false), passes++) await read();
    return { passes, reads: reads - before };
  };

  // No delivery yet: two polls and two PR reads in the half hour, not 30 polls and 6 reads.
  expect(await over(30)).toEqual({ passes: 2, reads: 2 });

  // Both sources deliver: the same.
  health.accepted("github");
  health.accepted("linear");
  expect(await over(30)).toEqual({ passes: 2, reads: 2 });

  // Deliveries stop: still the same, so the drop to polling does not multiply the load.
  clock.now += DELIVERING_MS;
  expect([health.delivering("github"), health.delivering("linear")]).toEqual([false, false]);
  expect(await over(30)).toEqual({ passes: 2, reads: 2 });

  // A run, a mergeability being computed, or a merge retry coming due keeps the ordinary poll.
  expect(waitMs(opts, 60_000, true)).toBe(60_000);
  // Without a GitHub webhook secret, PRs are reread at the safety interval too, not every pass.
  expect(pullRequestPollMs({ slowPollSeconds: 900 })()).toBe(900_000);
  // A longer configured poll stays longer.
  expect(waitMs(opts, 1_800_000, false)).toBe(1_800_000);
});

test("a webhook source refused again and again, or silent for hours, is said once until a delivery is accepted", () => {
  const clock = { now: 0 };
  const logs: string[] = [];
  const health = webhookHealth({ linear: "l", github: "g" }, (line) => logs.push(line), () => clock.now);
  const warnings = () => logs.filter((l) => l.startsWith("WARNING"));

  for (let i = 0; i < REFUSED_IN_A_ROW * 3; i++) health.refused("linear", "bad signature");
  expect(warnings()).toEqual([expect.stringContaining("WARNING: linear webhook: 5 deliveries in a row refused (bad signature)")]);
  expect(health.status().find((w) => w.source === "linear")).toMatchObject({ refused: 15, delivering: false, alert: expect.stringContaining("refused") });

  // A secret configured but never delivered to: GitHub's App subscribed to no events.
  clock.now = SILENT_MS;
  health.check();
  health.check();
  expect(warnings()).toHaveLength(2);
  expect(warnings()[1]).toContain("github webhook: no delivery accepted in the 6 hours since serve started");

  health.accepted("linear");
  health.accepted("github");
  health.accepted("github");
  expect(health.status().map((w) => [w.source, w.delivering, w.alert])).toEqual([["linear", true, null], ["github", true, null]]);
  // Accepted deliveries are logged once an hour at most, as a count.
  expect(logs.filter((l) => /webhook: (first delivery|\d+ deliveries) accepted/.test(l))).toEqual(["linear webhook: first delivery accepted", "github webhook: first delivery accepted"]);
  clock.now += 3_600_000;
  health.accepted("github");
  expect(logs.at(-1)).toBe(`github webhook: 2 deliveries accepted since ${new Date(SILENT_MS).toISOString()}`);
});

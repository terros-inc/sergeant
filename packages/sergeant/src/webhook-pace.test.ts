import { expect, test } from "vitest";
import type { Ports } from "./execute.ts";
import { pr } from "./execute-fixtures.ts";
import type { LoopOptions } from "./loop-options.ts";
import { pullRequestPollMs, pullRequestPolls, waitMs } from "./poll.ts";
import { Wake } from "./wake.ts";
import { DELIVERING_MS, REFUSED_IN_A_ROW, SILENT_MS, webhookHealth } from "./webhook-health.ts";

// TECH-5942: Sergeant hit GitHub's rate limit every few hours while its webhooks were not delivering at
// all. Webhooks are now the primary signal: while both sources deliver, a waiting task polls and rereads
// its PRs only at the slow safety interval. Polling is the backup, so once deliveries stop it must return
// to the ordinary interval, or a broken webhook would leave tasks a quarter of an hour behind.
test("polling drops to the slow interval while webhooks deliver, and returns to the ordinary one when they stop", async () => {
  const clock = { now: 0 };
  const health = webhookHealth({ linear: "l", github: "g" }, () => {}, () => clock.now);
  const opts: Pick<LoopOptions, "githubPollSeconds" | "webhooks" | "slowPollSeconds"> = {
    githubPollSeconds: 300,
    slowPollSeconds: 900,
    webhooks: { delivering: health.delivering, both: () => health.delivering("github") && health.delivering("linear") },
  };
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

  // No delivery yet: a poll every minute, PRs every 5 minutes, as before TECH-5942.
  expect(await over(60)).toEqual({ passes: 60, reads: 12 });

  // Both sources deliver: over the half hour a delivery stays fresh, two polls and two PR reads.
  health.accepted("github");
  health.accepted("linear");
  expect(await over(30)).toEqual({ passes: 2, reads: 2 });
  // A run, a mergeability being computed, or a merge retry coming due keeps the ordinary poll.
  expect(waitMs(opts, 60_000, true)).toBe(60_000);

  // Only GitHub's still delivers: PRs are reread slowly, but the task polls every minute for Linear.
  health.accepted("github");
  expect([waitMs(opts, 60_000, false), pullRequestPollMs(opts)()]).toEqual([60_000, 900_000]);

  // Deliveries stop: back to the ordinary intervals.
  clock.now += DELIVERING_MS;
  expect(await over(60)).toEqual({ passes: 60, reads: 12 });
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

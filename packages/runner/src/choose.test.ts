import { expect, test } from "vitest";
import type { Adapter } from "./agents.ts";
import { chooseAccount, score, type Candidate } from "./choose.ts";

// TECH-5213: each launch takes the account whose quota is furthest ahead of its reset schedule, the
// tighter of its weekly and 5-hour windows governing.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
/** Percent left and hours to reset, weekly then 5-hour. */
const account = (name: string, weekly: [number, number], fiveHour: [number, number], adapter: Adapter = "claude-code-local"): Candidate<string> => ({
  account: name,
  adapter,
  name,
  quota: {
    adapter,
    account: name,
    readAt: at(0),
    weekly: { remainingPercent: weekly[0], resetsAt: at(weekly[1]) },
    fiveHour: { remainingPercent: fiveHour[0], resetsAt: at(fiveHour[1]) },
  },
});
const HALF_WEEK = 84;
/** A full 5-hour window half gone: pace 2, so the weekly window governs. */
const FULL = [100, 2.5] as [number, number];
const choose = (candidates: Candidate<string>[], opts: { avoid?: Adapter } = {}) => chooseAccount(candidates, { now: NOW, ...opts });

test("an underused account wins, and one near its reset beats one with more raw percent left", () => {
  // Half the week gone for both: 80% left is ahead of schedule (pace 1.6), 40% behind it (0.8).
  expect(choose([account("behind", [40, HALF_WEEK], FULL), account("ahead", [80, HALF_WEEK], FULL)])?.name).toBe("ahead");
  // 30% that resets in 12 hours would mostly expire unused; 90% with the whole week to go would not.
  const near = account("near", [30, 12], FULL);
  const roomy = account("roomy", [90, 168], FULL);
  expect(choose([roomy, near])).toMatchObject({ name: "near", reason: "near, 30% weekly, 100% 5-hour left: pace 2, the highest of 2 usable" });
  expect(score(roomy, NOW)).toBeCloseTo(0.9);
});

test("the tighter of the weekly and 5-hour windows governs", () => {
  // A week far ahead of schedule does not hide a 5-hour window nearly spent with 4 hours to go.
  const tight = account("tight", [90, 12], [20, 4]);
  expect(score(tight, NOW)).toBeCloseTo(0.25);
  expect(choose([tight, account("even", [50, HALF_WEEK], [100, 5])])?.name).toBe("even");
});

test("a depleted account with a distant reset is conserved", () => {
  const depleted = account("depleted", [10, 144], FULL);
  expect(choose([depleted, account("on-pace", [50, HALF_WEEK], FULL)])?.name).toBe("on-pace");
  // Still usable when it is the only one: conserving never refuses a launch.
  expect(choose([depleted])?.name).toBe("depleted");
});

// TECH-5390: a worker has no provider preference; the healthiest account wins, whichever its provider.
test("a worker takes the highest score, whichever its provider", () => {
  const claude = account("claude", [50, HALF_WEEK], FULL);
  const codex = account("codex", [70, HALF_WEEK], FULL, "codex-local");
  expect(choose([claude, codex])?.name).toBe("codex");
  expect(choose([account("claude", [90, HALF_WEEK], FULL), codex])?.name).toBe("claude");
  // Nothing scored: the candidates' order, not a provider, decides.
  const unread = (c: Candidate<string>): Candidate<string> => ({ ...c, quota: undefined });
  expect(choose([unread(claude), unread(codex)])?.name).toBe("claude");
  expect(choose([unread(codex), unread(claude)])?.name).toBe("codex");
});

// TECH-5390: a reviewer takes the other provider whenever the owner has a usable account of it, however
// far behind its pace is, and its worker's provider only when there is none.
test("a reviewer takes the other provider's best usable account, however it scores, and its worker's only without one", () => {
  const claude = account("claude", [100, HALF_WEEK], FULL); // pace 2
  const stressed = account("codex", [30, HALF_WEEK], FULL, "codex-local"); // 0.6: far more than 20% behind
  const codexBest = account("codexBest", [60, HALF_WEEK], FULL, "codex-local"); // 1.2
  expect(choose([claude, stressed], { avoid: "claude-code-local" })).toMatchObject({ name: "codex", reason: expect.stringContaining("the highest for another provider") });
  expect(choose([claude, stressed, codexBest], { avoid: "claude-code-local" })?.name).toBe("codexBest");
  // A partial reading on the other provider is usable, so it reviews too.
  const partial: Candidate<string> = { ...stressed, quota: { adapter: "codex-local", readAt: at(0), weekly: { remainingPercent: 99 }, fiveHour: { remainingPercent: 99 } } };
  expect(choose([claude, partial], { avoid: "claude-code-local" })?.name).toBe("codex");
  // A spent one is not usable: the review stays on the worker's provider.
  const spentCodex = account("codex", [0, HALF_WEEK], FULL, "codex-local");
  expect(choose([claude, spentCodex], { avoid: "claude-code-local" })).toMatchObject({ name: "claude", reason: expect.stringContaining("the highest") });
  expect(choose([claude], { avoid: "claude-code-local" })?.name).toBe("claude");
});

test("time left is at least an hour's share of the window: finite at its reset, and a sliver near reset stays behind a healthy account", () => {
  // At, or already past, its reset: an hour's share (20% of the 5-hour window), never a division by zero.
  expect(score(account("now", [50, HALF_WEEK], [10, 0]), NOW)).toBeCloseTo(0.5);
  expect(score(account("past", [50, HALF_WEEK], [10, -1]), NOW)).toBeCloseTo(0.5);
  expect(score(account("week", [1, 0], FULL), NOW)).toBeCloseTo(1 / (100 / 168));
  // 3% left with 2% of the 5-hour window to go would read as pace 1.5 unclamped; it reads 0.15.
  const sliver = account("sliver", [90, 24], [3, 0.1]);
  expect(choose([sliver, account("healthy", [60, HALF_WEEK], [60, 3])])?.name).toBe("healthy");
});

test("a window without a reset time is partial: usable, ranked after every scored account", () => {
  const noReset: Candidate<string> = { ...account("no-reset", [99, 1], FULL), quota: { adapter: "claude-code-local", readAt: at(0), weekly: { remainingPercent: 99, resetsAt: at(1) }, fiveHour: { remainingPercent: 99 } } };
  expect(score(noReset, NOW)).toBeUndefined();
  expect(choose([noReset, account("depleted", [5, 144], FULL)])?.name).toBe("depleted");
  expect(choose([noReset])).toMatchObject({ name: "no-reset", reason: expect.stringContaining("quota unknown (partial: a window without a reset)") });
});

// TECH-5342: a personal ChatGPT plan reports a weekly window and no 5-hour one. That is a reading of
// its week, not an unknown, so a mostly unspent subscription is not left idle behind every other account.
test("an account whose provider reports only its weekly window is scored on it; a failed reading still ranks last", () => {
  const weeklyOnly = (name: string, resetsAt: string | undefined): Candidate<string> => ({
    account: name,
    adapter: "codex-local",
    name,
    quota: { adapter: "codex-local", account: name, readAt: at(0), weekly: { remainingPercent: 93, ...(resetsAt && { resetsAt }) }, unreported: "5-hour" },
  });
  const personal = weeklyOnly("codexPersonal", at(112)); // 93% left with two thirds of the week to go: pace 1.4
  const work = account("codexWork", [60, HALF_WEEK], FULL, "codex-local"); // 1.2
  expect(score(personal, NOW)).toBeCloseTo(1.395);
  expect(choose([work, personal])).toMatchObject({ name: "codexPersonal", reason: "codexPersonal, 93% weekly (no 5-hour window reported): pace 1.4, the highest of 2 usable" });
  // Also as a reviewer's other provider, and behind a both-window account with a better pace.
  expect(choose([account("claude", [80, HALF_WEEK], FULL), personal], { avoid: "claude-code-local" })?.name).toBe("codexPersonal");
  expect(choose([personal, account("ahead", [80, HALF_WEEK], FULL)])?.name).toBe("ahead");

  // A reading that failed, or whose one window has no reset, is unscored and ranks after a depleted account.
  const failed: Candidate<string> = { ...work, name: "failed", quota: { adapter: "codex-local", readAt: at(0), error: "usage endpoint answered 401" } };
  const noReset = weeklyOnly("no-reset", undefined);
  const depleted = account("depleted", [5, 144], FULL);
  expect(score(failed, NOW)).toBeUndefined();
  expect(score(noReset, NOW)).toBeUndefined();
  expect(choose([failed, noReset, depleted])?.name).toBe("depleted");
  expect(choose([failed])).toMatchObject({ reason: expect.stringContaining("quota unknown (usage endpoint answered 401)") });
});

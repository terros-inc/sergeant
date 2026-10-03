import { expect, test } from "vitest";
import type { Adapter } from "./agents.ts";
import { chooseReviewer, chooseWorker, type Candidate } from "./choose.ts";

const at = "2026-10-03T12:00:00.000Z";
const quota = (adapter: Adapter, weekly: number, fiveHour: number): Candidate => ({
  adapter,
  quota: { adapter, readAt: at, weekly: { remainingPercent: weekly }, fiveHour: { remainingPercent: fiveHour } },
});
const unknown = (adapter: Adapter): Candidate => ({ adapter, quota: { adapter, readAt: at, error: "usage endpoint answered 401" } });

// TECH-5117: on 2026-10-03 Codex workers spent 82% → 43% of Codex's week while Claude had 83% left.
// The worker must go where the most weekly capacity is, whatever `runners` says.
test("the worker gets the provider with the most weekly capacity left", () => {
  const choice = chooseWorker([quota("claude-code-local", 83, 90), quota("codex-local", 43, 90)], "codex-local");
  expect(choice).toMatchObject({ adapter: "claude-code-local" });
  expect(choice.readings).toHaveLength(2);
  expect(chooseWorker([quota("claude-code-local", 30, 90), quota("codex-local", 60, 50)], "claude-code-local").adapter).toBe("codex-local");
});

// A provider with plenty of week left but an almost spent 5-hour window would stall the worker mid-run.
test("a 5-hour window below 20% flips the worker to the other provider", () => {
  const flipped = chooseWorker([quota("claude-code-local", 83, 19), quota("codex-local", 43, 60)], "claude-code-local");
  expect(flipped.adapter).toBe("codex-local");
  expect(flipped.reason).toMatch(/5-hour window is below 20%/);
  // At the floor is still usable; and when both are below it, flipping helps nothing.
  expect(chooseWorker([quota("claude-code-local", 83, 20), quota("codex-local", 43, 60)], "codex-local").adapter).toBe("claude-code-local");
  expect(chooseWorker([quota("claude-code-local", 83, 5), quota("codex-local", 43, 10)], "codex-local").adapter).toBe("claude-code-local");
});

// A quota read must never block or guess: an unreadable provider keeps the configured `runners` role.
test("unknown quota falls back to the configured provider", () => {
  const choice = chooseWorker([quota("claude-code-local", 83, 90), unknown("codex-local")], "codex-local");
  expect(choice).toMatchObject({ adapter: "codex-local", reason: expect.stringContaining("quota unknown for codex-local") });
  expect(choice.readings[1]).toMatchObject({ error: "usage endpoint answered 401" });
  expect(chooseReviewer([quota("claude-code-local", 83, 90), unknown("codex-local")], "claude-code-local", "codex-local")).toMatchObject({
    adapter: "codex-local",
  });
  expect(chooseReviewer([quota("claude-code-local", 83, 90), quota("codex-local", 50, 50)], undefined, "claude-code-local").adapter).toBe(
    "claude-code-local",
  );
});

// Review must come from a different AI than the work, even when that one has less week left; only an
// unusable other provider lets it share the worker's, and the record says so.
test("the reviewer gets the provider other than its worker's", () => {
  const both = [quota("claude-code-local", 83, 90), quota("codex-local", 43, 60)];
  expect(chooseReviewer(both, "claude-code-local", "claude-code-local")).toMatchObject({ adapter: "codex-local" });
  expect(chooseReviewer(both, "codex-local", "codex-local").sameProviderAsWorker).toBeUndefined();

  const spent = chooseReviewer([quota("claude-code-local", 83, 90), quota("codex-local", 43, 10)], "claude-code-local", "codex-local");
  expect(spent).toMatchObject({ adapter: "claude-code-local", sameProviderAsWorker: true });
  const unreadable = chooseReviewer([unknown("claude-code-local"), quota("codex-local", 43, 60)], "codex-local", "codex-local");
  expect(unreadable).toMatchObject({ adapter: "codex-local", sameProviderAsWorker: true });
});

import { expect, test } from "vitest";
import type { RunRecord } from "@terros/sergeant-contracts";
import { costSoFar, costTotal } from "./cost.ts";

// TECH-5227: a cost line never passes a run without a reported cost off as $0, and names accounts, not emails.

const run = (role: "worker" | "reviewer", provider: string, costUsd: number | undefined, account: string): RunRecord =>
  ({
    runId: `run_${account}_${costUsd}`, role, status: "succeeded", provider, model: "m", report: null,
    ...(costUsd !== undefined && { costUsd }),
    account: { id: `person:user-ann:${account}`, group: "registered", holder: "Ann <ann@example.com>" },
  }) as RunRecord;

test("known costs are summed per provider, and runs without one are counted as unknown", () => {
  const input = {
    runs: [
      run("worker", "anthropic/claude-code", 2.5, "claudeWork"),
      run("worker", "openai/codex", 0.5, "codexWork"),
      run("reviewer", "openai/codex", undefined, "codexWork"),
      run("reviewer", "anthropic/claude-code", 0.4, "claudeWork"),
    ],
    unknownRuns: 1,
    turnCostUsd: 0.6,
    startedAt: "2026-10-05T01:00:00.000Z",
    at: "2026-10-05T02:21:00.000Z",
  };
  expect(costTotal(input)).toBe(
    "Cost: ~$4.00 estimated, not counting 2 runs of unknown cost (Claude $2.90 · Codex $0.50 + 1 unknown · Sergeant's turns $0.60) · 5 runs (2 worker, 2 review, 1 unreadable) · 1 h 21 min · accounts: claudeWork, codexWork",
  );
  expect(costSoFar(input)).toBe("Cost so far: ~$4.00 estimated, not counting 2 runs of unknown cost · 5 runs · 1 h 21 min · accounts: claudeWork, codexWork");
  expect(costSoFar({ ...input, unknownRuns: 0, runs: input.runs.filter((r) => r.costUsd !== undefined) })).not.toContain("unknown");
});

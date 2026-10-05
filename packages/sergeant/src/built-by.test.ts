import type { RunRecord } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { builtByLine } from "./built-by.ts";

const run = (runId: string, role: "worker" | "reviewer", provider: string): RunRecord =>
  ({ runId, role, status: "succeeded", provider, model: "m", report: null }) as RunRecord;

// TECH-5085: the squash commit names the agents only in this plain line, from what actually ran.
test("names each role's agents from the run records", () => {
  expect(builtByLine([run("run_w1", "worker", "anthropic/claude-code"), run("run_r1", "reviewer", "openai/codex")])).toBe(
    "Built by Sergeant (worker: Claude, review: Codex)",
  );
  expect(
    builtByLine([
      run("run_w1", "worker", "anthropic/claude-code"),
      run("run_w2", "worker", "openai/codex"),
      run("run_w3", "worker", "anthropic/claude-code"),
      run("run_w4", "worker", "unknown"),
    ]),
  ).toBe("Built by Sergeant (worker: Claude and Codex)");
  expect(builtByLine([])).toBe("Built by Sergeant");
});

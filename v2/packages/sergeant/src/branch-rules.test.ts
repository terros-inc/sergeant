import { expect, test } from "vitest";
import { BranchRules } from "./branch-rules.ts";

// A policy-looking response without ruleset IDs would let the live check skip every worker-bypass query.
test("an active branch rule without a ruleset ID is rejected", () => {
  expect(BranchRules.safeParse([{ type: "pull_request" }]).success).toBe(false);
  expect(BranchRules.parse([{ type: "pull_request", ruleset_id: 7 }])[0]?.ruleset_id).toBe(7);
});

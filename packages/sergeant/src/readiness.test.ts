import { expect, test } from "vitest";
import { execute } from "./execute.ts";
import { merge, ports, pr, situation } from "./execute-fixtures.ts";

test.each(["sergeant", "human"] as const)("declares the exact head before a %s-policy merge or handoff", async (policy) => {
  const { p } = ports();
  const order: string[] = [];
  p.github.mergePolicy = () => policy;
  p.github.declareReadiness = async ({ comment }) => {
    order.push("declare");
    expect(comment.split("\n", 1)[0]).toMatch(/^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$/);
    expect(comment).toContain("\nReason: ready from records\n");
    expect(comment).toContain("Required checks: 1 of 1 passed");
    return { id: 73, url: `${pr.url}#issuecomment-73`, comment };
  };
  p.github.mergePullRequest = async () => (order.push("merge"), { mergedSha: "c".repeat(40) });
  p.github.handToHuman = async () => (order.push("handoff"), { requested: [] });
  const outcome = await execute({ ...merge, readinessReason: "ready from records" }, situation, p);
  expect(order).toEqual(["declare", policy === "sergeant" ? "merge" : "handoff"]);
  if (outcome.status === "done") expect(outcome.merged?.readinessCommentId).toBe(73);
  else if (outcome.status === "denied") expect(outcome.refused?.readinessCommentId).toBe(73);
});

test("a policy refusal retains the declaration id before its follow-up handoff", async () => {
  const { p } = ports();
  const order: string[] = [];
  const existingComment = `READY TO MERGE | SHA: ${pr.headSha}\n\nReason: earlier declaration\n\nEvidence on this head:\n- recorded`;
  p.github.declareReadiness = async () => (order.push("declare"), { id: 74, url: `${pr.url}#issuecomment-74`, comment: existingComment });
  p.github.mergePullRequest = async () => (order.push("merge"), { refused: "approval required" });
  p.github.handToHuman = async ({ comment }) => {
    order.push("handoff");
    expect(comment).toBe(existingComment);
    return { requested: [] };
  };
  const outcome = await execute({ ...merge, readinessReason: "ready" }, situation, p);
  expect(order).toEqual(["declare", "merge", "handoff"]);
  expect(outcome.status === "denied" && outcome.refused?.readinessCommentId).toBe(74);
});

test("a human-policy handoff reuses the filtered declaration body", async () => {
  const { p } = ports();
  p.github.mergePolicy = () => "human";
  const filtered = `READY TO MERGE | SHA: ${pr.headSha}\n\nReason: Reason recorded in Sergeant's task record\n\nEvidence on this head:\n- recorded`;
  p.github.declareReadiness = async () => ({ id: 75, url: `${pr.url}#issuecomment-75`, comment: filtered });
  p.github.handToHuman = async ({ comment }) => {
    expect(comment).toBe(filtered);
    return { requested: [] };
  };
  const outcome = await execute({ ...merge, readinessReason: "text rejected by the public-data check" }, situation, p);
  expect(outcome.status).toBe("denied");
});

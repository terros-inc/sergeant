import { afterEach, expect, test } from "vitest";
import type { RunRecord } from "@terros/sergeant-contracts";
import { cleanup, head, issue, repo, review, scenario, turnOf, worker } from "./budget-scenario.ts";

// TECH-5082: every run that failed model authentication gets the Linear alert once, whatever the
// task's state: before the merge, on the poll that stops the task, and after the merge.

afterEach(cleanup);

const authFailed = (run: RunRecord): RunRecord => ({ ...run, status: "failed", provider: "openai/codex", report: null, failureReason: "authentication" });
const alerts = (posted: string[]) => posted.filter((body) => body.startsWith("**Codex authentication failed**"));

test("a failure seen before the merge is alerted once across polls", async () => {
  let polls = 0;
  const { result, posted } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w"] },
    runner: { start: async () => {}, status: async () => authFailed(worker("failed")), cancel: async () => {} },
    reasoner: async () => turnOf([]),
    onPoll: (poll, live) => ((polls = poll), live),
  });
  expect(result.outcome).toBe("idle");
  expect(polls).toBeGreaterThan(1);
  expect(alerts(posted)).toHaveLength(1);
  expect(alerts(posted)[0]).toContain("Run `run_w`");
});

test("a failure seen on the poll that stops the task is alerted", async () => {
  const { result, posted } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w"] },
    conversation: { issue: { ...issue, delegate: null } },
    runner: { start: async () => {}, status: async () => authFailed(worker("failed")), cancel: async () => {} },
    reasoner: async () => { throw new Error("an undelegated issue gets no turn"); },
    onPoll: (_poll, live) => live,
  });
  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("not delegated") });
  expect(alerts(posted)).toHaveLength(1);
});

test("a review and the audit failing after the merge are each alerted once", async () => {
  const audit = `run_audit-${head}`;
  // The audit is still running when the reviews are first read, and fails while the loop waits on it.
  let auditReads = 0;
  const status = async (id: string) =>
    id === audit
      ? ++auditReads < 3 ? { ...review, runId: audit, status: "running" as const, report: null } : authFailed({ ...review, runId: audit })
      : authFailed(review);
  const at = new Date().toISOString();
  const { result, posted } = await scenario({
    state: {
      startedAt: at,
      runIds: ["run_review"],
      merged: { repo, number: 7, headSha: head, mergedSha: "c".repeat(40), at, outcomePostedAt: at, auditDrawnAt: at, audit: { runId: audit } },
    },
    conversation: { issue: { ...issue, state: "Done", stateType: "completed" } },
    runner: { start: async () => {}, status, cancel: async () => {} },
    reasoner: async () => { throw new Error("a merged task gets no turn"); },
    onPoll: (_poll, live) => live,
  });
  expect(result.outcome).toBe("done");
  expect(auditReads).toBeGreaterThanOrEqual(3);
  expect(alerts(posted).map((body) => body.match(/Run `([^`]+)`/)?.[1])).toEqual(["run_review", audit]);
});

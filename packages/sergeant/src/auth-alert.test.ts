import { commentIdFor, type AgentComment, type RunRecord } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { authAlertKey, postAuthAlerts } from "./auth-alert.ts";

const failed = (runId: string, failureReason?: "authentication"): RunRecord => ({
  runId,
  role: "worker",
  status: "failed",
  provider: "openai/codex",
  model: "codex",
  report: null,
  reportError: "safe detail",
  ...(failureReason && { failureReason }),
});

test("alerts once for each Codex authentication failure with recovery instructions", async () => {
  const posted: { issueId: string; key: string; body: string }[] = [];
  const existingKey = authAlertKey("i1", "run_old");
  const comments: AgentComment[] = [{ id: commentIdFor(existingKey), createdAt: "2026-10-03T00:00:00.000Z", body: "already posted" }];

  await postAuthAlerts(
    "i1",
    [failed("run_auth", "authentication"), failed("run_other"), failed("run_old", "authentication")],
    comments,
    { postComment: async (comment) => void posted.push(comment) },
    () => {},
  );

  expect(posted).toEqual([
    expect.objectContaining({ issueId: "i1", key: authAlertKey("i1", "run_auth") }),
  ]);
  expect(posted[0]?.body).toContain("replace its configured Secrets Manager secret");
  expect(posted[0]?.body).toContain("switch `codex-local` to an OpenAI API key");
});

// TECH-5113: a registered account's failure is its person's to fix, never the installation's secret.
test("a registered account's alert names whose it is and how they fix it", async () => {
  const posted: string[] = [];
  const run = { ...failed("run_ada", "authentication"), provider: "anthropic/claude-code", account: { id: "person:u1:claude-code-local", group: "registered", holder: "Ada Example <ada@example.com>" } } as const;
  await postAuthAlerts("i1", [run], [], { postComment: async ({ body }) => void posted.push(body) }, () => {});
  expect(posted[0]).toContain("**Claude authentication failed**");
  expect(posted[0]).toContain("Ada Example <ada@example.com>'s registered account");
  expect(posted[0]).toContain("sgt account register claude-code-local");
  expect(posted[0]).not.toContain("Secrets Manager secret");
});

test("a failed alert is left retryable", async () => {
  const logs: string[] = [];
  await expect(
    postAuthAlerts("i1", [failed("run_auth", "authentication")], [], { postComment: async () => { throw new Error("offline"); } }, (line) => logs.push(line)),
  ).resolves.toBeUndefined();
  expect(logs).toEqual(["run_auth: model authentication alert not posted: offline"]);
});

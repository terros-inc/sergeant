import { expect, test } from "vitest";
import { issueRevision } from "@terros/sergeant-contracts";
import { CODEX, ended, GH, REPORT, spec, started } from "./runner-fixtures.ts";

// A run on Codex (TECH-5009): its credential, and what its logs record about cost and failure.

const envNames = (args: string[] = []) => args.flatMap((a, i, all) => (a === "--env" ? [all[i + 1]] : []));

// TECH-5009: a role on Codex gets the Codex credential in place of the Claude token, never both, and
// otherwise the same container: workspace mount, worker-App token, and human git identity.
test("a codex-local run gets only the Codex credential in place of the Claude token", async () => {
  const { host } = await started({ adapters: { worker: "codex-local" } });

  const run = host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  expect(envNames(run?.args)).toEqual([
    "CODEX_CREDENTIAL",
    "GH_TOKEN",
    "GIT_AUTHOR_NAME=Ada Example",
    "GIT_AUTHOR_EMAIL=ada@example.com",
    "GIT_COMMITTER_NAME=Ada Example",
    "GIT_COMMITTER_EMAIL=ada@example.com",
  ]);
  expect(run?.opts.env).toMatchObject({ CODEX_CREDENTIAL: CODEX, GH_TOKEN: GH });
  expect(run?.args.join(" ")).toContain("codex exec --json");
  expect(run?.args.slice(-3)).toEqual(["3600", "gpt-5", "10"]);
  expect(host.calls.flatMap((c) => c.args).join(" ")).not.toContain("codex-test-token");
});


// The budget adds `costUsd` and counts a run without one as unknown. Codex reports tokens, never
// dollars: a guessed figure would understate or overstate spend, so its cost stays absent.
test("a Codex run records its summed tokens and no cost; a Claude run its reported cost", async () => {
  const codexLogs = [
    '{"type":"thread.started","thread_id":"t-1"}',
    "Reading prompt from stdin...",
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50,"reasoning_output_tokens":20}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join("\n");
  const codex = await ended({ adapters: { worker: "codex-local" } }, codexLogs);
  // M13 skips a record without `issueRevision`, so a Codex run must carry it like a Claude run (TECH-5045).
  expect(codex).toMatchObject({ status: "succeeded", provider: "openai/codex", model: "gpt-5", issueRevision: issueRevision(spec.conversation.issue) });
  expect(codex.tokens).toEqual({ input: 1010, cachedInput: 400, output: 55, reasoningOutput: 20 });
  expect(codex.costUsd).toBeUndefined();
  expect(codex.report).not.toBeNull();

  const claude = await ended({}, '{"is_error":false,"session_id":"s","total_cost_usd":1.25,"modelUsage":{"claude-sonnet-5-5":{}}}');
  expect(claude).toMatchObject({ status: "succeeded", provider: "anthropic/claude-code", model: "claude-sonnet-5-5", costUsd: 1.25 });
  expect(claude.tokens).toBeUndefined();
});

// These are Codex 0.160.0's own messages. In particular, reuse is how a disposable container's
// stored ChatGPT credential fails after another run rotated the refresh token (TECH-5020).
test.each([
  "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
  "Your access token could not be refreshed. Please log out and sign in again.",
  "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
])("a Codex refresh failure is recorded as authentication: %s", async (message) => {
  const run = await started({ adapters: { worker: "codex-local" } });
  run.host.docker.running = false;
  run.host.docker.logErrors = `Error refreshing token: ${message}`;

  expect(await run.runner.status("run_t1")).toMatchObject({
    status: "failed",
    failureReason: "authentication",
    reportError: expect.stringContaining("replace the account's Codex credential"),
  });
});

// A reused refresh token on Codex 0.160.0 fails as this structured turn.failed, so it is the main
// detection path (TECH-5020). The provider's error text, with any key or token it quotes, never
// reaches the run record: the alert names the fix instead.
test("a Codex turn.failed 401 is recorded as authentication and keeps no key or token", async () => {
  const message = "workspace routing discovery unauthorized (401): Incorrect API key provided: sk-proj***abcd, token codex-test-token";
  const run = await ended({ adapters: { worker: "codex-local" } }, JSON.stringify({ type: "turn.failed", error: { message } }), "");

  expect(run).toMatchObject({ status: "failed", failureReason: "authentication", reportError: expect.stringContaining("replace the account's Codex credential") });
  for (const fragment of ["sk-", "abcd", "codex-test-token", "workspace routing"]) expect(JSON.stringify(run)).not.toContain(fragment);
});

// Any other Codex failure keeps its message for the record, but with a quoted key redacted.
test("a non-auth Codex failure redacts the key it quotes", async () => {
  const message = "Model gpt-5 is not available for key sk-proj-AbC123_xyz.9";
  const run = await ended({ adapters: { worker: "codex-local" } }, JSON.stringify({ type: "turn.failed", error: { message } }), "");

  expect(run).toMatchObject({ status: "failed", reportError: expect.stringContaining("Model gpt-5 is not available for key sk-[redacted]") });
  expect(run.failureReason).toBeUndefined();
  for (const fragment of ["sk-proj", "AbC123", "xyz"]) expect(JSON.stringify(run)).not.toContain(fragment);
});

test("non-auth Codex failures and unrelated stderr do not report authentication", async () => {
  // A usage limit is the account's quota (TECH-5113), which sets the account aside, never an auth alert.
  const turn = await ended(
    { adapters: { worker: "codex-local" } },
    '{"type":"turn.failed","error":{"message":"The model hit its usage limit."}}',
    "",
  );
  expect(turn).toMatchObject({ status: "failed", reportError: expect.stringContaining("The model hit its usage limit."), failureReason: "quota" });

  const timeout = await started({ adapters: { worker: "codex-local" } });
  timeout.host.docker.running = false;
  timeout.host.docker.exitCode = 124;
  timeout.host.docker.logErrors = "health probe returned 401 Unauthorized";
  const timedOut = await timeout.runner.status("run_t1");
  expect(timedOut).toMatchObject({ status: "failed", reportError: expect.stringContaining("wall-time limit reached") });
  expect(timedOut.failureReason).toBeUndefined();

  const success = await ended(
    { adapters: { worker: "codex-local" } },
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
    REPORT,
    "an unrelated request returned 401 Unauthorized",
  );
  expect(success.status).toBe("succeeded");
  expect(success.failureReason).toBeUndefined();
});

import { expect, test } from "vitest";
import { issueRevision } from "@terros/sergeant-contracts";
import { CODEX, ended, GH, ON_CODEX, REPORT, spec, started } from "./runner-fixtures.ts";

// A run on Codex (TECH-5009): its credential, and what its logs record about cost and failure.

const envNames = (args: string[] = []) => args.flatMap((a, i, all) => (a === "--env" ? [all[i + 1]] : []));

// TECH-5009: a role on Codex gets the Codex credential in place of the Claude token, never both, and
// otherwise the same container: workspace mount, worker-App token, and human git identity.
test("a codex-local run gets only the Codex credential in place of the Claude token", async () => {
  const { host } = await started(ON_CODEX);

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


// The budget adds `costUsd` and counts a run without one as unknown. Codex reports tokens, never dollars
// (TECH-5021): a priced model's tokens become an estimated cost at its list price, so the run counts
// against the budget like a Claude run's reported cost; any other model's cost stays unknown.
const codexLogs = [
  '{"type":"thread.started","thread_id":"t-1"}',
  "Reading prompt from stdin...",
  '{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":400000,"output_tokens":50000,"reasoning_output_tokens":20000}}',
  '{"type":"turn.completed","usage":{"input_tokens":10000,"cached_input_tokens":0,"output_tokens":5000,"reasoning_output_tokens":0}}',
].join("\n");

test("a Codex run on a priced model records its tokens and an estimated cost; a Claude run its reported cost", async () => {
  const codex = await ended(ON_CODEX, codexLogs);
  // M13 skips a record without `issueRevision`, so a Codex run must carry it like a Claude run (TECH-5045).
  expect(codex).toMatchObject({ status: "succeeded", provider: "openai/codex", model: "gpt-5", issueRevision: issueRevision(spec.conversation.issue) });
  expect(codex.tokens).toEqual({ input: 1_010_000, cachedInput: 400_000, output: 55_000, reasoningOutput: 20_000 });
  // gpt-5: 610k uncached input at $1.25/M, 400k cached at $0.125/M, 55k output (reasoning included) at $10/M.
  expect(codex.costBasis).toBe("estimated");
  expect(codex.costUsd).toBeCloseTo(0.7625 + 0.05 + 0.55, 6);
  expect(codex.report).not.toBeNull();

  const claude = await ended({}, '{"is_error":false,"session_id":"s","total_cost_usd":1.25,"modelUsage":{"claude-sonnet-5-5":{}}}');
  expect(claude).toMatchObject({ status: "succeeded", provider: "anthropic/claude-code", model: "claude-sonnet-5-5", costUsd: 1.25 });
  expect(claude.tokens).toBeUndefined();
  expect(claude.costBasis).toBeUndefined();
});

test("the config's Codex prices replace or add a model's; an unpriced model's cost stays unknown", async () => {
  const models = { worker: { "claude-code-local": "sonnet", "codex-local": "in-house" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } };
  const unpriced = await ended({ ...ON_CODEX, models }, codexLogs);
  expect(unpriced.tokens).toBeDefined();
  expect(unpriced.costUsd).toBeUndefined();
  expect(unpriced.costBasis).toBeUndefined();

  const priced = await ended({ ...ON_CODEX, models, codexPrices: { "in-house": { input: 1, output: 2 } } }, codexLogs);
  // No cached-input price: cached input is charged as input.
  expect(priced).toMatchObject({ costBasis: "estimated", costUsd: expect.closeTo(1.01 + 0.11, 6) });
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
  const run = await started(ON_CODEX);
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
  const run = await ended(ON_CODEX, JSON.stringify({ type: "turn.failed", error: { message } }), "");

  expect(run).toMatchObject({ status: "failed", failureReason: "authentication", reportError: expect.stringContaining("replace the account's Codex credential") });
  for (const fragment of ["sk-", "abcd", "codex-test-token", "workspace routing"]) expect(JSON.stringify(run)).not.toContain(fragment);
});

// Any other Codex failure keeps its message for the record, but with every credential it quotes
// redacted (TECH-5254): an API key, a ChatGPT access token (a JWT), and a refresh token, whether in
// ChatGPT's `rt.1.…` shape or any other shape quoted under its auth.json field name.
test("a non-auth Codex failure keeps its message but no key or token it quotes", async () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbm4ifQ.c2lnbmF0dXJlX3NlY3JldA";
  const secrets = ["sk-proj-AbC123_xyz.9", jwt, "rt.1.AAAQx9Zr_secretRefresh-Value", "rt_OpaqueRefresh42secret", "opaque-refresh-secret"];
  const message = [
    "Model gpt-5 is not available for key sk-proj-AbC123_xyz.9;",
    `stream failed with Bearer ${jwt};`,
    "retry with rt.1.AAAQx9Zr_secretRefresh-Value or rt_OpaqueRefresh42secret;",
    'auth {"refresh_token":"opaque-refresh-secret"} kept',
  ].join(" ");
  const run = await ended(ON_CODEX, JSON.stringify({ type: "turn.failed", error: { message } }), "");

  expect(run).toMatchObject({ status: "failed", report: null });
  expect(run.failureReason).toBeUndefined();
  expect(run.reportError).toBe(
    "no report written; agent exited 0 (Model gpt-5 is not available for key sk-[redacted]; stream failed with Bearer [redacted JWT]; " +
      'retry with [redacted refresh token] or [redacted refresh token]; auth {"refresh_token":"[redacted]"} kept)',
  );
  for (const secret of secrets) expect(JSON.stringify(run)).not.toContain(secret);
  for (const fragment of ["AbC123", "c2lnbmF0dXJl", "secretRefresh", "OpaqueRefresh"]) expect(JSON.stringify(run)).not.toContain(fragment);
});

test("non-auth Codex failures and unrelated stderr do not report authentication", async () => {
  // A usage limit is the account's quota (TECH-5113), which sets the account aside, never an auth alert.
  const turn = await ended(
    ON_CODEX,
    '{"type":"turn.failed","error":{"message":"The model hit its usage limit."}}',
    "",
  );
  expect(turn).toMatchObject({ status: "failed", reportError: expect.stringContaining("The model hit its usage limit."), failureReason: "quota" });

  const timeout = await started(ON_CODEX);
  timeout.host.docker.running = false;
  timeout.host.docker.exitCode = 124;
  timeout.host.docker.logErrors = "health probe returned 401 Unauthorized";
  const timedOut = await timeout.runner.status("run_t1");
  expect(timedOut).toMatchObject({ status: "failed", reportError: expect.stringContaining("wall-time limit reached") });
  expect(timedOut.failureReason).toBeUndefined();

  const success = await ended(
    ON_CODEX,
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
    REPORT,
    "an unrelated request returned 401 Unauthorized",
  );
  expect(success.status).toBe("succeeded");
  expect(success.failureReason).toBeUndefined();
});

// TECH-5259: Sergeant retries a run with no usable report and counts how often each kind happens.
test("a run's record says whether its report is missing or malformed", async () => {
  const done = '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}';
  const missing = await ended(ON_CODEX, done, "");
  expect(missing).toMatchObject({ status: "succeeded", report: null, reportProblem: "missing", reportError: expect.stringMatching(/^no report written/) });
  const malformed = await ended(ON_CODEX, done, REPORT.replace('"summary": "s", ', ''));
  expect(malformed).toMatchObject({ status: "succeeded", report: null, reportProblem: "malformed" });
  expect((await ended(ON_CODEX, done)).reportProblem).toBeUndefined();
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { QuotaReading, RunSpec } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";
import type { Exec } from "./exec.ts";
import { containerRunner } from "./runner.ts";

const SHA = "a".repeat(40);
const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: null, linkedPullRequests: [] };
const conversation = { issue, humanComments: [], agentComments: [] };
const worker: RunSpec = { runId: "run_w", role: "worker", objective: "Do it.", context: { pullRequests: [], runs: [] }, repositories: ["o/r"], conversation };
const reviewer = { runId: "run_r", role: "reviewer", repositories: ["o/r"], conversation, subject: [{ repo: "o/r", number: 9, headSha: SHA }], pullRequests: [] } as unknown as RunSpec;
const REPORT = `\`\`\`sergeant-report
{ "reportVersion": "s2-worker-report/1", "outcome": "completed", "summary": "s", "knownGaps": [], "followups": [],
  "pullRequests": [{ "repo": "o/r", "number": 9, "url": "https://github.com/o/r/pull/9", "headSha": "${SHA}", "closesIssue": true, "review": { "required": true, "reason": "r" } }] }
\`\`\`
`;

// TECH-5117 acceptance: the run record shows the chosen provider and its readings, and the reviewer of
// a worker's PR runs on the other provider. The choice happens at launch; Docker is faked.
test("a launch records its quota choice, and the worker's reviewer runs on the other provider", async () => {
  const launched: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === "docker" && args[0] === "run") launched.push(args.join(" "));
    if (cmd === "docker" && args[0] === "inspect") return { code: 0, stdout: "exited 0\n", stderr: "" };
    if (cmd === "docker" && args[0] === "logs") return { code: 0, stdout: '{"is_error":false}', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const left: Record<Adapter, [number, number]> = { "claude-code-local": [83, 90], "codex-local": [43, 90] };
  const quota = async ({ adapter }: { adapter: Adapter }): Promise<QuotaReading> => ({
    adapter,
    readAt: "2026-10-03T12:00:00.000Z",
    ...(adapter === "claude-code-local" && { source: "header-fallback" as const }),
    weekly: { remainingPercent: left[adapter][0] },
    fiveHour: { remainingPercent: left[adapter][1] },
  });
  const rootDir = await mkdtemp(join(tmpdir(), "sergeant-provider-test-"));
  const runner = containerRunner({
    rootDir,
    models: { worker: { "claude-code-local": "opus", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    adapters: { worker: "codex-local", reviewer: "codex-local" },
    claudeOAuthToken: "sk-ant-oat01-test",
    codexCredential: '{"tokens":{"access_token":"t"}}',
    quota,
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => "ghs_test",
    exec,
    fetch: (async () => Response.json({ html_url: "https://github.com/o/r/pull/9", title: "T", body: "", base: { ref: "main" } })) as typeof fetch,
  });

  await runner.start(worker);
  await writeFile(join(rootDir, "run_w", "workspace", "sergeant-report.md"), REPORT);
  const record = await runner.status("run_w");
  expect(record).toMatchObject({
    provider: "anthropic/claude-code",
    model: "opus",
    providerChoice: {
      adapter: "claude-code-local",
      readings: [{ adapter: "claude-code-local", source: "header-fallback", weekly: { remainingPercent: 83 } }, { adapter: "codex-local" }],
    },
  });
  expect(launched[0]).toContain("claude -p");

  await runner.start(reviewer);
  expect(launched[1]).toContain("codex exec");
  expect(await runner.status("run_r")).toMatchObject({ provider: "openai/codex", model: "gpt-5", providerChoice: { adapter: "codex-local" } });
});

// TECH-5113 acceptance: the run records whose account paid, only that account's credential enters
// the container, and a run that fails on the account's quota sends the next launch to the next account.
test("a run uses one account's credential, records it, and a quota failure moves the next run on", async () => {
  const env: (string | undefined)[] = [];
  let logs = '{"is_error":true,"result":"Claude AI usage limit reached|1791000000"}';
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "docker" && args[0] === "run") env.push(opts?.env?.CLAUDE_CODE_OAUTH_TOKEN);
    if (cmd === "docker" && args[0] === "inspect") return { code: 0, stdout: "exited 1\n", stderr: "" };
    if (cmd === "docker" && args[0] === "logs") return { code: 0, stdout: logs, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const ada = { id: "person:ada:claude-code-local", adapter: "claude-code-local", credential: "sk-ant-oat01-ada", group: "registered", holder: "Ada Example <ada@example.com>" } as const;
  const runner = containerRunner({
    rootDir: await mkdtemp(join(tmpdir(), "sergeant-account-test-")),
    models: { worker: { "claude-code-local": "opus", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    claudeOAuthToken: "sk-ant-oat01-installation",
    accounts: async () => [ada],
    quota: async ({ id, adapter }) => ({ adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 50 }, fiveHour: { remainingPercent: 90 } }),
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => "ghs_test",
    exec,
  });

  await runner.start(worker);
  expect(await runner.status("run_w")).toMatchObject({
    status: "failed",
    failureReason: "quota",
    account: { id: "installation-claude", group: "owner", holder: "the installation" },
    accountReason: expect.stringContaining("owner's account installation-claude"),
  });
  logs = '{"is_error":false}';
  await runner.start({ ...worker, runId: "run_w2" });
  expect(await runner.status("run_w2")).toMatchObject({ account: { id: ada.id, group: "registered", holder: "Ada Example <ada@example.com>" } });
  expect(env).toEqual(["sk-ant-oat01-installation", "sk-ant-oat01-ada"]);
});

// A terminal record keeps the launch metadata from run.json, and stays readable as written when
// run.json is malformed: run.json only adds detail.
test("a terminal record keeps the provider choice and account recorded at launch, and is read as written without them", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "sergeant-recorded-choice-test-"));
  const providerChoice = {
    adapter: "codex-local",
    reason: "more weekly quota",
    readings: [{ adapter: "codex-local", account: "installation-codex", readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 80 }, fiveHour: { remainingPercent: 90 } }],
  };
  const account = { id: "installation-codex", group: "owner", holder: "the installation" } as const;
  const ended = async (runId: string, meta: string) => {
    await mkdir(join(rootDir, runId));
    await writeFile(join(rootDir, runId, "run.json"), meta);
    // A terminal record may have been written by a process that did not yet copy the launch metadata.
    await writeFile(join(rootDir, runId, "record.json"), JSON.stringify({
      runId, role: "worker", status: "succeeded", provider: "openai/codex", model: "gpt-5", report: null,
    }));
  };
  await ended("run_done", JSON.stringify({
    runId: "run_done", role: "worker", adapter: "codex-local", model: "gpt-5", repositories: ["o/r"],
    container: "sergeant-run_done", startedAt: "2026-10-03T12:00:00.000Z", providerChoice, account,
    accountReason: "owner's account installation-codex",
  }));
  await ended("run_bad_json", "{ not json");
  await ended("run_bad_meta", JSON.stringify({ runId: "run_bad_meta", providerChoice, account }));
  const runner = containerRunner({
    rootDir,
    models: { worker: { "claude-code-local": "opus", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    claudeOAuthToken: "sk-ant-oat01-test",
    codexCredential: '{"tokens":{"access_token":"t"}}',
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => "ghs_test",
  });

  expect(await runner.status("run_done")).toMatchObject({ providerChoice, account, accountReason: "owner's account installation-codex" });
  for (const runId of ["run_bad_json", "run_bad_meta"]) {
    expect(await runner.status(runId)).toEqual({ runId, role: "worker", status: "succeeded", provider: "openai/codex", model: "gpt-5", report: null });
  }
});

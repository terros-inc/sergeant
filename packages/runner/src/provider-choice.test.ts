import { mkdtemp, writeFile } from "node:fs/promises";
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
  const quota = async (adapter: Adapter): Promise<QuotaReading> => ({
    adapter,
    readAt: "2026-10-03T12:00:00.000Z",
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
    providerChoice: { adapter: "claude-code-local", readings: [{ adapter: "claude-code-local", weekly: { remainingPercent: 83 } }, { adapter: "codex-local" }] },
  });
  expect(launched[0]).toContain("claude -p");

  await runner.start(reviewer);
  expect(launched[1]).toContain("codex exec");
  expect(await runner.status("run_r")).toMatchObject({ provider: "openai/codex", model: "gpt-5", providerChoice: { adapter: "codex-local" } });
});

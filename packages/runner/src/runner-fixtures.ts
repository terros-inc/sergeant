import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "@terros/sergeant-contracts";
import type { Exec, ExecOptions } from "./exec.ts";
import { containerRunner, type ContainerRunnerOptions } from "./runner.ts";

// The container runner under test, on a fake host and Ann's registered accounts.

// A fake host: records every command and plays Docker from `docker`. No real process is launched.
export function fakeHost() {
  const calls: { cmd: string; args: string[]; opts: ExecOptions }[] = [];
  const docker = { reachable: true, running: true, exitCode: 0, logs: "", logErrors: "" };
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd !== "docker" || args[0] === "run" || args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "logs") return { code: 0, stdout: docker.logs, stderr: docker.logErrors };
    if (!docker.reachable) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (args[0] === "stop") docker.running = false;
    const status = args.includes("{{.State.Running}}") ? String(docker.running) : `${docker.running ? "running" : "exited"} ${docker.exitCode}`;
    return { code: 0, stdout: `${status}\n`, stderr: "" };
  };
  return { calls, docker, exec };
}

export const TOKEN = "sk-ant-oat01-test-token";
export const GH = "ghs_worker-app-run-token";
export const CODEX = '{"auth_mode":"chatgpt","tokens":{"access_token":"codex-test-token"}}';
const ann = { id: "ann", name: "Ann" };
// Ann's registered accounts, and someone else's that her task must never run on (TECH-5179).
export const annClaude = { id: "person:ann:claude-code-local", adapter: "claude-code-local" as const, holder: "Ann <ann@example.com>", credential: TOKEN };
const annCodex = { id: "person:ann:codex-local", adapter: "codex-local" as const, holder: "Ann <ann@example.com>", credential: CODEX };
const registered = { ann: [annClaude, annCodex], bob: [{ ...annClaude, id: "person:bob:claude-code-local", credential: "sk-ant-oat01-bob" }] } as Record<string, (typeof annClaude | typeof annCodex)[]>;
export const spec: RunSpec = {
  runId: "run_t1",
  owner: ann,
  role: "worker",
  objective: "Do it.",
  context: { pullRequests: [], runs: [] },
  repositories: ["o/canary"],
  conversation: {
    issue: {
      id: "i1",
      identifier: "UNF-1",
      url: "https://linear.app/x/issue/UNF-1",
      title: "T",
      description: "D",
      state: "Todo",
      stateType: "unstarted",
      delegate: null,
      linkedPullRequests: [],
    },
    humanComments: [],
    agentComments: [],
  },
};

export async function started(extra: Record<string, unknown> = {}, run: RunSpec = spec) {
  const host = fakeHost();
  const minted: unknown[] = [];
  const options = {
    rootDir: await mkdtemp(join(tmpdir(), "sergeant-runner-test-")),
    models: { worker: { "claude-code-local": "sonnet", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    accounts: async (ownerId: string) => registered[ownerId] ?? [],
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async (req: unknown) => (minted.push(req), GH),
    exec: host.exec,
    ...extra,
  } as ContainerRunnerOptions;
  const runner = containerRunner(options);
  await runner.start(run);
  return { runner, host, minted, rootDir: options.rootDir };
}

export const REPORT = `Done.

\`\`\`sergeant-report
{ "reportVersion": "s2-worker-report/1", "outcome": "completed", "summary": "s", "pullRequests": [], "knownGaps": [], "followups": [] }
\`\`\`
`;

export async function ended(extra: Record<string, unknown>, logs: string, report = REPORT, logErrors = "") {
  const { runner, host, rootDir } = await started(extra);
  if (report) await writeFile(join(rootDir, "run_t1", "workspace", "sergeant-report.md"), report);
  host.docker.running = false;
  host.docker.logs = logs;
  host.docker.logErrors = logErrors;
  return runner.status("run_t1");
}

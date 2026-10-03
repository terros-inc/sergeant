import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { issueRevision, type RunSpec } from "@terros/sergeant-contracts";
import type { Exec, ExecOptions } from "./exec.ts";
import { containerRunner, type ContainerRunnerOptions } from "./runner.ts";

// A fake host: records every command and plays Docker from `docker`. No real process is launched.
function fakeHost() {
  const calls: { cmd: string; args: string[]; opts: ExecOptions }[] = [];
  const docker = { reachable: true, running: true, logs: "" };
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd !== "docker" || args[0] === "run" || args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "logs") return { code: 0, stdout: docker.logs, stderr: "" };
    if (!docker.reachable) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (args[0] === "stop") docker.running = false;
    const status = args.includes("{{.State.Running}}") ? String(docker.running) : `${docker.running ? "running" : "exited"} 0`;
    return { code: 0, stdout: `${status}\n`, stderr: "" };
  };
  return { calls, docker, exec };
}

const TOKEN = "sk-ant-oat01-test-token";
const GH = "ghs_worker-app-run-token";
const spec: RunSpec = {
  runId: "run_t1",
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

async function started(extra: Record<string, unknown> = {}) {
  const host = fakeHost();
  const minted: unknown[] = [];
  const options = {
    rootDir: await mkdtemp(join(tmpdir(), "sergeant-runner-test-")),
    models: { worker: "sonnet", reviewer: "opus" },
    claudeOAuthToken: TOKEN,
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async (req: unknown) => (minted.push(req), GH),
    exec: host.exec,
    ...extra,
  } as ContainerRunnerOptions;
  const runner = containerRunner(options);
  await runner.start(spec);
  return { runner, host, minted, rootDir: options.rootDir };
}

// The container is the hard boundary between runs and the operator's personal and control-plane
// credentials. A generic environment pass-through let any caller add a personal GH_TOKEN, AWS, or
// Linear keys. A worker's only GitHub credential is its worker-App token, scoped to its run's
// repositories. Commits are the installation's human identity: the captain forbids an agent author.
test("only the model token, the run's scoped worker-App token, and the human git identity enter", async () => {
  const { host, minted } = await started({ modelEnv: { GH_TOKEN: "ghp_x" }, env: { AWS_PROFILE: "lifeDev" } });

  expect(minted).toEqual([{ repositories: ["o/canary"], access: "write" }]);
  const run = host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  const passed = run?.args.flatMap((a, i, all) => (a === "--env" || a === "-e" ? [all[i + 1]] : [])) ?? [];
  expect(passed).toEqual([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "GIT_AUTHOR_NAME=Ada Example",
    "GIT_AUTHOR_EMAIL=ada@example.com",
    "GIT_COMMITTER_NAME=Ada Example",
    "GIT_COMMITTER_EMAIL=ada@example.com",
  ]);
  expect(run?.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, GH_TOKEN: GH });
  // No token on any command line, including the host clone, which reads it from its environment.
  expect(host.calls.flatMap((c) => c.args).join(" ")).not.toMatch(new RegExp(`${TOKEN}|${GH}`));
  const clone = host.calls.find((c) => c.cmd === "git" && c.args.includes("clone"));
  expect(clone?.opts.env?.SERGEANT_RUN_GITHUB_TOKEN).toBe(GH);
});

// `canceled` is terminal: once stored, status stops asking Docker and nothing retries the stop. If
// it were stored while Docker failed, the model would keep working with its token, unseen.
test("cancel stays retryable until Docker confirms the container stopped", async () => {
  const { runner, host } = await started();

  host.docker.reachable = false;
  await expect(runner.cancel("run_t1")).rejects.toThrow(/not confirmed/);
  host.docker.reachable = true;
  expect((await runner.status("run_t1")).status).toBe("running");

  await runner.cancel("run_t1");
  // Every record of the run names the issue text it started from, which M13 checks (TECH-5034).
  expect(await runner.status("run_t1")).toMatchObject({ status: "canceled", issueRevision: issueRevision(spec.conversation.issue) });
});

// Unknown is not death (04 §6, captain). Reading a Docker outage as "gone" would fail a worker
// that is still running and let reasoning start a second one beside it.
test("status is unavailable, not failed, while Docker cannot answer", async () => {
  const { runner, host } = await started();

  host.docker.reachable = false;
  await expect(runner.status("run_t1")).rejects.toThrow(/unavailable/);
  host.docker.reachable = true;
  expect((await runner.status("run_t1")).status).toBe("running");
});

// TECH-4994: a screenshot pasted into the description and a log attached to the issue reach the run
// as read-only files the brief names; the Linear token stays on the host; an oversized file is
// skipped with a note, never fatal.
test("gives the run the issue's files read-only, fetched on the host, skipping oversized ones", async () => {
  const shot = "https://uploads.linear.app/org/a/shot";
  const log = "https://uploads.linear.app/org/b/app.log";
  const huge = "https://files.example.com/huge.bin";
  const fetchedWithToken: string[] = [];
  const conversation = {
    ...spec.conversation,
    issue: {
      ...spec.conversation.issue,
      description: `It breaks:\n\n![image.png](${shot})`,
      attachments: [
        { id: "a1", title: "app.log", source: "upload", url: log, updatedAt: "2026-10-02T06:00:00.000Z" },
        { id: "a2", title: "huge.bin", source: null, url: huge, updatedAt: "2026-10-02T06:00:00.000Z" },
      ],
    },
  };
  const host = fakeHost();
  const rootDir = await mkdtemp(join(tmpdir(), "sergeant-runner-test-"));
  const runner = containerRunner({
    rootDir,
    models: { worker: "sonnet", reviewer: "opus" },
    claudeOAuthToken: TOKEN,
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => GH,
    exec: host.exec,
    attachmentLimits: { perFileBytes: 1024, perTaskBytes: 4096 },
    fetchUpload: async (url) => {
      fetchedWithToken.push(url);
      return url === shot ? new Response(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "image/png" } }) : new Response("ERROR boom\n");
    },
    fetchLink: async () => new Response(new Uint8Array(2048), { headers: { "content-type": "application/octet-stream" } }),
  });
  await runner.start({ ...spec, conversation });

  expect(fetchedWithToken).toEqual([log, shot]);
  const files = join(rootDir, "run_t1", "attachments");
  expect(await readFile(join(files, "01-app.log"), "utf8")).toBe("ERROR boom\n");
  expect((await readFile(join(files, "02-shot.png"))).length).toBe(2);
  const run = host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  expect(run?.args).toContain(`${files}:/workspace/.sergeant/attachments:ro`);
  const brief = await readFile(join(rootDir, "run_t1", "workspace", "sergeant-brief.md"), "utf8");
  expect(brief).toContain("`/workspace/.sergeant/attachments/02-shot.png` — image/png");
  expect(brief).toContain(`${huge} ("huge.bin") — not downloaded: over the`);
});

const CODEX = '{"auth_mode":"chatgpt","tokens":{"access_token":"codex-test-token"}}';
const envNames = (args: string[] = []) => args.flatMap((a, i, all) => (a === "--env" ? [all[i + 1]] : []));

// TECH-5009: a role on Codex gets the Codex credential in place of the Claude token, never both, and
// otherwise the same container: workspace mount, worker-App token, and human git identity.
test("a codex-local run gets only the Codex credential in place of the Claude token", async () => {
  const { host } = await started({ adapters: { worker: "codex-local" }, codexCredential: CODEX });

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
  expect(run?.args.slice(-3)).toEqual(["3600", "sonnet", "10"]);
  expect(host.calls.flatMap((c) => c.args).join(" ")).not.toContain("codex-test-token");
  expect(() => containerRunner({ ...({} as ContainerRunnerOptions), rootDir: "/x", claudeOAuthToken: TOKEN, adapters: { reviewer: "codex-local" } })).toThrow(
    /codexCredential/,
  );
});

const REPORT = `Done.

\`\`\`sergeant-report
{ "reportVersion": "s2-worker-report/1", "outcome": "completed", "summary": "s", "pullRequests": [], "knownGaps": [], "followups": [] }
\`\`\`
`;

async function ended(extra: Record<string, unknown>, logs: string, report = REPORT) {
  const { runner, host, rootDir } = await started(extra);
  if (report) await writeFile(join(rootDir, "run_t1", "workspace", "sergeant-report.md"), report);
  host.docker.running = false;
  host.docker.logs = logs;
  return runner.status("run_t1");
}

// The budget adds `costUsd` and counts a run without one as unknown. Codex reports tokens, never
// dollars: a guessed figure would understate or overstate spend, so its cost stays absent.
test("a Codex run records its summed tokens and no cost; a Claude run its reported cost", async () => {
  const codexLogs = [
    '{"type":"thread.started","thread_id":"t-1"}',
    "Reading prompt from stdin...",
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50,"reasoning_output_tokens":20}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join("\n");
  const codex = await ended({ adapters: { worker: "codex-local" }, codexCredential: CODEX }, codexLogs);
  // M13 skips a record without `issueRevision`, so a Codex run must carry it like a Claude run (TECH-5045).
  expect(codex).toMatchObject({ status: "succeeded", provider: "openai/codex", model: "sonnet", issueRevision: issueRevision(spec.conversation.issue) });
  expect(codex.tokens).toEqual({ input: 1010, cachedInput: 400, output: 55, reasoningOutput: 20 });
  expect(codex.costUsd).toBeUndefined();
  expect(codex.report).not.toBeNull();

  const failed = await ended({ adapters: { worker: "codex-local" }, codexCredential: CODEX }, '{"type":"turn.failed","error":{"message":"401: Incorrect API key provided: sk-proj***abcd."}}', "");
  expect(failed).toMatchObject({ status: "failed", issueRevision: issueRevision(spec.conversation.issue), reportError: expect.stringContaining("401: Incorrect API key provided: sk-[redacted]") });
  expect(JSON.stringify(failed)).not.toContain("abcd");

  const claude = await ended({}, '{"is_error":false,"session_id":"s","total_cost_usd":1.25,"modelUsage":{"claude-sonnet-5-5":{}}}');
  expect(claude).toMatchObject({ status: "succeeded", provider: "anthropic/claude-code", model: "claude-sonnet-5-5", costUsd: 1.25 });
  expect(claude.tokens).toBeUndefined();
});

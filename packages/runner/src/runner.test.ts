import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunSpec } from "@terros/sergeant-contracts";
import type { Exec, ExecOptions } from "./exec.ts";
import { containerRunner, type ContainerRunnerOptions } from "./runner.ts";

// A fake host: records every command and plays Docker from `docker`. No real process is launched.
function fakeHost() {
  const calls: { cmd: string; args: string[]; opts: ExecOptions }[] = [];
  const docker = { reachable: true, running: true };
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd !== "docker" || args[0] === "run" || args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
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
  return { runner, host, minted };
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
  expect((await runner.status("run_t1")).status).toBe("canceled");
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

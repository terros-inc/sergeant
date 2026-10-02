// The long-running Sergeant 2 service (UNF-719): works every open Linear issue delegated to the V2
// agent, unattended, until stopped. Manual only, never run by tests or CI: like the canary, it reads
// and writes live Linear and GitHub, launches real model sessions, and costs money. From
// v2/packages/sergeant, after building the runner image (`docker build -t sergeant-runner:local ../runner/container`):
//
//   node src/serve.ts --config <installation.json> --state-dir <dir> [--port 8080] [--host 127.0.0.1] [--max-tasks 2]
//
// Every repository in the installation config is enrolled. Credentials come from the config's secret
// references exactly as for the canary (canary.ts). SIGINT or SIGTERM stops intake and lets each task
// loop end at its next poll; a second signal exits at once. `GET /health` reports the process alive.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RepoSlug } from "@terros/sergeant-contracts";
import { claudeCliReasoner } from "@terros/sergeant-reasoning";
import { containerRunner } from "@terros/sergeant-runner";
import { connect, loadConfig } from "./config.ts";
import { startService } from "./service.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "state-dir": { type: "string" },
    port: { type: "string", default: "8080" },
    host: { type: "string", default: "127.0.0.1" },
    "max-tasks": { type: "string", default: "2" },
    "intake-seconds": { type: "string", default: "120" },
    "poll-seconds": { type: "string", default: "60" },
    "reasoning-model": { type: "string", default: "opus" },
    "worker-model": { type: "string", default: "opus" },
    "reviewer-model": { type: "string", default: "opus" },
  },
});

const config = await loadConfig(values.config ?? fail("--config is required"));
const stateDir = resolve(values["state-dir"] ?? fail("--state-dir is required"));
const repositories = Object.keys(config.repositories).map((r) => RepoSlug.parse(r));

const installation = await connect(config, repositories);
// The reasoning CLI inherits this process's environment: with the token set it authenticates as
// Sergeant's model profile rather than the operator's own Claude login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = installation.modelToken;

const service = await startService(
  {
    enrolledRepositories: repositories,
    stateDir,
    port: count(values.port, "--port", 0),
    host: values.host,
    maxTasks: count(values["max-tasks"], "--max-tasks", 1),
    intakeSeconds: count(values["intake-seconds"], "--intake-seconds", 1),
    pollSeconds: count(values["poll-seconds"], "--poll-seconds", 1),
  },
  {
    linear: installation.linear,
    agentUserId: installation.agentUserId,
    workerLogin: installation.workerLogin,
    github: installation.github,
    runner: containerRunner({
      rootDir: join(stateDir, "runs"),
      models: { worker: values["worker-model"], reviewer: values["reviewer-model"] },
      claudeOAuthToken: installation.modelToken,
      gitIdentity: config.gitIdentity,
      githubTokens: installation.githubTokens,
    }),
    reasoner: claudeCliReasoner({ model: values["reasoning-model"] }),
    delegatedIssues: () => installation.linear.delegatedIssues(installation.agentUserId),
  },
);
console.log(`Sergeant serving ${repositories.join(", ")}; GET http://${values.host}:${service.port}/health`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: stopping after each task's current step`);
    process.once(signal, () => process.exit(1));
    void service.stop().then(() => process.exit(0));
  });
}

function count(value: string, flag: string, min: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fail(`${flag} must be an integer of at least ${min}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

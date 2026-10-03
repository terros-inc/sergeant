// The long-running Sergeant 2 service (UNF-719): works every open Linear issue delegated to the V2
// agent, unattended, until stopped. Manual only, never run by tests or CI: like the canary, it reads
// and writes live Linear and GitHub, launches real model sessions, and costs money. From
// packages/sergeant, after building the runner image (`docker build -t sergeant-runner:local ../runner/container`):
//
//   node src/serve.ts --config <installation.json> --state-dir <dir> [--port 8080] [--host 127.0.0.1] [--max-tasks 2] [--waiting-grace-minutes 15] [--trust-loopback]
//
// Every repository in the installation config is enrolled. Credentials come from the config's secret
// references exactly as for the canary (canary.ts). `--max-tasks` and `--waiting-grace-minutes`, when
// given, win over the config's `maxTasks` and `waitingGraceMinutes` (TECH-5008). SIGINT or SIGTERM
// stops intake and lets each task loop end at its next poll; a second signal exits at once. `GET /health` reports only
// whether it is healthy; `GET /status` adds its tasks and latest intake, for loopback only. With the
// config's webhook secrets, `POST /webhooks/linear` and `/webhooks/github` wake tasks early. The client
// API admits the Linear users the config's `humans` names (auth.ts); `--trust-loopback` also admits an
// operator on this host with no login, for development, and is refused unless `--host` is 127.0.0.1 or ::1.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RepoSlug, sergeantVersion } from "@terros/sergeant-contracts";
import { linearUser } from "@terros/sergeant-linear";
import { claudeCliFeedbackJudge, claudeCliReasoner } from "@terros/sergeant-reasoning";
import { containerRunner, reasoningFiles } from "@terros/sergeant-runner";
import { linearCallers } from "./auth.ts";
import { connect, loadConfig, runnerRoles, taskBudget } from "./config.ts";
import { startService } from "./service.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "state-dir": { type: "string" },
    port: { type: "string", default: "8080" },
    host: { type: "string", default: "127.0.0.1" },
    "max-tasks": { type: "string" },
    "waiting-grace-minutes": { type: "string" },
    "intake-seconds": { type: "string", default: "120" },
    "poll-seconds": { type: "string", default: "60" },
    "reasoning-model": { type: "string", default: "opus" },
    "worker-model": { type: "string" },
    "reviewer-model": { type: "string" },
    "trust-loopback": { type: "boolean", default: false },
  },
});

const config = await loadConfig(values.config ?? fail("--config is required"));
const stateDir = resolve(values["state-dir"] ?? fail("--state-dir is required"));
const repositories = Object.keys(config.repositories).map((r) => RepoSlug.parse(r));

const installation = await connect(config, repositories);
// The reasoning CLI inherits this process's environment: with the token set it authenticates as
// Sergeant's model profile rather than the operator's own Claude login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = installation.modelToken;

// An explicit flag wins, then the config, then the service's default (2 slots, 15 minutes).
const maxTasks = values["max-tasks"] !== undefined ? count(values["max-tasks"], "--max-tasks", 1) : config.maxTasks;
const waitingGraceMinutes =
  values["waiting-grace-minutes"] !== undefined ? count(values["waiting-grace-minutes"], "--waiting-grace-minutes", 0) : config.waitingGraceMinutes;

const service = await startService(
  {
    enrolledRepositories: repositories,
    stateDir,
    port: count(values.port, "--port", 0),
    host: values.host,
    ...(maxTasks !== undefined && { maxTasks }),
    ...(waitingGraceMinutes !== undefined && { waitingGraceMinutes }),
    intakeSeconds: count(values["intake-seconds"], "--intake-seconds", 1),
    pollSeconds: count(values["poll-seconds"], "--poll-seconds", 1),
    budget: taskBudget(config),
    auditSampleRate: config.review.auditSampleRate,
    webhookSecrets: installation.webhookSecrets,
    trustLoopback: values["trust-loopback"],
    ...(config.humans && {
      humans: {
        linearClientId: config.humans.linearClientId,
        callerOf: linearCallers({
          humans: config.humans,
          organizationId: installation.linearOrganizationId,
          agentUserIds: [installation.agentUserId, ...config.linear.otherAgentUserIds],
          lookup: (token) => linearUser(token),
        }),
      },
    }),
  },
  {
    linear: installation.linear,
    agentUserId: installation.agentUserId,
    workerLogin: installation.workerLogin,
    github: installation.github,
    runner: containerRunner({
      rootDir: join(stateDir, "runs"),
      ...runnerRoles(config, { worker: values["worker-model"], reviewer: values["reviewer-model"] }),
      claudeOAuthToken: installation.modelToken,
      ...(installation.codexCredential !== undefined && { codexCredential: installation.codexCredential }),
      gitIdentity: config.gitIdentity,
      githubTokens: installation.githubTokens,
      fetchUpload: installation.linear.fetchUpload,
    }),
    reasoner: claudeCliReasoner({
      model: values["reasoning-model"],
      files: (s) => reasoningFiles(s.conversation, { fetchUpload: installation.linear.fetchUpload }),
    }),
    delegatedIssues: () => installation.linear.delegatedIssues(installation.agentUserId),
    feedback: {
      completedIssues: (since) => installation.linear.completedIssues(installation.agentUserId, since),
      issueProgress: (issueId) => installation.linear.issueProgress(issueId),
      judge: claudeCliFeedbackJudge({ model: values["reasoning-model"] }),
    },
    undelegate: (issueId) => installation.linear.undelegate(issueId),
  },
);
const { version, fallback } = sergeantVersion();
console.log(`Sergeant ${version}${fallback ? ` (${fallback})` : ""} serving ${repositories.join(", ")}; GET http://${values.host}:${service.port}/health`);

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

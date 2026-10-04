// The long-running Sergeant 2 service (UNF-719): works every open Linear issue delegated to the V2
// agent, unattended, until stopped. Manual only, never run by tests or CI: like the canary, it reads
// and writes live Linear and GitHub, launches real model sessions, and costs money. From
// packages/sergeant, after building the runner image (`docker build -t sergeant-runner:local ../runner/container`):
//
//   node src/serve.ts --config <installation.json> --state-dir <dir> [--port 8080] [--host 127.0.0.1] [--max-tasks 2] [--waiting-grace-minutes 15] [--config-parameter <SSM name>] [--trust-loopback]
//
// Every repository in the installation config is enrolled. With `--config-parameter` (else the host's
// `SERGEANT_CONFIG_PARAMETER`), the installation-config SSM parameter `--config` was installed from, the
// enrolled repositories are that parameter's, read at startup, and an approver can change them with
// `sgt admin repo add|remove`, which serve takes in place (enrollment.ts). Credentials come from the config's secret
// references exactly as for the canary (canary.ts). `--max-tasks` and `--waiting-grace-minutes`, when
// given, win over the config's `maxTasks` and `waitingGraceMinutes` (TECH-5008). SIGINT or SIGTERM
// stops intake and lets each task loop end at its next poll; a second signal exits at once. `GET /health` reports only
// whether it is healthy; `GET /status` adds its tasks and latest intake, for loopback only. With the
// config's webhook secrets, `POST /webhooks/linear` and `/webhooks/github` wake tasks early. The client
// API admits the Linear users the config's `humans` names (auth.ts); `--trust-loopback` also admits an
// operator on this host with no login, for development, and is refused unless `--host` is 127.0.0.1 or ::1.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RepoSlug, sergeantVersion } from "@terros/sergeant-contracts";
import { linearUser } from "@terros/sergeant-linear";
import { claudeCliFeedbackJudge, claudeCliReasoner, claudeCliRetro } from "@terros/sergeant-reasoning";
import { containerRunner, reasoningFiles } from "@terros/sergeant-runner";
import { modelAccounts } from "./accounts.ts";
import { linearCallers } from "./auth.ts";
import { connect, loadConfig, reviewerProfileLookup, runnerRoles, taskBudget } from "./config.ts";
import { appsReach, configParameter, enrolledIn, enrollment } from "./enrollment.ts";
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
    "config-parameter": { type: "string" },
    "trust-loopback": { type: "boolean", default: false },
  },
});

const configFile = values.config ?? fail("--config is required");
const config = await loadConfig(configFile);
// On the host, Terraform creates the registered-accounts secret and names it here (TECH-5204).
const hostRegisteredAccounts = process.env.SERGEANT_REGISTERED_ACCOUNTS_SECRET;
if (!config.registeredAccountsSecret && hostRegisteredAccounts) config.registeredAccountsSecret = hostRegisteredAccounts;
const configParameterName = values["config-parameter"] ?? process.env.SERGEANT_CONFIG_PARAMETER;
const parameter = configParameterName ? configParameter(config, configParameterName) : undefined;
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
// The parameter is the only record of an approver's change: a restart before the next update keeps it.
// Its version serve has is the one install.sh recorded with `--config` unless that copy is current (TECH-5206).
const started = parameter && (await enrolledIn(parameter, log, { config: JSON.parse(await readFile(configFile, "utf8")), version: await installedVersion(configFile) }));
if (started) config.repositories = started.repositories;
const stateDir = resolve(values["state-dir"] ?? fail("--state-dir is required"));
const repositories = Object.keys(config.repositories).map((r) => RepoSlug.parse(r));

const installation = await connect(config, repositories);
// People's registered model accounts: a task's runs use only its owner's (TECH-5179).
const accounts = modelAccounts(config, log);
// The reasoning CLI inherits this process's environment: with the token set it authenticates as
// Sergeant's model profile rather than the operator's own Claude login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = installation.modelToken;

// An explicit flag wins, then the config, then the service's default (2 slots, 15 minutes).
const maxTasks = values["max-tasks"] !== undefined ? count(values["max-tasks"], "--max-tasks", 1) : config.maxTasks;
const waitingGraceMinutes =
  values["waiting-grace-minutes"] !== undefined ? amount(values["waiting-grace-minutes"], "--waiting-grace-minutes", 0) : config.waitingGraceMinutes;

const { version, fallback } = sergeantVersion();
// On the Sergeant host, where sergeant-update records its release, approvers restart and update it
// through `/v1/admin` (TECH-5195): its automatic-update service takes their requests (deploy/README.md).
const release = "/etc/sergeant/release";
const enrolled = enrollment({
  repositories,
  configs: installation.repositoryConfigs,
  parameter,
  version: started?.version,
  reach: appsReach({ "control-plane": installation.controlPlaneApp, worker: installation.workerApp }),
  log,
});
const admin = existsSync(release)
  ? {
      requestFile: join(stateDir, "admin-request.json"),
      resultFile: "/etc/sergeant/admin-result.json",
      releaseFile: release,
      serve: { version, startedAt: new Date().toISOString() },
      config: enrolled.versions,
    }
  : undefined;

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
    accounts: accounts.registry,
    ...(admin && { admin }),
    enrollment: enrolled,
    ...(config.humans && {
      humans: {
        linearClientId: config.humans.linearClientId,
        callerOf: linearCallers({
          humans: config.humans,
          organizationId: installation.linearOrganizationId,
          agentUserIds: [installation.agentUserId, ...config.linear.otherAgentUserIds],
          lookup: (token) => linearUser(token),
        }),
        approverNames: () => installation.linear.userNames(config.humans?.approvers ?? []),
      },
    }),
  },
  {
    linear: installation.linear,
    agentUserId: installation.agentUserId,
    workerLogin: installation.workerLogin,
    linearProfileForGitHubLogin: reviewerProfileLookup(config),
    github: installation.github,
    runner: containerRunner({
      rootDir: join(stateDir, "runs"),
      ...runnerRoles(config, { worker: values["worker-model"], reviewer: values["reviewer-model"] }),
      ...accounts.runner,
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
    // Sergeant's own reasoning on its model token, on this host: never a worker's capacity (TECH-5187).
    ...(config.retro && {
      retro: {
        linear: installation.linear.retro,
        reasoning: claudeCliRetro({ model: values["reasoning-model"] }),
        agentUserId: installation.agentUserId,
        ...config.retro,
      },
    }),
  },
);
console.log(`Sergeant ${version}${fallback ? ` (${fallback})` : ""} serving ${repositories.join(", ")}; GET http://${values.host}:${service.port}/health`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: stopping after each task's current step`);
    process.once(signal, () => process.exit(1));
    void service.stop().then(() => process.exit(0));
  });
}

/** The parameter's version install.sh recorded beside `file` when it installed it; undefined when there is none. */
async function installedVersion(file: string): Promise<number | undefined> {
  const n = Number((await readFile(`${file}.version`, "utf8").catch(() => "")).trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function count(value: string, flag: string, min: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fail(`${flag} must be an integer of at least ${min}`);
}

function amount(value: string, flag: string, min: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fail(`${flag} must be a number of at least ${min}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

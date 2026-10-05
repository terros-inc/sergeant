// The live canary: one explicitly selected Linear issue, delegated to Sergeant's V2 agent, through the
// whole loop. It stops before any new effect once the issue is undelegated or delegated elsewhere.
// Manual only, never run by tests or CI: it reads and writes live Linear and GitHub, launches real
// model sessions, and costs money. From packages/sergeant, after building the runner image
// (`docker build -t sergeant-runner:local ../runner/container`):
//
//   node src/canary.ts --config <installation.json> --issue UNF-723 --repo owner/name --dir <state dir>
//
// Every credential comes from the installation config's secret references (config.ts), none is
// printed, and no ambient login is used:
// - Linear: the V2 agent app's token, control plane only, verified to act as `linear.agentUserId`.
//   It reads the conversation, files follow-up issues, and posts the one outcome comment after the merge.
// - GitHub: the control-plane App reads facts and merges; workers push and open PRs with a worker-App
//   token scoped to their run's repositories. There is no operator `gh` login and no bridge.
// - Model: the Sergeant model token, for reasoning here. Worker and reviewer containers use only the
//   task owner's registered accounts (TECH-5179): the issue's assignee, who must have delegated it.
import { resolve } from "node:path";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RepoSlug } from "@terros/sergeant-contracts";
import { claudeCliReasoner } from "@terros/sergeant-reasoning";
import { containerRunner, reasoningFiles } from "@terros/sergeant-runner";
import { modelAccounts } from "./accounts.ts";
import { connect, githubLoginLookup, loadConfig, reviewerProfileLookup, runnerRoles, taskBudget } from "./config.ts";
import { runLoop } from "./loop.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    issue: { type: "string" },
    repo: { type: "string" },
    dir: { type: "string" },
    "reasoning-model": { type: "string", default: "opus" },
    "worker-model": { type: "string" },
    "reviewer-model": { type: "string" },
    /**
     * The task's budget window (UNF-728): hard wall time, and best-effort spend. Fixed when the task
     * starts. Each flag given overrides the installation config's `budget` (TECH-4964).
     */
    "budget-minutes": { type: "string" },
    "budget-usd": { type: "string" },
  },
});

const config = await loadConfig(values.config ?? fail("--config is required"));
const issueId = values.issue ?? fail("--issue is required");
const repo = RepoSlug.parse(values.repo ?? fail("--repo is required"));
const dir = resolve(values.dir ?? fail("--dir is required"));

const installation = await connect(config, [repo]);
// People's registered model accounts: a task's runs use only its owner's (TECH-5179).
const accounts = modelAccounts(config, (line) => console.log(`[${new Date().toISOString()}] ${line}`));
// The reasoning CLI inherits this process's environment: with the token set it authenticates as
// Sergeant's model profile rather than the operator's own Claude login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = installation.modelToken;

const result = await runLoop(
  {
    issueId,
    enrolledRepositories: [repo],
    dir,
    auditSampleRate: config.review.auditSampleRate,
    progressComments: config.review.progressComments,
    budget: {
      ...taskBudget(config),
      ...(values["budget-minutes"] !== undefined && { wallMinutes: positive(values["budget-minutes"], "--budget-minutes") }),
      ...(values["budget-usd"] !== undefined && { costUsd: positive(values["budget-usd"], "--budget-usd") }),
    },
  },
  {
    linear: installation.linear,
    agentUserId: installation.agentUserId,
    workerLogin: installation.workerLogin,
    linearProfileForGitHubLogin: reviewerProfileLookup(config),
    githubLoginForLinearProfile: githubLoginLookup(config),
    github: installation.github,
    runner: containerRunner({
      rootDir: join(dir, "runs"),
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
  },
);
console.log(`CANARY RESULT ${JSON.stringify(result)}`);
process.exit(result.outcome === "done" ? 0 : 1);

function positive(value: string, flag: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fail(`${flag} must be a positive number`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

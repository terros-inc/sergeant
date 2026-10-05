import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { GitHubPort, RepoSlug, RunGitHubTokens, RunSpec } from "@terros/sergeant-contracts";
import { cachedToken, createGitHubPort, githubApp, runTokens, type GitHubApp } from "@terros/sergeant-github";
import { createLinearPort } from "@terros/sergeant-linear";
import { FargateSettings, type Adapter } from "@terros/sergeant-runner";
import type { z } from "zod";
import type { BudgetWindow } from "./budget.ts";
import { type GitHubAppRef, InstallationConfig } from "./config-schema.ts";

export { InstallationConfig } from "./config-schema.ts";

// What serve and canary do with the installation config (config-schema.ts): load it, resolve its
// secret references, and build the effectors it names.

type Role = RunSpec["role"];

/**
 * Each role's configured adapter, and its model on each adapter, for `containerRunner` (TECH-5009). A
 * role's model flag is for its configured adapter; otherwise Codex runs `codex.model` and Claude Code
 * "opus", today's default. When the owner has an account for the other provider, quota may run a role
 * on the other adapter (TECH-5117). With them, the config's Codex prices (TECH-5021).
 */
export function runnerRoles(config: InstallationConfig, modelFlags: Record<Role, string | undefined>) {
  const adapter = (role: Role): Adapter => config.runners?.[role] ?? "claude-code-local";
  const models = (role: Role): Record<Adapter, string> => {
    const flag = (a: Adapter) => (a === adapter(role) ? modelFlags[role] : undefined);
    return { "claude-code-local": flag("claude-code-local") ?? "opus", "codex-local": flag("codex-local") ?? config.codex?.model ?? "opus" };
  };
  return {
    adapters: { worker: adapter("worker"), reviewer: adapter("reviewer") },
    models: { worker: models("worker"), reviewer: models("reviewer") },
    ...(config.codex?.prices && { codexPrices: config.codex.prices }),
  };
}

/**
 * Where the Fargate runner's tasks run, from the file install.sh writes (deploy/host/install.sh), when
 * `runners.workerBackend` is `fargate`, or when the file exists, so runs started on Fargate before the
 * setting changed back are still read and collected there. Undefined when neither.
 */
export async function fargateSettings(config: InstallationConfig, file: string): Promise<FargateSettings | undefined> {
  const required = config.runners?.workerBackend === "fargate";
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" && !required) return undefined;
    throw new Error(`runners.workerBackend is fargate, but ${file} cannot be read (deploy/README.md, "Workers on Fargate"): ${e.message}`);
  });
  return text === undefined ? undefined : FargateSettings.parse(JSON.parse(text));
}

/** The config's `budget` as a loop's budget option: a task started from now on gets it; a running one keeps its own. */
export function taskBudget(config: InstallationConfig): Partial<BudgetWindow> {
  const { minutes, usd } = config.budget ?? {};
  return { ...(minutes !== undefined && { wallMinutes: minutes }), ...(usd !== undefined && { costUsd: usd }) };
}

/** Configured reviewer identity lookup. GitHub logins are case-insensitive. */
export function reviewerProfileLookup(config: InstallationConfig): (login: string) => string | undefined {
  const profiles = new Map(Object.entries(config.linear.reviewerProfiles).map(([login, url]) => [login.toLowerCase(), url]));
  return (login) => profiles.get(login.toLowerCase());
}

/** The reverse lookup (TECH-5244): the GitHub login whose configured Linear profile URL this is. */
export function githubLoginLookup(config: InstallationConfig): (profileUrl: string) => string | undefined {
  const logins = new Map(Object.entries(config.linear.reviewerProfiles).map(([login, url]) => [url.toLowerCase(), login]));
  return (profileUrl) => logins.get(profileUrl.toLowerCase());
}

export async function loadConfig(file: string): Promise<InstallationConfig> {
  return InstallationConfig.parse(JSON.parse(await readFile(file, "utf8")));
}

export const run = promisify(execFile);

export function secretResolver(config: InstallationConfig) {
  const { awsRegion, awsProfile } = config.secrets;
  return async (ref: string): Promise<string> => {
    const { stdout } = await run("aws", [
      "secretsmanager", "get-secret-value", "--secret-id", ref, "--query", "SecretString", "--output", "text",
      "--region", awsRegion, ...(awsProfile ? ["--profile", awsProfile] : []),
    ]);
    const value = stdout.trim();
    if (!value) throw new Error(`secret ${ref} is empty`);
    return value;
  };
}

export type Installation = {
  linear: ReturnType<typeof createLinearPort>;
  /** The V2 agent's Linear user, verified against the token. */
  agentUserId: string;
  /** The Linear workspace the agent is in: the only one whose users may call the API. */
  linearOrganizationId: string;
  /** The worker App's GitHub login: only a PR it opened is ever this task's (M2). */
  workerLogin: string;
  github: GitHubPort;
  controlPlaneApp: GitHubApp;
  workerApp: GitHubApp;
  githubTokens: RunGitHubTokens;
  modelToken: string;
  /** Webhook signing secrets, for the sources the config gives one. */
  webhookSecrets: { linear?: string; github?: string };
  /** The enrolled repositories' settings `github` reads at each call: changed in place with `repositories` (enrollment.ts). */
  repositoryConfigs: Record<RepoSlug, InstallationConfig["repositories"][string]>;
};

/**
 * Resolves every secret reference and builds the direct effectors for `repositories`. The effectors read
 * `repositories` and the returned `repositoryConfigs` live, so enrollment.ts can change them in place.
 */
export async function connect(config: InstallationConfig, repositories: RepoSlug[]): Promise<Installation> {
  const enrolled = repositories.map((r) => [r, config.repositories[r]] as const);
  const unknown = enrolled.filter(([, c]) => !c).map(([r]) => r);
  if (unknown.length > 0) throw new Error(`not enrolled in the installation config: ${unknown.join(", ")}`);
  const secret = secretResolver(config);
  const optional = (ref: string | undefined) => (ref === undefined ? undefined : secret(ref));
  const [linearToken, controlPlaneKey, workerKey, modelToken, linearWebhook, githubWebhook] = await Promise.all([
    secret(config.linear.tokenSecret),
    secret(config.github.controlPlaneApp.privateKeySecret),
    secret(config.github.workerApp.privateKeySecret),
    secret(config.modelTokenSecret),
    optional(config.linear.webhookSecret),
    optional(config.github.webhookSecret),
  ]);
  const app = (ref: z.infer<typeof GitHubAppRef>, privateKey: string) =>
    githubApp({ appId: ref.appId, installationId: ref.installationId, privateKey });
  const controlPlaneApp = app(config.github.controlPlaneApp, controlPlaneKey);
  const workerApp = app(config.github.workerApp, workerKey);
  // A Linear API key (`lin_api_`) is sent as is; an OAuth token, such as the V2 agent app's, as Bearer.
  const linearAuthorization = linearToken.startsWith("lin_api_") ? linearToken : `Bearer ${linearToken}`;

  const { agentUserId, otherAgentUserIds, delegatingAppIds } = config.linear;
  const linear = createLinearPort({ apiKey: linearAuthorization, sergeantUserIds: [agentUserId, ...otherAgentUserIds], delegatingAppIds });
  // Every Linear read and write uses this one token, so it must be the V2 agent: a V1 or personal
  // token would let Sergeant act as someone else.
  const viewer = await linear.viewer();
  if (viewer.id !== agentUserId) throw new Error(`the Linear token acts as ${viewer.name} (${viewer.id}), not the configured V2 agent`);

  const workerLogin = await workerApp.login();
  const repositoryConfigs = Object.fromEntries(enrolled.flatMap(([r, c]) => (c ? [[r, c]] : [])));
  // The control plane's token covers exactly the enrolled repositories, so a change mints a new one.
  let scoped: { key: string; token: () => Promise<string> } | undefined;
  const controlPlaneToken = () => {
    const key = repositories.join(" ");
    if (scoped?.key !== key) scoped = { key, token: cachedToken(() => controlPlaneApp.mint({ repositories: [...repositories] })) };
    return scoped.token();
  };

  return {
    linear,
    agentUserId,
    linearOrganizationId: viewer.organizationId,
    workerLogin,
    github: createGitHubPort({ token: controlPlaneToken, repositories: repositoryConfigs }),
    controlPlaneApp,
    workerApp,
    githubTokens: runTokens(workerApp),
    modelToken,
    webhookSecrets: { ...(linearWebhook && { linear: linearWebhook }), ...(githubWebhook && { github: githubWebhook }) },
    repositoryConfigs,
  };
}

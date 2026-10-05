import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { RepoSlug, type GitHubPort, type RunGitHubTokens, type RunSpec } from "@terros/sergeant-contracts";
import { cachedToken, createGitHubPort, githubApp, runTokens, type GitHubApp } from "@terros/sergeant-github";
import { createLinearPort } from "@terros/sergeant-linear";
import { ADAPTERS, type Adapter } from "@terros/sergeant-runner";
import { z } from "zod";
import type { BudgetWindow } from "./budget.ts";

// One installation's V2 identities and enrolled repositories (10 §2, UNF-720): identifiers and
// secret references only. Secret references are AWS Secrets Manager ids, resolved at startup and
// never printed. Nothing installation-specific or personal lives in code.

const LITERAL_CREDENTIAL = /^(lin_(api|oauth|wh)_|gh[pousr]_|github_pat_|sk-)/;
const SecretRef = z
  .string()
  .regex(/^[\w/+=.@:-]+$/, "expected a Secrets Manager secret id or ARN")
  .refine((s) => !LITERAL_CREDENTIAL.test(s), "expected a secret reference, not a credential");

const GitHubAppRef = z.strictObject({
  /** Canonicalized to a number, so `42` and `"42"` name the same App. */
  appId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/).transform(Number)]),
  installationId: z.number().int().positive(),
  privateKeySecret: SecretRef,
});

export const InstallationConfig = z.strictObject({
  secrets: z.strictObject({ awsRegion: z.string().min(1), awsProfile: z.string().min(1).optional() }),
  linear: z.strictObject({
    /** The V2 Linear agent app's token. It must act as `agentUserId`. */
    tokenSecret: SecretRef,
    /**
     * The V2 agent app's Linear user: Sergeant works on an issue only while it is delegated to this
     * user, and acts in Linear only as it. Its comments are not human input.
     */
    agentUserId: z.string().min(1),
    /** Other Linear users that act for agents (V1's, say): their comments are not human input either. */
    otherAgentUserIds: z.array(z.string().min(1)).default([]),
    /**
     * Linear app ids (`botActor.id`) whose delegations count as the assignee's own when the app acted
     * for a user with the assignee's display name: Linear's MCP connector, so issues filed for the owner
     * through it are admitted (TECH-5192). Every other app's delegation is refused.
     */
    delegatingAppIds: z.array(z.string().min(1)).default([]),
    /** GitHub reviewer login to Linear profile URL; Linear renders the URL as a notifying mention. */
    reviewerProfiles: z
      .record(
        z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "expected a GitHub login"),
        z.string().regex(/^https:\/\/linear\.app\/[^/]+\/profiles\/[^/?#]+$/, "expected a Linear profile URL"),
      )
      .default({}),
    /** The Linear app webhook's signing secret; without it serve has no Linear webhook endpoint. */
    webhookSecret: SecretRef.optional(),
  }),
  github: z
    .strictObject({
      /** Reads facts and merges (08 §1). Held only by the control plane. */
      controlPlaneApp: GitHubAppRef,
      /** Its key only mints each run's scoped token; workers push and open PRs as this App. */
      workerApp: GitHubAppRef,
      /** The control-plane App webhook's secret; without it serve has no GitHub webhook endpoint. */
      webhookSecret: SecretRef.optional(),
    })
    // Repository rules tell GitHub App actors apart, not Sergeant's labels: one App in both roles
    // would let workers merge as the control plane.
    .refine((g) => g.controlPlaneApp.appId !== g.workerApp.appId, {
      message: "controlPlaneApp and workerApp must be different GitHub Apps",
      path: ["workerApp", "appId"],
    }),
  repositories: z.record(
    RepoSlug,
    z.strictObject({
      mergeMethod: z.enum(["merge", "squash", "rebase"]),
      /** See `GitHubRepositoryConfig.observedChecksFallback`. Off unless set. */
      observedChecksFallback: z.boolean().default(false),
    }),
  ),
  /** The Sergeant model token for reasoning; never a worker's or reviewer's (TECH-5179). */
  modelTokenSecret: SecretRef,
  /** The installation's human commit identity; never an agent's. */
  gitIdentity: z.strictObject({ name: z.string().min(1), email: z.email() }),
  /**
   * Who may use the client API and `sgt` (TECH-4938), each signing in with their own Linear login.
   * Absent, the API accepts no Linear caller, only `serve --trust-loopback`'s operator on the host.
   */
  humans: z
    .strictObject({
      /** The installation's Linear OAuth app's client id. Public: served to `sgt login`, never a secret. */
      linearClientId: z.string().min(1),
      /** Keys of the Linear teams whose active members may use the API. */
      teams: z.array(z.string().min(1)).min(1),
      /** Linear user ids of the approvers; they too must be in one of `teams`. */
      approvers: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  /**
   * How the host follows main (deploy/README.md, Automatic updates; TECH-4959): main's head once its
   * v2 check passed, or the newest green main commit that has been on main `soakMinutes`. Read by the
   * host's `sergeant-autoupdate`, not by serve. Absent or `paused`, the host never updates itself.
   */
  release: z
    .discriminatedUnion("channel", [
      z.strictObject({ channel: z.literal("main"), paused: z.boolean().optional() }),
      z.strictObject({
        channel: z.literal("soaked"),
        soakMinutes: z.number().int().positive(),
        paused: z.boolean().optional(),
      }),
    ])
    .optional(),
  review: z
    .strictObject({
      /** The fraction of merged heads that skipped fresh review which get a nonblocking audit review (06 §8). */
      auditSampleRate: z.number().min(0).max(1),
    })
    .default({ auditSampleRate: 0.2 }),
  /** The budget window a task gets when it starts (TECH-4964); each one unset keeps its default (120 minutes, $25). */
  budget: z.strictObject({ minutes: z.number().positive().optional(), usd: z.number().positive().optional() }).optional(),
  /** Task slots `serve` fills at once (TECH-5008, superseding TECH-4988); `serve --max-tasks` wins, and without either it is 2. */
  maxTasks: z.number().int().positive().optional(),
  /** Minutes a waiting task keeps its slot; `serve --waiting-grace-minutes` wins, and without either it is 15. */
  waitingGraceMinutes: z.number().nonnegative().optional(),
  /** The agent CLI each role runs (TECH-5009). A role not named runs Claude Code, as it always has. */
  runners: z.strictObject({ worker: z.enum(ADAPTERS).optional(), reviewer: z.enum(ADAPTERS).optional() }).optional(),
  /** The installation's Codex login, required when `runners` names `codex-local`. */
  codex: z
    .strictObject({
      /**
       * Secrets Manager id of the Codex credential: the JSON of the `auth.json` a `codex login` with the
       * installation's own ChatGPT workspace account writes, or an OpenAI API key. Never a personal login.
       */
      credentialSecret: SecretRef,
      /** The model Codex runs for a Codex role, unless `serve`/`canary` names that role's model. */
      model: z.string().min(1),
    })
    .optional(),
  /**
   * Ignored since TECH-5179, kept only so an existing config still loads (`serve` warns): runs use only
   * their task owner's registered accounts, never an installation's or owner's. Each person registers
   * their own with `sgt account register`. Was TECH-5113's owner's further accounts.
   */
  modelAccounts: z
    .array(
      z.strictObject({
        name: z
          .string()
          .regex(/^[\w.-]{1,64}$/, "expected a short name: letters, digits, _ . -")
          .refine((n) => !n.startsWith("installation-"), "installation-claude and installation-codex name the two accounts above"),
        adapter: z.enum(ADAPTERS),
        credentialSecret: SecretRef,
      }),
    )
    .default([]),
  /**
   * Secrets Manager id of the one secret that holds the accounts people register with `sgt account
   * register` (TECH-5113), created by the operator as `{"accounts":[]}`; the host must be able to put
   * its value. Absent, nobody can register an account.
   */
  registeredAccountsSecret: SecretRef.optional(),
})
  .refine((c) => c.codex || !Object.values(c.runners ?? {}).includes("codex-local"), {
    message: "a codex-local runner needs the codex credential",
    path: ["codex"],
  })
  .refine((c) => c.codex || !c.modelAccounts.some((a) => a.adapter === "codex-local"), {
    message: "a codex-local model account needs the codex config, for its model",
    path: ["modelAccounts"],
  })
  .refine((c) => new Set(c.modelAccounts.map((a) => a.name)).size === c.modelAccounts.length, {
    message: "model account names must be distinct",
    path: ["modelAccounts"],
  });
export type InstallationConfig = z.infer<typeof InstallationConfig>;

type Role = RunSpec["role"];

/**
 * Each role's configured adapter, and its model on each adapter, for `containerRunner` (TECH-5009). A
 * role's model flag is for its configured adapter; otherwise Codex runs `codex.model` and Claude Code
 * "opus", today's default. With a Codex credential, quota may run a role on the other adapter (TECH-5117).
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
  };
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
  /** The Codex credential, when the config has one. */
  codexCredential?: string;
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
  const [linearToken, controlPlaneKey, workerKey, modelToken, linearWebhook, githubWebhook, codexCredential] = await Promise.all([
    secret(config.linear.tokenSecret),
    secret(config.github.controlPlaneApp.privateKeySecret),
    secret(config.github.workerApp.privateKeySecret),
    secret(config.modelTokenSecret),
    optional(config.linear.webhookSecret),
    optional(config.github.webhookSecret),
    optional(config.codex?.credentialSecret),
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
    ...(codexCredential !== undefined && { codexCredential }),
    webhookSecrets: { ...(linearWebhook && { linear: linearWebhook }), ...(githubWebhook && { github: githubWebhook }) },
    repositoryConfigs,
  };
}

import { RepoSlug } from "@terros/sergeant-contracts";
import { ADAPTERS } from "@terros/sergeant-runner";
import { z } from "zod";

// One installation's V2 identities and enrolled repositories (10 §2, UNF-720): identifiers and
// secret references only. Secret references are AWS Secrets Manager ids, resolved at startup and
// never printed. Nothing installation-specific or personal lives in code.

const LITERAL_CREDENTIAL = /^(lin_(api|oauth|wh)_|gh[pousr]_|github_pat_|sk-)/;
const SecretRef = z
  .string()
  .regex(/^[\w/+=.@:-]+$/, "expected a Secrets Manager secret id or ARN")
  .refine((s) => !LITERAL_CREDENTIAL.test(s), "expected a secret reference, not a credential");

export const GitHubAppRef = z.strictObject({
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
      /** TECH-5227: a short progress comment on the issue after each review round (progress.ts). */
      progressComments: z.boolean().default(true),
    })
    .default({ auditSampleRate: 0.2, progressComments: true }),
  /** The budget window a task gets when it starts (TECH-4964); each one unset keeps its default (120 minutes, $25). */
  budget: z.strictObject({ minutes: z.number().positive().optional(), usd: z.number().positive().optional() }).optional(),
  /**
   * The Sergeant retro (TECH-5187, retro.ts): the Linear project it posts each retro to as a document and
   * files its issues in, in Backlog, and the team it files them in. Absent, no retro runs.
   */
  retro: z.strictObject({ projectId: z.string().min(1), teamId: z.string().min(1) }).optional(),
  /** Task slots `serve` fills at once (TECH-5008, superseding TECH-4988); `serve --max-tasks` wins, and without either it is 2. */
  maxTasks: z.number().int().positive().optional(),
  /** Minutes a waiting task keeps its slot; `serve --waiting-grace-minutes` wins, and without either it is 15. */
  waitingGraceMinutes: z.number().nonnegative().optional(),
  /** The agent CLI each role runs (TECH-5009). A role not named runs Claude Code, as it always has. */
  runners: z.strictObject({ worker: z.enum(ADAPTERS).optional(), reviewer: z.enum(ADAPTERS).optional() }).optional(),
  /**
   * The model Codex runs for a Codex role, unless `serve`/`canary` names that role's model. Required when
   * `runners` names `codex-local`; without it nobody can register a Codex account. The credential is
   * always the task owner's registered account (TECH-5179), never the installation's (TECH-5184).
   */
  codex: z.strictObject({ model: z.string().min(1) }).optional(),
  /**
   * Secrets Manager id of the one secret that holds the accounts people register with `sgt account
   * register` (TECH-5113), holding `{"accounts":[]}` at first; the host must be able to put its value.
   * On the host, Terraform creates it and `serve` defaults to it (`SERGEANT_REGISTERED_ACCOUNTS_SECRET`,
   * TECH-5204). Absent, nobody can register an account.
   */
  registeredAccountsSecret: SecretRef.optional(),
})
  .refine((c) => c.codex || !Object.values(c.runners ?? {}).includes("codex-local"), {
    message: "a codex-local runner needs the codex config, for its model",
    path: ["codex"],
  });
export type InstallationConfig = z.infer<typeof InstallationConfig>;

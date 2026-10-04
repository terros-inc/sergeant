import { z } from "zod";
import { BudgetStatus } from "./budget.ts";
import { RepoSlug } from "./conversation.ts";
import { QuotaReading, RunAccount, RunId, RunRecord } from "./runs.ts";
import { FiledFollowup } from "./situation.ts";

// The client API (11 §2, UNF-713): what `serve` answers on `/v1` and `sgt` and `sgt-mcp` read. The
// server validates request bodies with these schemas and its clients (client.ts) validate responses
// with them, so they cannot drift silently. Only a minimal slice exists: task and run reads, wake, and cancel. Every
// `/v1` call but `GET /v1/auth/config` names its caller: a Linear user's OAuth token as a bearer
// (`sgt login`), or, only where `serve --trust-loopback` allows it, an operator on the host itself.

/** A Linear issue identifier, the only task reference there is yet. */
export const TaskRef = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, "expected a Linear issue identifier such as UNF-123");
export type TaskRef = z.infer<typeof TaskRef>;

export const ApiError = z.object({
  error: z.object({ code: z.enum(["bad_request", "unauthorized", "not_found", "forbidden", "conflict", "unavailable"]), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * `active`: its loop is running. `queued`: delegated, waiting for a free task slot. Otherwise how its
 * loop last ended in this process, `merged` when its closing PR merged before that, or `inactive`.
 */
export const TaskStatus = z.enum(["active", "queued", "done", "merged_not_done", "stopped", "accepted", "idle", "failed", "merged", "inactive"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskSummary = z.object({
  ref: TaskRef,
  status: TaskStatus,
  /** How its loop last ended, when it has in this process. */
  statusDetail: z.string().optional(),
  startedAt: z.string().optional(),
  turns: z.number().int(),
  lastTurnAt: z.string().optional(),
  lastSummary: z.string().optional(),
  runs: z.number().int(),
  merged: z.object({ repo: RepoSlug, number: z.number().int(), mergedSha: z.string(), at: z.string() }).optional(),
  /**
   * A human accepted the work as it is and the task's ending is still pending: its loop replays it every
   * pass until it finishes (TECH-5136), then sets the task aside. `since` is the accepting turn's time.
   */
  acceptedEnding: z.object({ since: z.string() }).optional(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

/** A run as the runner reports it now; `unknown` when its status cannot be read (04 §6). */
export const RunSummary = z.object({
  runId: RunId,
  task: TaskRef,
  role: z.enum(["worker", "reviewer"]).optional(),
  status: z.enum(["running", "succeeded", "failed", "canceled", "unknown"]),
  model: z.string().optional(),
  costUsd: z.number().optional(),
  /** Whose model account it ran on (TECH-5113). */
  account: z.string().optional(),
  /** The report's summary, or why there is no report. */
  summary: z.string().optional(),
  /** Why the status could not be read. */
  error: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const TaskList = z.object({ tasks: z.array(TaskSummary) });
export type TaskList = z.infer<typeof TaskList>;

export const TaskDetail = z.object({
  task: TaskSummary,
  /** The issue as Linear has it now, or why it could not be read. */
  issue: z.union([
    z.object({ title: z.string(), state: z.string(), url: z.string(), delegatedToSergeant: z.boolean(), delegate: z.string().nullable() }),
    z.object({ error: z.string() }),
  ]),
  budget: BudgetStatus.extend({ exhausted: z.string().optional() }).optional(),
  runs: z.array(RunSummary),
  recentTurns: z.array(z.object({ at: z.string(), summary: z.string(), outcomes: z.array(z.string()) })),
  followups: z.array(FiledFollowup),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const RunList = z.object({ runs: z.array(RunSummary) });
export type RunList = z.infer<typeof RunList>;

export const RunDetail = z.object({ task: TaskRef, run: RunRecord });
export type RunDetail = z.infer<typeof RunDetail>;

export const WakeRequest = z.strictObject({ reason: z.string().optional() });
/** `active`: its running loop polls now. `admitted`: its loop started. `queued`: it starts at the next free slot. */
export const WakeResponse = z.object({ ref: TaskRef, woke: z.enum(["active", "admitted", "queued"]) });
export type WakeResponse = z.infer<typeof WakeResponse>;

export const CancelTaskRequest = z.strictObject({
  reason: z.string().trim().min(1, "a reason is required"),
  /** Names this request: a retry with the same id posts no second comment. */
  requestId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
/** A worker PR a task cancel closed. */
export const ClosedPullRequest = z.object({ repo: RepoSlug, number: z.number().int().positive(), url: z.url() });
export type ClosedPullRequest = z.infer<typeof ClosedPullRequest>;
export const CancelTaskResponse = z.object({
  ref: TaskRef,
  /** This request removed Sergeant's delegation. */
  undelegated: z.boolean(),
  /** Runs not yet confirmed stopped: Sergeant keeps canceling them. Empty once the cancel is done. */
  stopping: z.array(RunId),
  /**
   * The task's worker PRs its stop closed so far, across every drive of it. PRs are closed only once
   * every run is stopped, so more may follow while `stopping` is not empty.
   */
  closedPullRequests: z.array(ClosedPullRequest),
});
export type CancelTaskResponse = z.infer<typeof CancelTaskResponse>;

export const CancelRunRequest = z.strictObject({ reason: z.string().optional() });
export const CancelRunResponse = z.object({ runId: RunId, task: TaskRef, status: RunSummary.shape.status });
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

/** What `sgt login` needs to start a Linear OAuth login: public, served without a caller. */
export const LoginConfig = z.object({ linear: z.object({ clientId: z.string().min(1) }) });
export type LoginConfig = z.infer<typeof LoginConfig>;

export const WhoAmI = z.object({
  /** `linear`: the caller's own Linear OAuth token. `loopback`: an operator on the host (`serve --trust-loopback`). */
  auth: z.enum(["linear", "loopback"]),
  /** The Linear user; null for a loopback operator. */
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  /** One of the installation's configured approvers; a loopback operator always is. */
  approver: z.boolean(),
  enrolledRepositories: z.array(RepoSlug),
});
export type WhoAmI = z.infer<typeof WhoAmI>;

// --- model accounts (TECH-5113)

/** The agent CLI a model account serves: a Claude login for Claude Code, a ChatGPT login for Codex. */
export const AccountAdapter = z.enum(["claude-code-local", "codex-local"]);
export type AccountAdapter = z.infer<typeof AccountAdapter>;

/** The provider names people type and see for the adapters (TECH-5196). */
export const Provider = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof Provider>;
export const PROVIDER_ADAPTER: Record<Provider, AccountAdapter> = { claude: "claude-code-local", codex: "codex-local" };
export const providerOf = (adapter: AccountAdapter): Provider => (adapter === "codex-local" ? "codex" : "claude");

/** A model account's name, unique among one person's accounts (TECH-5196); it defaults to the provider's name. */
export const AccountName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "an account name is up to 40 letters, digits, - and _, starting with a letter or digit");

/** A model account Sergeant may run on, without its credential, and the runs it paid for. */
export const AccountSummary = RunAccount.extend({
  adapter: AccountAdapter,
  name: z.string(),
  /** The caller registered it, so may remove it. */
  mine: z.boolean(),
  registeredAt: z.string().optional(),
  /** Runs of the tasks Sergeant knows that used it: dollars where the CLI reported them, else counted as unknown. */
  usage: z.object({ runs: z.number().int(), costUsd: z.number(), unknownCostRuns: z.number().int() }),
});
export type AccountSummary = z.infer<typeof AccountSummary>;

export const AccountList = z.object({ accounts: z.array(AccountSummary) });
export type AccountList = z.infer<typeof AccountList>;

/**
 * A person's own subscription login for the provider, under a name of theirs: the token
 * `claude setup-token` prints, or the JSON of the `auth.json` a `codex login` writes. Stored in the
 * installation's Secrets Manager; never echoed, logged, or returned.
 */
export const RegisterAccountRequest = z.strictObject({
  provider: Provider,
  name: AccountName,
  credential: z.string().trim().min(1, "a credential is required").max(32_000, "credential too long"),
});
export const RegisterAccountResponse = z.object({
  account: AccountSummary.omit({ usage: true }),
  /** It replaced the caller's earlier account of this name. */
  replaced: z.boolean(),
  /** The quota read with it at registration, which proved it works. */
  quota: QuotaReading,
  /** What the person accepts by registering (09 §3a): their credential is exposed to worker containers, and how to remove and rotate it. */
  notice: z.string(),
});
export type RegisterAccountResponse = z.infer<typeof RegisterAccountResponse>;

export const RemoveAccountRequest = z.strictObject({ name: AccountName });
export const RemoveAccountResponse = z.object({ name: z.string(), removed: z.boolean() });
export type RemoveAccountResponse = z.infer<typeof RemoveAccountResponse>;

/**
 * Offboarding (TECH-5130): an approver removes every model account a person registered, by their
 * Linear user id. Runs already on one finish on it; removing it does not revoke a copy.
 */
export const RemovePersonAccountsRequest = z.strictObject({ userId: z.string().trim().min(1, "a Linear user id is required").max(200) });
export const RemovePersonAccountsResponse = z.object({
  userId: z.string(),
  removed: z.array(RunAccount.pick({ id: true, holder: true }).extend({ adapter: AccountAdapter })),
});
export type RemovePersonAccountsResponse = z.infer<typeof RemovePersonAccountsResponse>;

import type { RepoSlug } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import type { Reasoner } from "@terros/sergeant-reasoning";
import type { AccountRegistry } from "./accounts.ts";
import type { HostAdmin } from "./api-admin.ts";
import type { Caller } from "./auth.ts";
import type { BudgetWindow } from "./budget.ts";
import type { Enrollment } from "./enrollment.ts";
import type { Ports } from "./execute.ts";
import type { FeedbackDeps } from "./feedback.ts";

export type ServiceOptions = {
  /** Every holder reads this same array, so `enrollment` changes it in place. */
  enrolledRepositories: RepoSlug[];
  /** Holds `tasks/<issue identifier>/`, one task loop's directory each. */
  stateDir: string;
  /** Task slots: tasks running or waiting within the grace; further delegated issues wait for a free one. */
  maxTasks?: number;
  /** How long a waiting task (on a human or anything else) keeps its slot before the next task in order gets it. */
  waitingGraceMinutes?: number;
  intakeSeconds?: number;
  /** Each task loop's poll interval, and how long it stays with nothing changing and nothing running. */
  pollSeconds?: number;
  idleMinutes?: number;
  /** The budget window of a task that starts; a task already started keeps its stored one (loop.ts). */
  budget?: Partial<BudgetWindow>;
  /** Each task loop's audit sample rate (loop.ts); omitted, the loop's default. */
  auditSampleRate?: number;
  /** Minutes between post-merge feedback sweeps (feedback.ts), when `deps.feedback` is given. */
  feedbackSweepMinutes?: number;
  /** How long after work lands its feedback is still watched. */
  feedbackLookbackDays?: number;
  /** Port for `GET /health` and `GET /status`; omitted, no server. 0 picks a free one. */
  port?: number;
  /** Interface the server listens on: loopback unless set. Never publish `/status`. */
  host?: string;
  /** Webhook signing secrets: each source with one gets its `POST /webhooks/<source>` endpoint. */
  webhookSecrets?: { linear?: string; github?: string };
  /** The least time between two webhook wakes of one task loop, or of intake (`Wake.nudge`). */
  webhookGapSeconds?: number;
  /**
   * Who may call the client API with a Linear login, the client id `sgt login` uses (auth.ts), and the
   * approvers' names, which `whoami` tells people to ask (TECH-5202).
   */
  humans?: { callerOf: (accessToken: string) => Promise<Caller>; linearClientId: string; approverNames?: () => Promise<string[]> };
  /** The model accounts, and people's registrations of their own, for `/v1/accounts` (TECH-5113). */
  accounts?: AccountRegistry;
  /** On the Sergeant host: approvers restart and update it through `/v1/admin` (TECH-5195). */
  admin?: HostAdmin;
  /** Lists and changes `enrolledRepositories` in place, for `/v1/repositories` (TECH-5193). */
  enrollment?: Enrollment;
  /** Trusts a loopback caller with no login as an operator: for development on one machine, refused unless `host` is 127.0.0.1 or ::1. */
  trustLoopback?: boolean;
  log?: (line: string) => void;
};

export type ServiceDeps = Ports & {
  reasoner: Reasoner;
  /** Open issues delegated to the V2 agent, with their status, priority, and creation time: only to discover new work in Todo. */
  delegatedIssues: () => Promise<DelegatedIssue[]>;
  /** Removes the issue's delegation to the V2 agent: a human's cancel through the API. */
  undelegate?: (issueId: string) => Promise<void>;
  /** Reads and judgment for post-merge feedback; without them, feedback on landed work is not swept. */
  feedback?: Pick<FeedbackDeps, "completedIssues" | "issueProgress" | "judge">;
};

export type Service = {
  /** Where `GET /health` listens, once started. */
  port: number | undefined;
  /** Stops intake and resolves once every task loop has ended at its next poll. */
  stop(): Promise<void>;
};

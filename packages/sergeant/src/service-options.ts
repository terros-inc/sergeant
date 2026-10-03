import type { RepoSlug } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import type { Reasoner } from "@terros/sergeant-reasoning";
import type { Caller } from "./auth.ts";
import type { BudgetWindow } from "./budget.ts";
import type { Ports } from "./execute.ts";
import type { FeedbackDeps } from "./feedback.ts";

export type ServiceOptions = {
  enrolledRepositories: RepoSlug[];
  /** Holds `tasks/<issue identifier>/`, one task loop's directory each. */
  stateDir: string;
  /** Task slots: tasks running or waiting within the grace; further delegated issues wait for a free one. */
  maxTasks?: number;
  /** How long a waiting task keeps its slot before the next task in order gets it. */
  waitingGraceMinutes?: number;
  intakeSeconds?: number;
  /** Each task loop's poll interval, and how long it stays with nothing changing and nothing running. */
  pollSeconds?: number;
  idleMinutes?: number;
  /** The budget window of a task that starts; a task already started keeps its stored one. */
  budget?: Partial<BudgetWindow>;
  auditSampleRate?: number;
  feedbackSweepMinutes?: number;
  feedbackLookbackDays?: number;
  /** Port for the HTTP server; omitted, no server. Zero picks a free one. */
  port?: number;
  /** Interface the server listens on: loopback unless set. Never publish `/status`. */
  host?: string;
  webhookSecrets?: { linear?: string; github?: string };
  webhookGapSeconds?: number;
  humans?: { callerOf: (accessToken: string) => Promise<Caller>; linearClientId: string };
  trustLoopback?: boolean;
  log?: (line: string) => void;
};

export type ServiceDeps = Ports & {
  reasoner: Reasoner;
  delegatedIssues: () => Promise<DelegatedIssue[]>;
  undelegate?: (issueId: string) => Promise<void>;
  feedback?: Pick<FeedbackDeps, "completedIssues" | "issueProgress" | "judge">;
};

export type Service = {
  port: number | undefined;
  stop(): Promise<void>;
};

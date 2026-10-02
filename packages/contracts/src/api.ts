import { z } from "zod";
import { BudgetStatus } from "./budget.ts";
import { RepoSlug } from "./conversation.ts";
import { RunId, RunRecord } from "./runs.ts";
import { FiledFollowup } from "./situation.ts";

// The client API (11 §2, UNF-713): what `serve` answers on `/v1` and the `sgt` CLI reads. The server
// validates request bodies with these schemas and the CLI validates responses with them, so the two
// cannot drift silently. Only a minimal slice exists: task and run reads, wake, and cancel.

/** A Linear issue identifier, the only task reference there is yet. */
export const TaskRef = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, "expected a Linear issue identifier such as UNF-123");
export type TaskRef = z.infer<typeof TaskRef>;

export const ApiError = z.object({
  error: z.object({ code: z.enum(["bad_request", "not_found", "forbidden", "conflict", "unavailable"]), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * `active`: its loop is running. `queued`: delegated, waiting for a free task slot. Otherwise how its
 * loop last ended in this process, `merged` when its closing PR merged before that, or `inactive`.
 */
export const TaskStatus = z.enum(["active", "queued", "done", "merged_not_done", "stopped", "turn_limit", "idle", "failed", "merged", "inactive"]);
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
export const CancelTaskResponse = z.object({
  ref: TaskRef,
  /** This request removed Sergeant's delegation. */
  undelegated: z.boolean(),
  /** Runs not yet confirmed stopped: Sergeant keeps canceling them. Empty once the cancel is done. */
  stopping: z.array(RunId),
});
export type CancelTaskResponse = z.infer<typeof CancelTaskResponse>;

export const CancelRunRequest = z.strictObject({ reason: z.string().optional() });
export const CancelRunResponse = z.object({ runId: RunId, task: TaskRef, status: RunSummary.shape.status });
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

export const WhoAmI = z.object({
  /** Nobody until client auth exists (UNF-718): the API answers loopback callers only. */
  user: z.null(),
  auth: z.literal("loopback"),
  enrolledRepositories: z.array(RepoSlug),
});
export type WhoAmI = z.infer<typeof WhoAmI>;

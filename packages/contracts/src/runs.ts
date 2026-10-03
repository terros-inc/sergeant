import { z } from "zod";
import { RepoSlug } from "./conversation.ts";

export const RunId = z.string().regex(/^run_[\w-]+$/);
export type RunId = z.infer<typeof RunId>;

const FAIL_SAFE = "fail-safe: missing or unjustified skip, so review is required";

/**
 * The worker's call on whether a PR head needs fresh review. Fails toward review: a missing or
 * unparseable recommendation, or a skip without a reason, reads as `required: true` (05 §5).
 */
export const ReviewRecommendation = z
  .object({ required: z.boolean(), reason: z.string().default("") })
  .transform((r) => (!r.required && r.reason.trim() === "" ? { required: true, reason: FAIL_SAFE } : r))
  .catch({ required: true, reason: FAIL_SAFE });
export type ReviewRecommendation = z.infer<typeof ReviewRecommendation>;

/** A PR head as a report names it. SHAs are kept as written; the Gate compares them exactly. */
const ReportedPr = { repo: RepoSlug, number: z.number().int().positive(), headSha: z.string() };

/**
 * Inputs the issue depends on that the run could not read (an auth-gated link, a missing file or
 * attachment), each named as the issue names it. Sergeant must ask a human about each before it
 * merges (M14).
 */
const UnreadableInputs = z.array(z.string()).optional();

export const WorkerReport = z.object({
  reportVersion: z.literal("s2-worker-report/1"),
  outcome: z.enum(["completed", "partial", "blocked", "needs_decision", "failed"]).catch("partial"),
  summary: z.string(),
  pullRequests: z
    .array(
      z.object({
        ...ReportedPr,
        url: z.url(),
        /**
         * Required: a report that omits it is malformed, never read as "Part of" (UNF-734). Only a
         * closing PR's merge completes the task, so a silent false would strand a one-PR task.
         */
        closesIssue: z.boolean(),
        review: ReviewRecommendation,
      }),
    )
    .default([]),
  knownGaps: z.array(z.string()).default([]),
  unreadableInputs: UnreadableInputs,
  /** Out-of-scope work the worker found; Sergeant's reasoning decides whether to file it. */
  followups: z.array(z.object({ title: z.string(), why: z.string().default("") })).default([]),
  /**
   * How the worker answered earlier review findings (01 `FindingResolution`), each named by its
   * review run and finding id. Only telemetry reads it (`ReviewFacts.resultingMutation`), so a
   * malformed list reads as absent rather than failing the report.
   */
  addressedFindings: z
    .array(z.object({ reviewRunId: RunId, findingId: z.string(), resolution: z.enum(["fixed", "disputed"]), reason: z.string().default("") }))
    .optional()
    .catch(undefined),
});
export type WorkerReport = z.infer<typeof WorkerReport>;

export const Finding = z.object({
  id: z.string().min(1),
  severity: z.enum(["blocking", "non_blocking", "nit"]),
  description: z.string(),
  location: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewReport = z.object({
  reportVersion: z.literal("s2-review-report/1"),
  reviewed: z.array(z.object(ReportedPr)).min(1),
  verdict: z.enum(["approve", "changes_requested", "needs_human"]),
  findings: z.array(Finding).default([]),
  unreadableInputs: UnreadableInputs,
  summary: z.string(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

const RunBase = {
  runId: RunId,
  status: z.enum(["running", "succeeded", "failed", "canceled"]),
  provider: z.string(),
  model: z.string(),
  /** The model cost the run reported when it ended, in USD; absent while running or when not reported. */
  costUsd: z.number().nonnegative().optional(),
  /** Why the report is null: missing, malformed, or failed validation. */
  reportError: z.string().optional(),
  /**
   * The `issueRevision` of the title and description the run started from, as the runner recorded it.
   * Absent on records made before TECH-5034.
   */
  issueRevision: z.string().optional(),
};

/** One worker or reviewer run as the runner reports it. A reviewer is always its own fresh run. */
export const RunRecord = z.discriminatedUnion("role", [
  z.object({ ...RunBase, role: z.literal("worker"), report: WorkerReport.nullable() }),
  z.object({ ...RunBase, role: z.literal("reviewer"), report: ReviewReport.nullable() }),
]);
export type RunRecord = z.infer<typeof RunRecord>;

export type ParsedReport<T> = { ok: true; report: T } | { ok: false; error: string };

/**
 * Parses the one fenced `sergeant-report` JSON block that ends a run's Markdown report (05 §6).
 * Anything else (no block, several, bad JSON, wrong shape) is an error, never a guess.
 */
export function parseReport<T>(markdown: string, schema: z.ZodType<T>): ParsedReport<T> {
  const blocks = [...markdown.matchAll(/^```sergeant-report[^\n]*\n([\s\S]*?)^```/gm)];
  const body = blocks.length === 1 ? blocks[0]?.[1] : undefined;
  if (body === undefined) {
    return { ok: false, error: `expected one sergeant-report block, found ${blocks.length}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `sergeant-report block is not JSON: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

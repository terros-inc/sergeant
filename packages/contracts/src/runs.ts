import { z } from "zod";
import { RepoSlug } from "./conversation.ts";

export const RunId = z.string().regex(/^run_[\w-]+$/);
export type RunId = z.infer<typeof RunId>;

/** The only reasons a follow-up issue may be filed (07 §11, TECH-5186). */
export const FollowupCategory = z.enum(["concrete_bug", "required_unfinished_work", "real_blocker", "operational_or_security"]);
export type FollowupCategory = z.infer<typeof FollowupCategory>;

/**
 * A machine-readable terminal failure that Sergeant handles outside ordinary agent reasoning. On
 * either, the runner sets the run's model account aside, so the next launch takes the next one (TECH-5113).
 */
export const RunFailureReason = z.enum(["authentication", "quota"]);
export type RunFailureReason = z.infer<typeof RunFailureReason>;

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

/**
 * TECH-5278: dependencies between this task's issue and another that the run noticed (shared files, an
 * ordering, one PR building on another): `blocked_by` when this issue waits for `issue`, `blocks` when
 * `issue` must wait for this one. Sergeant's reasoning records each as a Linear "blocked by" relation
 * (`record_blocked_by`). A malformed list reads as absent rather than failing the report.
 */
const Dependencies = z
  .array(z.object({ issue: z.string(), relation: z.enum(["blocked_by", "blocks"]), why: z.string().default("") }))
  .optional()
  .catch(undefined);

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
  dependencies: Dependencies,
  /**
   * A concrete bug, required unfinished work, a real blocker, or a current operational or security
   * problem the worker found, each with its category and why; more than one is exceptional. Sergeant's
   * reasoning decides whether to file it (TECH-5186). A missing or unknown category reads as absent
   * rather than failing the report.
   */
  followups: z
    .array(z.object({ title: z.string(), category: FollowupCategory.optional().catch(undefined), why: z.string().default("") }))
    .default([]),
  /**
   * Everything else worth knowing across tasks: friction, possible improvements, things that might
   * recur, non-blocking review notes left as they are (TECH-5186). Never filed as an issue; a later
   * retro reads it from the run's record. A malformed list reads as absent rather than failing the report.
   */
  feedback: z.array(z.string()).optional().catch(undefined),
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

/**
 * TECH-5259: a reviewer's report is read forgivingly where the meaning is unambiguous, since one that
 * fails to parse leaves its head with no review standing and costs a whole rerun: a spelling of a
 * verdict or severity (`Approve`, `non-blocking`), a missing finding id or report version. Never toward
 * a merge: an unknown severity reads as blocking, and an unknown verdict or a missing reviewed head
 * still rejects the report.
 */
const token = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v);
const VERDICTS: Record<string, string> = { approved: "approve", request_changes: "changes_requested", changes_required: "changes_requested" };
const SEVERITIES: Record<string, string> = { nonblocking: "non_blocking", nitpick: "nit" };

export const Finding = z.object({
  id: z.string().min(1),
  severity: z.preprocess((v) => SEVERITIES[token(v) as string] ?? token(v), z.enum(["blocking", "non_blocking", "nit"])).catch("blocking"),
  /** An unmet or contradicted requirement; ordinary implementation defects omit this. */
  category: z.preprocess((v) => (typeof v === "string" && /acceptance/i.test(v) ? "acceptance" : undefined), z.literal("acceptance").optional()),
  description: z.string(),
  location: z.string().optional().catch(undefined),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewReport = z.object({
  reportVersion: z.literal("s2-review-report/1").catch("s2-review-report/1"),
  reviewed: z.array(z.object({ ...ReportedPr, number: z.coerce.number().int().positive() })).min(1),
  verdict: z.preprocess((v) => VERDICTS[token(v) as string] ?? token(v), z.enum(["approve", "changes_requested", "needs_human"])),
  /** A finding without an id gets its place in the list (`f1`, `f2`, …), or the next one no other finding has. */
  findings: z
    .array(z.looseObject({ id: z.unknown().optional() }))
    .default([])
    .transform((list) => {
      const ids = list.map((f) => (typeof f.id === "number" || (typeof f.id === "string" && f.id.trim()) ? String(f.id) : undefined));
      const taken = new Set(ids);
      return list.map((f, i) => {
        let n = i + 1;
        while (ids[i] === undefined && taken.has(`f${n}`)) n++;
        const id = ids[i] ?? `f${n}`;
        taken.add(id);
        return { ...f, id };
      });
    })
    .pipe(z.array(Finding)),
  unreadableInputs: UnreadableInputs,
  dependencies: Dependencies,
  summary: z.string().default(""),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

/** One quota window as its provider reports it: the percent left and, when known, when it resets. */
const QuotaWindow = z.object({ remainingPercent: z.number(), resetsAt: z.string().optional() });
/** A quota window as a person names it. */
export const QuotaWindowName = z.enum(["weekly", "5-hour"]);
export type QuotaWindowName = z.infer<typeof QuotaWindowName>;

/**
 * A provider's quota as read just before a launch (TECH-5117): its weekly and 5-hour windows, or why
 * they could not be read. A reading without both windows is unknown.
 */
export const QuotaReading = z.object({
  adapter: z.string(),
  /** The model account read (TECH-5113); absent on records made before it. */
  account: z.string().optional(),
  readAt: z.string(),
  /** How Claude quota was obtained; absent on older records and other providers. */
  source: z.enum(["usage-endpoint", "header-fallback"]).optional(),
  weekly: QuotaWindow.optional(),
  fiveHour: QuotaWindow.optional(),
  error: z.string().optional(),
});
export type QuotaReading = z.infer<typeof QuotaReading>;

/** Which provider a run got and the quota readings behind it, for telemetry and `/sarge`. */
export const ProviderChoice = z.object({
  adapter: z.string(),
  reason: z.string(),
  readings: z.array(QuotaReading),
  /** A reviewer that runs on its worker's provider, because the other one was unusable. */
  sameProviderAsWorker: z.boolean().optional(),
});
export type ProviderChoice = z.infer<typeof ProviderChoice>;

/**
 * The model account a run used (TECH-5113): whose subscription paid for it. `registered`, one a person
 * registered with `sgt`, the task owner's (TECH-5179); `owner`, the installation's own, only on records
 * made before TECH-5179. Never the credential.
 */
export const RunAccount = z.object({
  id: z.string(),
  group: z.enum(["owner", "registered"]),
  /** Who it belongs to, as a human reads it: the account's configured name, or the person's Linear name. */
  holder: z.string(),
});
export type RunAccount = z.infer<typeof RunAccount>;

const RunBase = {
  runId: RunId,
  status: z.enum(["running", "succeeded", "failed", "canceled"]),
  provider: z.string(),
  model: z.string(),
  /**
   * The run's model cost when it ended, in USD: the agent CLI's own figure, or Sergeant's estimate (see
   * `costBasis`). Absent while running, or when neither exists; the budget then counts it as unknown.
   */
  costUsd: z.number().nonnegative().optional(),
  /**
   * `estimated` when `costUsd` is the run's tokens times the configured list price of its model (04 §7,
   * TECH-5021: a Codex run); absent when the CLI reported it (Claude Code).
   */
  costBasis: z.literal("estimated").optional(),
  /**
   * The tokens the run reported when it ended, for a provider that reports no dollar figure (Codex,
   * TECH-5009). A model with a configured price gets an estimated `costUsd` from these (TECH-5021).
   */
  tokens: z
    .object({
      input: z.number().int().nonnegative(),
      cachedInput: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      reasoningOutput: z.number().int().nonnegative(),
    })
    .optional(),
  /** Why the report is null: missing, malformed, or failed validation. */
  reportError: z.string().optional(),
  /**
   * TECH-5259: whether an ended run's report was never written (`missing`) or did not parse
   * (`malformed`); absent with a usable report, while running, and on older records.
   */
  reportProblem: z.enum(["missing", "malformed"]).optional(),
  /** A distinct actionable cause when the runner can classify the failure safely. */
  failureReason: RunFailureReason.optional(),
  /**
   * The `issueRevision` of the title and description the run started from, as the runner recorded it.
   * Absent on records made before TECH-5034.
   */
  issueRevision: z.string().optional(),
  /** Absent when the installation has one provider, and on records made before TECH-5117. */
  providerChoice: ProviderChoice.optional(),
  /** Absent on records made before TECH-5113. */
  account: RunAccount.optional(),
  /** Why the account was chosen among the task owner's, by quota (TECH-5179). */
  accountReason: z.string().optional(),
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

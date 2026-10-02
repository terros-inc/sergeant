import { createHash } from "node:crypto";
import type { Finding, RepoSlug, RunRecord, Sha } from "@terros/sergeant-contracts";

// Review quality as telemetry (06 §8–9, UNF-641 carried over by UNF-730): a stable random sample of
// merged heads that skipped fresh review gets a nonblocking audit review, and every review that
// finishes, merged or not, is written to `reviews.jsonl` so review modes and vendors can be compared
// later. Nothing here gates anything; losing it is a metrics gap.

export type PrHead = { repo: RepoSlug; number: number; headSha: string };

const coversHead = (head: PrHead) => (r: PrHead) => r.repo === head.repo && r.number === head.number && r.headSha === head.headSha;

/** Whether a succeeded separate review approved exactly this head. A merged head without one skipped review. */
export function approvedHead(runs: RunRecord[], head: PrHead): boolean {
  return runs.some(
    (r) => r.role === "reviewer" && r.status === "succeeded" && r.report?.verdict === "approve" && r.report.reviewed.some(coversHead(head)),
  );
}

/**
 * The audit draw (06 §8): a stable hash of the head against the sample rate, so it is random across
 * heads, identical across restarts, and needs no stored state.
 */
export function auditDrawn(rate: number, head: PrHead): boolean {
  const hash = createHash("sha256").update(JSON.stringify(["audit", head.repo, head.number, head.headSha])).digest();
  return hash.readUInt32BE(0) / 2 ** 32 < rate;
}

/** The worker run whose final report last named this exact head: its implementer and its review call. */
export function implementerOf(runs: RunRecord[], head: PrHead) {
  const run = runs.findLast((r) => r.role === "worker" && r.report?.pullRequests.some(coversHead(head)));
  return run?.role === "worker" ? { run, reported: run.report?.pullRequests.find(coversHead(head)) } : undefined;
}

/** One review's line in `reviews.jsonl` (01 `ReviewFacts`, trimmed to what the skeleton knows). */
export type ReviewFacts = {
  recordVersion: "s2-review-facts/2";
  at: string;
  issue: string;
  /**
   * The review's identity. A line is written when its run finishes and again whenever a later fact
   * (the merge, a resulting change) changes it; the last line per run id holds.
   */
  runId: string;
  /** `required`: a reviewer reasoning started before the merge. `audit`: a sampled skip, after it. */
  trigger: "required" | "audit";
  /** Always a separate fresh reviewer run; workers do not report subagent reviews yet. */
  mode: "separate_run";
  status: RunRecord["status"];
  reviewer: { provider: string; model: string };
  implementer: { provider: string; model: string } | null;
  /** Reviewer and implementer vendors, compared by the provider's prefix (`anthropic/…`). */
  vendor: "same" | "different" | "unknown";
  subject: PrHead[];
  verdict: "approve" | "changes_requested" | "needs_human" | null;
  findings: { blocking: number; nonBlocking: number; nits: number };
  /** The blocking findings, verbatim. */
  mustFix: Finding[];
  /** The head the task merged, once it has; null for a review of a task that has not (or never) merged. */
  merged: (PrHead & { mergedSha: Sha }) | null;
  /** Resulting change (01 `resultingMutation`): see {@link resultingMutation}. */
  resultingMutation: boolean | "unknown";
  /** An audit with must-fix findings on merged code: they are logged as follow-up work. */
  followUp: boolean;
};

/**
 * Whether a review led to a code change, only from what workers said they did: true when a worker
 * report lists one of its findings `fixed`; false when it had no findings, or workers answered them
 * and fixed none; otherwise unknown. A head changing after a review is not evidence it was the cause.
 */
export function resultingMutation(review: Extract<RunRecord, { role: "reviewer" }>, runs: RunRecord[]): boolean | "unknown" {
  if (!review.report) return "unknown";
  const ids = new Set(review.report.findings.map((f) => f.id));
  if (ids.size === 0) return false;
  const answered = runs
    .flatMap((r) => (r.role === "worker" ? (r.report?.addressedFindings ?? []) : []))
    .filter((a) => a.reviewRunId === review.runId && ids.has(a.findingId));
  if (answered.some((a) => a.resolution === "fixed")) return true;
  return answered.length > 0 ? false : "unknown";
}

export function reviewFacts(
  review: Extract<RunRecord, { role: "reviewer" }>,
  ctx: { trigger: ReviewFacts["trigger"]; issue: string; runs: RunRecord[]; merged: ReviewFacts["merged"] },
): ReviewFacts {
  const report = review.report;
  const subject = report?.reviewed ?? (ctx.trigger === "audit" && ctx.merged ? [ctx.merged] : []);
  const implementer = subject.map((h) => implementerOf(ctx.runs, h)?.run).find((r) => r !== undefined);
  const vendorOf = (provider: string) => provider.split("/")[0];
  const count = (severity: Finding["severity"]) => report?.findings.filter((f) => f.severity === severity).length ?? 0;
  const mustFix = report?.findings.filter((f) => f.severity === "blocking") ?? [];
  return {
    recordVersion: "s2-review-facts/2",
    at: new Date().toISOString(),
    issue: ctx.issue,
    runId: review.runId,
    trigger: ctx.trigger,
    mode: "separate_run",
    status: review.status,
    reviewer: { provider: review.provider, model: review.model },
    implementer: implementer ? { provider: implementer.provider, model: implementer.model } : null,
    vendor: implementer ? (vendorOf(implementer.provider) === vendorOf(review.provider) ? "same" : "different") : "unknown",
    subject,
    verdict: report?.verdict ?? null,
    findings: { blocking: count("blocking"), nonBlocking: count("non_blocking"), nits: count("nit") },
    mustFix,
    merged: ctx.merged,
    resultingMutation: resultingMutation(review, ctx.runs),
    followUp: ctx.trigger === "audit" && mustFix.length > 0,
  };
}

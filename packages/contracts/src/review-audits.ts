import { z } from "zod";
import { Sha } from "./conversation.ts";
import { Finding } from "./runs.ts";

// TECH-6619: `GET /v1/review-audits`, how often post-merge audits found something new and how often they
// would have failed the head (design 16 §6.3, §7.2). Computed on each call from the audits' `ReviewFacts`
// lines in `reviews.jsonl`; nothing is stored. `sgt review audits` prints it.

/**
 * Counts over completed audits (a reviewer report with a verdict). Audit yield is `found / foundKnown`;
 * `foundUnknown` never enters it. The FAIL rate is `fail / completed`.
 */
export const AuditCounts = z.object({
  completed: z.number().int(),
  /** Found: YES. */
  found: z.number().int(),
  /** Found: YES or NO. */
  foundKnown: z.number().int(),
  foundUnknown: z.number().int(),
  /** Verdict `changes_requested` or `needs_human`: the head would not have been fit to merge. */
  fail: z.number().int(),
});
export type AuditCounts = z.infer<typeof AuditCounts>;

/**
 * `agreed`: Sergeant declared the audited head ready and a human merged it at that head (TECH-6611's
 * AGREED). `sergeant_merged`: Sergeant declared it and a bot, Sergeant itself, merged it (the
 * classifier's `not_human_merge`). `other`: every other audited PR.
 */
export const AuditGroup = z.enum(["agreed", "sergeant_merged", "other"]);
export type AuditGroup = z.infer<typeof AuditGroup>;

/** One audit, its result, and on a `Found: YES` the reviewer's summary and every finding from its run record. */
export const AuditRow = z.object({
  runId: z.string(),
  issue: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  /** The audited (pre-merge) head. */
  headSha: Sha,
  /** When the audit's `ReviewFacts` line was written. */
  at: z.string(),
  /** Null when the audit did not complete (its run failed or left no readable report). */
  verdict: z.enum(["approve", "changes_requested", "needs_human"]).nullable(),
  /** Absent when unknown. */
  found: z.boolean().optional(),
  group: AuditGroup,
  summary: z.string().optional(),
  findings: z.array(Finding).optional(),
});
export type AuditRow = z.infer<typeof AuditRow>;

export const ReviewAudits = z.object({
  /** The cutoff `--since` set, absent for every audit. */
  since: z.string().optional(),
  repo: z.string().optional(),
  ...AuditCounts.shape,
  /** Audits recorded without a verdict; in no rate. */
  incomplete: z.number().int(),
  byRepo: z.array(AuditCounts.extend({ repo: z.string() })),
  bySergeant: z.record(AuditGroup, AuditCounts),
  audits: z.array(AuditRow),
});
export type ReviewAudits = z.infer<typeof ReviewAudits>;

import { z } from "zod";
import { Sha } from "./conversation.ts";

// TECH-6613: `GET /v1/review-readiness`, how often a human merged exactly the head Sergeant declared
// ready (design 16 §5.1, §7.1). Computed on each call from the task records and GitHub; nothing is stored.
// `sgt review readiness` prints it.

export const ReadinessClass = z.enum(["AGREED", "DIFFERENT_HEAD", "REJECTED", "UNKNOWN"]);
export const ReadinessUnknownReason = z.enum(["pending", "closed_unmerged", "not_human_merge", "uninterpretable"]);

/** One declaration, its class now, and the reason Sergeant gave when it declared. */
export const ReadinessRow = z.object({
  task: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  commentUrl: z.string(),
  /** The head the declaration was bound to. */
  headSha: Sha,
  /** When Sergeant recorded the declaration (the refusal, handoff or merge record). */
  at: z.string(),
  class: ReadinessClass,
  reason: z.string(),
  /** The declaration's `Reason:` line; absent when the comment could not be read. */
  declarationReason: z.string().optional(),
  /** The human merger of an evaluated merged declaration. */
  merger: z.string().optional(),
});
export type ReadinessRow = z.infer<typeof ReadinessRow>;

/** The agreement rate is `agreed / evaluated`; UNKNOWN never enters it. */
export const ReviewReadiness = z.object({
  /** The cutoff `--since` set, absent for every record. */
  since: z.string().optional(),
  repo: z.string().optional(),
  agreed: z.number().int(),
  differentHead: z.number().int(),
  rejected: z.number().int(),
  /** agreed + differentHead + rejected. */
  evaluated: z.number().int(),
  unknown: z.record(ReadinessUnknownReason, z.number().int()),
  /** Evaluated declarations on merged PRs, by merger, most first. */
  mergers: z.array(z.object({ login: z.string(), count: z.number().int() })),
  declarations: z.array(ReadinessRow),
});
export type ReviewReadiness = z.infer<typeof ReviewReadiness>;

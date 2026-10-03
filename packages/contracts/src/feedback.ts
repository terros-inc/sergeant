import { z } from "zod";
import { Conversation } from "./conversation.ts";

// Human feedback that arrives after a task's work landed (TECH-4985): a comment on its Linear issue,
// or a comment or review on its merged PR, after the completing PR merged or the issue was Done.
// Reasoning judges whether it asks for a change; if it does, Sergeant files one ordinary follow-up.

const Instant = z.iso.datetime({ offset: true });

/** One piece of human feedback, from Linear or GitHub, with a key unique to that comment or review. */
export const Feedback = z.object({
  /** `linear:<comment id>`, or `github:<repo>#<number>:<review|review_comment|comment>:<id>`. */
  key: z.string().min(1),
  source: z.enum(["linear_comment", "pr_comment", "pr_review_comment", "pr_review"]),
  author: z.string().min(1),
  createdAt: Instant,
  body: z.string().min(1),
  url: z.url(),
});
export type Feedback = z.infer<typeof Feedback>;

/** What reasoning reads to judge one piece of feedback. */
export const FeedbackCase = z.object({
  /** The issue, every human comment, and the other comments (Sergeant's outcome, say). */
  origin: Conversation,
  /** The task's merged PRs. */
  mergedPullRequests: z.array(z.object({ url: z.url(), body: z.string() })),
  feedback: Feedback,
  /** Sergeant's comments on the issue for follow-ups already filed from its feedback: never file one change twice. */
  filed: z.array(z.string()),
});
export type FeedbackCase = z.infer<typeof FeedbackCase>;

export const FeedbackJudgment = z.discriminatedUnion("actionable", [
  z.object({
    actionable: z.literal(false),
    /** Why nothing is filed: an acknowledgement, a question, discussion, or already covered. */
    reason: z.string().min(1).max(1_000),
  }),
  z.object({
    actionable: z.literal(true),
    title: z.string().min(1).max(200),
    /** What the merged result does, what the feedback wants instead, and what now needs to change. */
    delta: z.string().min(1).max(6_000),
  }),
]);
export type FeedbackJudgment = z.infer<typeof FeedbackJudgment>;

import { z } from "zod";
import { RepoSlug, Sha } from "./conversation.ts";
import { FollowupCategory, RunId } from "./runs.ts";

const PrHead = z.object({ repo: RepoSlug, number: z.number().int().positive(), headSha: Sha });

export const StartWorker = z.object({
  kind: z.literal("start_worker"),
  /** Outcome-level instruction; the worker also receives the task text verbatim. */
  objective: z.string().min(1).max(16_000),
  repositories: z.array(RepoSlug).min(1),
});

export const StartReviewer = z.object({
  kind: z.literal("start_reviewer"),
  subject: z.array(PrHead).min(1),
  focus: z.string().max(4_000).optional(),
});

export const SendRun = z.object({
  kind: z.literal("send_run"),
  runId: RunId,
  message: z.string().min(1).max(8_000),
});

/** The fresh-review standing a merge relies on; the Gate checks it against the run records. */
export const ReviewStanding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reviewed"), reviewRunId: RunId }),
  /** The worker's final report said this exact head needs no review, with a reason. */
  z.object({ kind: z.literal("not_required"), workerRunId: RunId }),
]);
export type ReviewStanding = z.infer<typeof ReviewStanding>;

export const MergePr = z.object({
  kind: z.literal("merge_pr"),
  repo: RepoSlug,
  number: z.number().int().positive(),
  expectedHeadSha: Sha,
  reviewStanding: ReviewStanding,
  /**
   * TECH-5186: for the closing PR, up to three short lines worth keeping from the runs' feedback and
   * non-blocking review notes. After the merge they are posted once on the issue as the Sergeant
   * feedback comment, with the `sergeant-feedback` label; absent or empty, neither.
   */
  feedback: z.array(z.string().min(1).max(300)).max(3).optional(),
});
export type MergePr = z.infer<typeof MergePr>;

/**
 * A question only a human can settle. Once it is posted, Sergeant takes no turn and makes no effect on
 * the task until a human changes the conversation (comments or edits the issue).
 */
export const AskHuman = z.object({
  kind: z.literal("ask_human"),
  /** Concise: the question and why only a human can decide it. */
  question: z.string().min(1).max(4_000),
  options: z.array(z.string().min(1).max(500)).min(2).max(6).optional(),
  /**
   * TECH-5052: the id of Sergeant's earlier question whose reply did not settle it. This one is posted
   * as a reply in that question's thread, which stays open.
   */
  followsUp: z.string().min(1).optional(),
});

/**
 * TECH-5118: the human's reply to Sergeant's budget question accepts the work as it is. The task ends
 * with no fresh window, no further question, and no more work; its PRs and the issue are left as they
 * are for a human. Allowed only once a human has replied to the budget question.
 */
export const AcceptAsIs = z.object({ kind: z.literal("accept_as_is") });

/**
 * A Linear issue for a concrete bug, required unfinished work from this task's scope, a real blocker,
 * or a current operational or security problem (07 §11, TECH-5186); never a review's non-blocking
 * notes. Filed in the task's team and project, linked to the task's issue, and delegated to nobody.
 */
export const CreateFollowup = z.object({
  kind: z.literal("create_followup"),
  /** Names the idea, not the wording: proposing the same key again files nothing new. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a short lowercase slug"),
  title: z.string().min(1).max(200),
  /** Which of the four reasons this meets, and why; both open the filed issue's description. */
  category: FollowupCategory,
  why: z.string().min(1).max(1_000),
  description: z.string().min(1).max(8_000),
  /** `blocked_by`: the follow-up must wait for this task's issue. */
  relation: z.enum(["related", "blocked_by"]),
});
export type CreateFollowup = z.infer<typeof CreateFollowup>;

/** Everything reasoning may propose. Reasoning only proposes; the core gates and performs. */
export const ProposedAction = z.discriminatedUnion("kind", [
  StartWorker,
  StartReviewer,
  SendRun,
  MergePr,
  AskHuman,
  AcceptAsIs,
  CreateFollowup,
]);
export type ProposedAction = z.infer<typeof ProposedAction>;

/** What one reasoning turn returns. No actions means "nothing until something changes". */
export const TurnOutput = z.object({
  summary: z.string().min(1).max(2_000),
  actions: z.array(ProposedAction).max(5),
  nextWakeSeconds: z.number().int().min(60).max(14_400).optional(),
});
export type TurnOutput = z.infer<typeof TurnOutput>;

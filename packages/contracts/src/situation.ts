import { z } from "zod";
import { BudgetStatus } from "./budget.ts";
import { Conversation, ConversationRevision, conversationRevision, RepoSlug, Sha } from "./conversation.ts";
import { PullRequestFacts } from "./github.ts";
import { RunRecord } from "./runs.ts";

/** A follow-up issue this task filed, under reasoning's key. */
export const FiledFollowup = z.object({ key: z.string(), title: z.string(), identifier: z.string(), url: z.url() });
export type FiledFollowup = z.infer<typeof FiledFollowup>;

/**
 * A merge whose bounded attempt and re-check both failed, including a repository-policy refusal.
 * Sergeant told the issue the PR is ready for a human to merge; M12 refuses another try at the same
 * facts until the conversation or PR changes.
 */
export const RefusedMerge = z.object({
  repo: RepoSlug,
  number: z.number().int().positive(),
  url: z.url(),
  headSha: Sha,
  /** The live revision the refused merge was checked against. */
  conversationRevision: ConversationRevision,
  /** GitHub's own words. */
  reason: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type RefusedMerge = z.infer<typeof RefusedMerge>;

/** The bounded snapshot one reasoning turn starts from. Each turn gets a fresh one (01, 03 §3). */
export const SituationReport = z.object({
  taskId: z.string().min(1),
  generatedAt: z.iso.datetime({ offset: true }),
  /** What this turn saw; a merge it proposes carries it (M10). */
  conversationRevision: ConversationRevision,
  /** Task instructions and separately labeled linked-issue reference material. */
  conversation: Conversation,
  /**
   * Every Linear upload a human referenced in the description or a comment (`linearUploads`); with
   * the issue's attachments, what runs are given as files under `.sergeant/attachments/` (TECH-4994).
   */
  uploads: z.array(z.string()).default([]),
  /**
   * `issueRevision` of the current title and description. A run whose own `issueRevision` differs
   * started from older text (TECH-5034).
   */
  issueRevision: z.string().optional(),
  /** Repositories runs may be given; the canary's allowlist. */
  enrolledRepositories: z.array(RepoSlug),
  pullRequests: z.array(PullRequestFacts),
  runs: z.array(RunRecord),
  /** Follow-ups already filed for this task: never file the same idea again under another key. */
  followups: z.array(FiledFollowup).default([]),
  /** Merges handed off after their bounded attempts: each PR waits for a human or a fact change. */
  refusedMerges: z.array(RefusedMerge).default([]),
  budget: BudgetStatus,
  recentTurns: z.array(
    z.object({
      at: z.iso.datetime({ offset: true }),
      summary: z.string(),
      outcomes: z.array(z.string()),
    }),
  ),
}).refine(
  // A snapshot whose revision is not its own conversation's and PRs' would let a merge pass M10
  // against input reasoning never saw.
  (s) => s.conversationRevision === conversationRevision(s.conversation, s.pullRequests),
  { message: "conversationRevision does not match conversation", path: ["conversationRevision"] },
);
export type SituationReport = z.infer<typeof SituationReport>;

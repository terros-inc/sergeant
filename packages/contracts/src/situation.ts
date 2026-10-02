import { z } from "zod";
import { BudgetStatus } from "./budget.ts";
import { Conversation, ConversationRevision, conversationRevision, RepoSlug } from "./conversation.ts";
import { PullRequestFacts } from "./github.ts";
import { RunRecord } from "./runs.ts";

/** A follow-up issue this task filed, under reasoning's key. */
export const FiledFollowup = z.object({ key: z.string(), title: z.string(), identifier: z.string(), url: z.url() });
export type FiledFollowup = z.infer<typeof FiledFollowup>;

/** The bounded snapshot one reasoning turn starts from. Each turn gets a fresh one (01, 03 §3). */
export const SituationReport = z.object({
  taskId: z.string().min(1),
  generatedAt: z.iso.datetime({ offset: true }),
  /** What this turn saw; a merge it proposes carries it (M10). */
  conversationRevision: ConversationRevision,
  conversation: Conversation,
  /** Repositories runs may be given; the canary's allowlist. */
  enrolledRepositories: z.array(RepoSlug),
  pullRequests: z.array(PullRequestFacts),
  runs: z.array(RunRecord),
  /** Follow-ups already filed for this task: never file the same idea again under another key. */
  followups: z.array(FiledFollowup).default([]),
  budget: BudgetStatus,
  recentTurns: z.array(
    z.object({
      at: z.iso.datetime({ offset: true }),
      summary: z.string(),
      outcomes: z.array(z.string()),
    }),
  ),
}).refine(
  // A snapshot whose revision is not its own conversation's would let a merge pass M10 against
  // input reasoning never saw.
  (s) => s.conversationRevision === conversationRevision(s.conversation),
  { message: "conversationRevision does not match conversation", path: ["conversationRevision"] },
);
export type SituationReport = z.infer<typeof SituationReport>;

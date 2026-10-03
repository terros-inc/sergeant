import { createHash } from "node:crypto";
import { z } from "zod";

export const RepoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name");
export type RepoSlug = z.infer<typeof RepoSlug>;

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-character commit SHA");
export type Sha = z.infer<typeof Sha>;

const Instant = z.iso.datetime({ offset: true });

export const PullRequestRef = z.object({ repo: RepoSlug, number: z.number().int().positive() });
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const HumanComment = z.object({
  id: z.string().min(1),
  author: z.object({ id: z.string().min(1), name: z.string() }),
  createdAt: Instant,
  updatedAt: Instant,
  body: z.string(),
});
export type HumanComment = z.infer<typeof HumanComment>;

/**
 * A file or link a human attached to the issue (TECH-4994): an upload, a link, or an integration's
 * record such as a PR. Sergeant's own attachments are never here. `source` is Linear's `sourceType`.
 */
export const IssueAttachment = z.object({
  id: z.string().min(1),
  title: z.string(),
  source: z.string().nullable(),
  url: z.string(),
  updatedAt: Instant,
});
export type IssueAttachment = z.infer<typeof IssueAttachment>;

/**
 * A comment that is not human input: Sergeant's own (its questions and outcomes), or a bot's.
 * `parentId` is the thread's top comment when it is a reply.
 */
export const AgentComment = z.object({ id: z.string().min(1), createdAt: Instant, body: z.string(), parentId: z.string().min(1).optional() });
export type AgentComment = z.infer<typeof AgentComment>;

/**
 * An issue explicitly linked from the task's own description or a human comment. This is reference
 * material only, never part of the task's instructions or conversation revision. An unreadable link
 * is retained so briefs can say that Linear could not supply its contents.
 */
export const LinkedIssueBackground = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    identifier: z.string().min(1),
    url: z.url(),
    title: z.string(),
    state: z.string(),
    description: z.string(),
    descriptionTruncated: z.boolean(),
  }),
  z.object({
    status: z.literal("unreadable"),
    identifier: z.string().min(1),
    url: z.url(),
    reason: z.string(),
  }),
]);
export type LinkedIssueBackground = z.infer<typeof LinkedIssueBackground>;

/** The current Linear task source verbatim, plus separately labeled linked-issue background. */
export const Conversation = z.object({
  issue: z.object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    url: z.url(),
    title: z.string(),
    description: z.string(),
    state: z.string(),
    /**
     * The state's Linear type: `triage`, `backlog`, `unstarted` (Todo), `started`, `completed`, or
     * `canceled`. What intake and the stop rule (A2) read; `state` is only its name.
     */
    stateType: z.string(),
    /** The current Linear delegate. `null` means nobody is delegated. */
    delegate: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
    /**
     * The PRs Linear's GitHub integration has attached to the issue: which PRs belong to this task
     * (08 §4). Not part of the conversation revision; it is what humans link, not what they say.
     */
    linkedPullRequests: z.array(PullRequestRef),
    /** Every human-added attachment (TECH-4994); part of the revision. Absent reads as none. */
    attachments: z.array(IssueAttachment).optional(),
  }),
  /** Every human-authored comment, oldest first. Never filtered by relevance. */
  humanComments: z.array(HumanComment),
  /** Every other comment, oldest first: context such as what Sergeant asked; never in the revision. */
  agentComments: z.array(AgentComment),
  /** Bounded, one-hop background from explicit same-workspace issue links. Never instructions. */
  linkedIssueBackground: z.array(LinkedIssueBackground).optional(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ConversationRevision = z.string().regex(/^[0-9a-f]{64}$/);
export type ConversationRevision = z.infer<typeof ConversationRevision>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Linear's client-supplied comment id for an idempotency key: a UUID v4-shaped digest of the key. A
 * comment posted under a key therefore has an id anyone can recompute from that key alone.
 */
export function commentIdFor(key: string): string {
  const hex = sha256(key);
  const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Linear `sourceType`s that are a human's file or link rather than an integration's record. */
const GENERIC_SOURCES = new Set<string | null>([null, "upload", "url", "api"]);

const uploadUrl = /https:\/\/uploads\.linear\.app\/[^\s<>()[\]"'`]+/g;

/**
 * Every Linear upload (`uploads.linear.app`) a human referenced in the description or a human
 * comment, deduplicated in first-seen order: files and images pasted into the text (TECH-4994).
 * Sergeant's own comments are not read, so its own uploads never count.
 */
export function linearUploads(conversation: Conversation): string[] {
  const texts = [conversation.issue.description, ...conversation.humanComments.map((c) => c.body)];
  // A sentence's closing punctuation is not part of the URL.
  return [...new Set(texts.flatMap((t) => (t.match(uploadUrl) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""))))];
}

/** What the revision reads of a PR's human feedback (TECH-4987); `PullRequestFacts` has it. */
type PullRequestFeedbackFacts = {
  repo: string;
  number: number;
  humanFeedback: readonly { id: string; updatedAt: string; state: string | null; body: string }[];
};

/**
 * A deterministic hash of what humans have said: the issue title and description, each human
 * comment's id, updatedAt, and body hash, and each human review or comment on the task's PRs (id,
 * updatedAt, review state, body hash), and each human-added file or link attachment's id and updatedAt (uploads
 * pasted into the text are already in it). A merge proposed against one revision is refused once the live
 * revision differs (M10), so no merge overtakes human input that no turn has seen. Without PRs it is
 * the Linear conversation's alone, which is what a question's key uses (questions are answered in Linear).
 */
export function conversationRevision(conversation: Conversation, pullRequests: readonly PullRequestFeedbackFacts[] = []): ConversationRevision {
  const byKey = <T extends readonly [string, ...unknown[]]>(rows: T[]) => rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const comments = byKey(conversation.humanComments.map((c) => [c.id, c.updatedAt, sha256(c.body)] as const));
  const { title, description } = conversation.issue;
  const feedback = byKey(
    pullRequests.flatMap((p) => p.humanFeedback.map((f) => [`${p.repo}#${p.number}:${f.id}`, f.updatedAt, f.state, sha256(f.body)] as const)),
  );
  // Only generic sources: an integration's record (a GitHub PR or issue) syncs on its own schedule.
  const attachments = byKey(
    (conversation.issue.attachments ?? []).filter((a) => GENERIC_SOURCES.has(a.source)).map((a) => [a.id, a.updatedAt] as const),
  );
  // Unchanged for a task with no human PR feedback or attachments, so earlier revisions still match.
  if (attachments.length > 0) return sha256(JSON.stringify([title, description, comments, feedback, attachments]));
  return sha256(JSON.stringify(feedback.length > 0 ? [title, description, comments, feedback] : [title, description, comments]));
}

/**
 * A hash of the issue's title and description alone: the text that states what is asked and its
 * acceptance criteria. Each run records the one it started from (`RunRecord.issueRevision`), so a
 * review or waiver given against an older text is told apart from one against the current text (M13).
 */
export function issueRevision(issue: Pick<Conversation["issue"], "title" | "description">): string {
  return sha256(JSON.stringify([issue.title, issue.description]));
}

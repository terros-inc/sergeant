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

/** A comment that is not human input: Sergeant's own (its questions and outcomes), or a bot's. */
export const AgentComment = z.object({ id: z.string().min(1), createdAt: Instant, body: z.string() });
export type AgentComment = z.infer<typeof AgentComment>;

/** The current Linear task source: the issue verbatim and every human-authored comment. */
export const Conversation = z.object({
  issue: z.object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    url: z.url(),
    title: z.string(),
    description: z.string(),
    state: z.string(),
    /** The current Linear delegate. `null` means nobody is delegated. */
    delegate: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
    /**
     * The PRs Linear's GitHub integration has attached to the issue: which PRs belong to this task
     * (08 §4). Not part of the conversation revision; it is what humans link, not what they say.
     */
    linkedPullRequests: z.array(PullRequestRef),
  }),
  /** Every human-authored comment, oldest first. Never filtered by relevance. */
  humanComments: z.array(HumanComment),
  /** Every other comment, oldest first: context such as what Sergeant asked; never in the revision. */
  agentComments: z.array(AgentComment),
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

/**
 * A deterministic hash of what humans have said: the issue title and description, and each human
 * comment's id, updatedAt, and body hash. A merge proposed against one revision is refused once the
 * live revision differs (M10), so no merge overtakes human input that no turn has seen.
 */
export function conversationRevision(conversation: Conversation): ConversationRevision {
  const comments = conversation.humanComments
    .map((c) => [c.id, c.updatedAt, sha256(c.body)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { title, description } = conversation.issue;
  return sha256(JSON.stringify([title, description, comments]));
}

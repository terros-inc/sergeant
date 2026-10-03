import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hasClosingReference,
  type Conversation,
  type Feedback,
  type GitHubPort,
  type HumanPullRequestFeedback,
  type LinearPort,
  type PullRequestFacts,
  type RepoSlug,
} from "@terros/sergeant-contracts";
import type { FeedbackJudge } from "@terros/sergeant-reasoning";
import { z } from "zod";
import { readTaskState } from "./task-state.ts";
import { pause } from "./wake.ts";

// Post-merge feedback (TECH-4985). While a task is active, a human's comment is part of its
// conversation and its own loop handles it (loop.ts). Once the completing PR merged or the issue is
// Done, the loop takes no more turns, so this sweep reads what humans said afterwards: comments on the
// issue, and comments and reviews on Sergeant's merged PRs from people with a role in the repository.
// Reasoning judges each one; actionable feedback becomes one ordinary follow-up issue, filed by the
// Linear adapter's follow-up rule (TECH-4998): Backlog, assigned to the origin's owner, not delegated.
// A human starts it the normal way, by moving it to Todo and delegating it to Sergeant; nothing here
// schedules or runs it. Only this control-plane code creates issues; runs never can.
//
// One follow-up per feedback item at most: its issue id is derived from the feedback's key, so a
// repeated sweep, a crash, or a lost `feedback.json` files nothing twice, and Sergeant's comment on the
// origin for each filed follow-up tells later judgments what was already filed. `feedback.json` only
// spares a second judgment of what was judged, counts failed attempts, and holds `since`, so feedback
// that predates the first sweep (the rollout) is not acted on.

/** Per origin issue: follow-ups filed from its feedback, and pieces of feedback judged (each a paid model call). */
export const FEEDBACK_LIMITS = { followups: 3, judgments: 10 };
/** A piece of feedback whose judgment or filing failed this often is given up, with a comment on the origin. */
export const MAX_FEEDBACK_ATTEMPTS = 3;
/** Starts Sergeant's comment on the origin for each follow-up filed from feedback. */
export const FILED_MARKER = "**Follow-up filed from feedback:**";
const MAX_QUOTE = 4_000;
/** Who may give PR feedback Sergeant acts on: people with a role in the repository, never a passer-by. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const Handled = z.object({
  issue: z.string(),
  at: z.iso.datetime(),
  /** Whether it cost a judgment (counted against `FEEDBACK_LIMITS.judgments`). */
  judged: z.boolean().default(false),
  /** The follow-up filed for it; absent when the feedback was not actionable, over a limit, or given up. */
  filed: z.string().optional(),
  reason: z.string().optional(),
});
const FeedbackRecord = z.object({
  since: z.iso.datetime(),
  handled: z.record(z.string(), Handled),
  /** Failed attempts at feedback not yet handled. */
  failures: z.record(z.string(), z.number().int()).default({}),
});
type FeedbackRecord = z.infer<typeof FeedbackRecord>;

export type FeedbackDeps = {
  linear: Pick<LinearPort, "readConversation" | "postComment" | "createFollowupIssue">;
  github: Pick<GitHubPort, "readPullRequest">;
  /** Issues delegated to the V2 agent that reached a completed state after `since`. */
  completedIssues(since: string): Promise<string[]>;
  /** Open issues delegated to the V2 agent: one whose completing PR merged but that is not Done is swept too. */
  openIssues(): Promise<string[]>;
  issueProgress(issueId: string): Promise<{ stateType: string; completedAt: string | null }>;
  judge: FeedbackJudge;
  agentUserId: string;
  workerLogin: string;
};

export type FeedbackOptions = {
  stateDir: string;
  enrolledRepositories: RepoSlug[];
  /** How long after work lands its feedback is still watched (default 14 days). */
  lookbackDays?: number;
  log: (line: string) => void;
  /** The service stopping: the sweep ends before its next judgment. */
  signal?: AbortSignal;
};

/** Sweeps every `intervalMs` until `opts.signal` aborts; a failed sweep is logged and retried next time. */
export async function sweepFeedbackEvery(intervalMs: number, opts: FeedbackOptions, deps: FeedbackDeps): Promise<void> {
  while (!opts.signal?.aborted) {
    await sweepFeedback(opts, deps).catch((e: Error) => opts.log(`feedback sweep failed, retrying next interval: ${e.message}`));
    await pause(intervalMs, opts.signal);
  }
}

/** One pass over recently landed work. A failure on one issue is logged and retried next pass. */
export async function sweepFeedback(opts: FeedbackOptions, deps: FeedbackDeps): Promise<void> {
  const file = join(opts.stateDir, "feedback.json");
  const record = await readRecord(file, opts.log);
  const save = async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, file);
  };
  await save();
  const lookback = new Date(Date.now() - (opts.lookbackDays ?? 14) * 86_400_000).toISOString();
  // Linear says which issues are Sergeant's while they stay delegated; the local task records also
  // cover one undelegated after its merge.
  const candidates = new Set([...(await deps.completedIssues(lookback)), ...(await deps.openIssues()), ...(await mergedTasks(opts.stateDir, lookback))]);
  for (const issueId of candidates) {
    if (opts.signal?.aborted) return;
    await sweepIssue(issueId, record, save, opts, deps).catch((e: Error) => opts.log(`feedback on ${issueId}: not swept, retrying next pass: ${e.message}`));
  }
}

async function sweepIssue(issueId: string, record: FeedbackRecord, save: () => Promise<void>, opts: FeedbackOptions, deps: FeedbackDeps): Promise<void> {
  const progress = await deps.issueProgress(issueId);
  if (progress.stateType === "canceled") return;
  const done = progress.stateType === "completed";
  const origin = await deps.linear.readConversation(issueId);
  // Open work a human took back is theirs, and the issue can still absorb the change.
  if (!done && origin.issue.delegate?.id !== deps.agentUserId) return;
  const linked = origin.issue.linkedPullRequests.filter((p) => opts.enrolledRepositories.includes(p.repo));
  const prs = (await Promise.all(linked.map((p) => deps.github.readPullRequest(p.repo, p.number)))).filter((p) => p.author === deps.workerLogin);
  // A PR of the task still open: the task is active, and its loop reads the conversation.
  if (!done && prs.some((p) => p.state === "open")) return;
  const merged = prs.filter((p): p is PullRequestFacts & { mergedAt: string } => p.state === "merged" && !!p.mergedAt);
  const closingMerges = merged.filter((p) => hasClosingReference(p.body, origin.issue.identifier)).map((p) => Date.parse(p.mergedAt));
  // Landed: the completing PR merged, or the issue reached Done, whichever came first.
  const marks = [...(done && progress.completedAt ? [Date.parse(progress.completedAt)] : []), ...(closingMerges.length > 0 ? [Math.max(...closingMerges)] : [])];
  if (marks.length === 0) return;
  const landed = Math.max(Math.min(...marks), Date.parse(record.since));

  const feedback: Feedback[] = [
    ...origin.humanComments
      .filter((c) => Date.parse(c.createdAt) > landed && c.body.trim())
      .map((c) => ({ key: `linear:${c.id}`, source: "linear_comment" as const, author: c.author.name, createdAt: c.createdAt, body: c.body, url: origin.issue.url })),
    ...merged.flatMap((p) =>
      p.humanFeedback
        .filter((f) => TRUSTED_ASSOCIATIONS.has(f.association ?? "") && f.body.trim() && Date.parse(f.createdAt) > Math.max(landed, Date.parse(p.mergedAt)))
        .map((f) => fromPullRequest(p, f)),
    ),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const filed = origin.agentComments.filter((c) => c.body.startsWith(FILED_MARKER)).map((c) => c.body);
  for (const item of feedback) {
    if (record.handled[item.key]) continue;
    if (opts.signal?.aborted) return;
    const at = new Date().toISOString();
    const judged = Object.values(record.handled).filter((h) => h.issue === origin.issue.id && h.judged).length;
    if (filed.length >= FEEDBACK_LIMITS.followups || judged >= FEEDBACK_LIMITS.judgments) {
      const reason = `${origin.issue.identifier} reached its feedback limit (${filed.length} follow-ups filed, ${judged} pieces of feedback judged)`;
      await deps.linear.postComment({
        issueId: origin.issue.id,
        key: `feedback-limit:${origin.issue.id}`,
        body: `Sergeant stopped reading feedback on this issue: ${reason}. Feedback from here on, starting with ${item.author}'s (${where(item)}), is not turned into follow-ups; file one by hand if it needs one.`,
      });
      opts.log(`feedback ${item.key}: not judged: ${reason}`);
      record.handled[item.key] = { issue: origin.issue.id, at, judged: false, reason };
      await save();
      continue;
    }
    try {
      const outcome = await handle(item, origin, merged, filed, deps);
      if ("comment" in outcome) {
        record.handled[item.key] = { issue: origin.issue.id, at, judged: true, filed: outcome.filed };
        filed.push(outcome.comment);
        opts.log(`feedback ${item.key} on ${origin.issue.identifier}: filed ${outcome.filed} (Backlog, not delegated)`);
      } else {
        record.handled[item.key] = { issue: origin.issue.id, at, judged: true, reason: outcome.reason };
        opts.log(`feedback ${item.key} on ${origin.issue.identifier}: not actionable: ${outcome.reason}`);
      }
    } catch (e) {
      const attempts = (record.failures[item.key] ?? 0) + 1;
      const error = (e as Error).message;
      if (attempts < MAX_FEEDBACK_ATTEMPTS) {
        record.failures[item.key] = attempts;
        opts.log(`feedback ${item.key} on ${origin.issue.identifier}: attempt ${attempts} failed, retrying next pass: ${error}`);
      } else {
        // Given up, and said so where the human looks, so the feedback is not silently lost.
        await deps.linear.postComment({
          issueId: origin.issue.id,
          key: `feedback-failed:${item.key}`,
          body: `Sergeant could not act on ${item.author}'s feedback (${where(item)}) after ${attempts} attempts (${error.slice(0, 500)}). File a follow-up by hand if it needs one.`,
        });
        record.handled[item.key] = { issue: origin.issue.id, at, judged: true, reason: `gave up after ${attempts} attempts: ${error}` };
        opts.log(`feedback ${item.key} on ${origin.issue.identifier}: gave up after ${attempts} attempts: ${error}`);
      }
    }
    if (record.handled[item.key]) delete record.failures[item.key];
    await save();
  }
}

/** Judges one piece of feedback and, if it is actionable, files its follow-up and says so on the origin. */
async function handle(
  item: Feedback,
  origin: Conversation,
  merged: PullRequestFacts[],
  filed: string[],
  deps: FeedbackDeps,
): Promise<{ filed: string; comment: string } | { reason: string }> {
  const mergedPullRequests = merged.map((p) => ({ url: p.url, body: p.body }));
  const { judgment } = await deps.judge.judge({ origin, mergedPullRequests, feedback: item, filed: [...filed] });
  if (!judgment.actionable) return { reason: judgment.reason };
  // Keyed by the feedback alone, never by the pass or the origin: the same feedback files one issue,
  // even a PR comment on a PR linked to two issues.
  const key = `feedback:${item.key}`;
  const issue = await deps.linear.createFollowupIssue({
    originIssueId: origin.issue.id,
    title: judgment.title,
    description: followupDescription(origin, merged, item, judgment.delta),
    relation: "related",
    key,
  });
  const comment = `${FILED_MARKER} [${issue.identifier}](${issue.url}) ${judgment.title}, for ${item.author}'s feedback (${where(item)}). It is in Backlog and not delegated; move it to Todo and delegate it to Sergeant to have it done.`;
  await deps.linear.postComment({ issueId: origin.issue.id, key: `${key}:filed:${origin.issue.id}`, body: comment });
  return { filed: issue.identifier, comment };
}

/** The follow-up's description: reasoning's delta, then the feedback verbatim and links back. */
export function followupDescription(origin: Conversation, prs: { url: string }[], item: Feedback, delta: string): string {
  const quoted = (item.body.length > MAX_QUOTE ? `${item.body.slice(0, MAX_QUOTE)}…` : item.body).replace(/^/gm, "> ");
  const { identifier, title, url } = origin.issue;
  return [
    delta,
    "---",
    `**Feedback** from ${item.author} (${where(item)}, ${item.createdAt}):`,
    quoted,
    `**Original issue:** [${identifier}](${url}) ${title}`,
    `**Merged:** ${prs.map((p) => p.url).join(", ") || "no merged PR on record"}`,
    "Filed by Sergeant from feedback that arrived after the original work landed. To have Sergeant do it, move it to Todo and delegate it to Sergeant.",
  ].join("\n\n");
}

const fromPullRequest = (p: PullRequestFacts, f: HumanPullRequestFeedback): Feedback => ({
  key: `github:${p.repo}#${p.number}:${f.id}`,
  source: f.kind === "review" ? "pr_review" : f.kind === "review_comment" ? "pr_review_comment" : "pr_comment",
  author: f.author,
  createdAt: f.createdAt,
  body: f.body,
  url: f.url,
});

const where = (item: Feedback) =>
  ({
    linear_comment: `[a comment](${item.url})`,
    pr_comment: `[a PR comment](${item.url})`,
    pr_review_comment: `[a review comment](${item.url})`,
    pr_review: `[a review](${item.url})`,
  })[item.source];

/** Tasks this host ran whose completing PR merged after `since` (`state.json`'s `merged`). */
async function mergedTasks(stateDir: string, since: string): Promise<string[]> {
  const dirs = await readdir(join(stateDir, "tasks")).catch(() => []);
  const tasks = await Promise.all(
    dirs.map(async (id) => {
      const state = await readTaskState(join(stateDir, "tasks", id, "state.json")).catch(() => undefined);
      return state?.merged && state.merged.at > since ? [state.issueId] : [];
    }),
  );
  return tasks.flat();
}

/** The record, or a fresh one from now: a corrupt file is set aside rather than failing every sweep. */
async function readRecord(file: string, log: (line: string) => void): Promise<FeedbackRecord> {
  const fresh = () => ({ since: new Date().toISOString(), handled: {}, failures: {} });
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return fresh();
  try {
    return FeedbackRecord.parse(JSON.parse(raw));
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    await rename(file, aside);
    log(`feedback.json is unreadable (${(e as Error).message}); moved to ${aside}, and feedback from before now is not swept`);
    return fresh();
  }
}

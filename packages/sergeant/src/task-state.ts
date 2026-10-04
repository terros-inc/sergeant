import { readFile } from "node:fs/promises";
import {
  BudgetStatus,
  conversationRevision,
  ConversationRevision,
  FiledFollowup,
  issueRevision,
  RefusedMerge,
  RepoSlug,
  reportedClosing,
  RunId,
  Sha,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { z } from "zod";
import { DEFAULT_BUDGET, type BudgetWindow } from "./budget.ts";
import type { ActionOutcome } from "./execute.ts";
import { outcomeComment } from "./outcome.ts";

// The loop's deliberately temporary local store (`state.json`), which lets a restarted loop resume;
// Linear, GitHub, and the runner's own run records stay the authority for everything else.
// TECH-5163: keys this code does not know, a newer release's, are kept and saved back, not dropped, so a
// rollback (to this code or later) leaves them for the newer release to act on once the host moves forward.

const TaskState = z.looseObject({
  issueId: z.string(),
  startedAt: z.iso.datetime(),
  /**
   * TECH-5179: who pays for this task's runs, recorded on admission and never changed for this task.
   * Absent on a task saved before it, which is admitted afresh on its next start (loop.ts).
   */
  owner: z.object({ id: z.string().min(1), name: z.string(), admittedAt: z.iso.datetime() }).optional(),
  turns: z.number().int(),
  lastTurnAt: z.iso.datetime().optional(),
  /** What the last turn saw; an unchanged situation gets no new turn. */
  lastFingerprint: z.string().optional(),
  /** The Linear conversation the last turn saw, so an edit made while waiting on a reply is noticed (TECH-5034). */
  seen: z.object({ revision: ConversationRevision, issue: z.string() }).optional(),
  /**
   * TECH-5057: the newest human comment (its Linear time) that a turn which asked nothing had read: the
   * task has acted on every human reply up to it. Saved with that turn, so it survives a crash.
   */
  actedThrough: z.iso.datetime({ offset: true }).optional(),
  runIds: z.array(RunId),
  /**
   * Runs saved before the runner was asked to start them and not yet seen started: a crash, or a
   * start that failed, in between. Each is confirmed with the runner, or canceled, before anything else.
   */
  unconfirmedStarts: z.array(RunId).default([]),
  /** Follow-up issues filed for this task, shown to every later turn and listed in the outcome. */
  followups: z.array(FiledFollowup).default([]),
  recentTurns: z.array(z.object({ at: z.iso.datetime(), summary: z.string(), outcomes: z.array(z.string()) })),
  /** Reported cost of every reasoning turn; runs report their own. */
  turnCostUsd: z.number().default(0),
  budget: z
    .looseObject({
      /** Fixed when the window opens; a restart with other flags does not change it (budget.ts). */
      window: BudgetStatus.shape.window,
      /** When the window opened, if not at the task's start: a human's answer (TECH-5059). */
      since: z.iso.datetime({ offset: true }).optional(),
      /** Runs of earlier windows, which this one does not count. */
      priorRuns: z.array(RunId).default([]),
    }),
  merged: z
    .looseObject({
      repo: RepoSlug,
      number: z.number().int(),
      headSha: Sha,
      mergedSha: Sha,
      at: z.iso.datetime(),
      /** The outcome comment, built from the facts the merge was allowed on; posted once. */
      outcome: z.string().optional(),
      outcomePostedAt: z.iso.datetime().optional(),
      /** When the audit sample was drawn for the merged head; done once. */
      auditDrawnAt: z.iso.datetime().optional(),
      /** The sampled audit review of the merged head. */
      audit: z.object({ runId: RunId }).optional(),
      /** When the loop saw the task through (Linear Done, reviews finished): intake no longer resumes it. */
      completedAt: z.iso.datetime().optional(),
    })
    .optional(),
  /**
   * TECH-5136: the turn that ended the task as accepted (TECH-5118), saved with that turn. From then on
   * the loop only replays the ending (loop.ts): no reasoning turn can deny it or fail to propose it again.
   */
  accepted: z
    .looseObject({
      at: z.iso.datetime(),
      /** The human reply that accepted, which keys the acknowledgment; absent, none is posted. */
      replyId: z.string().optional(),
      /** The acknowledgment, built from the PRs the accepting turn saw. */
      comment: z.string(),
    })
    .optional(),
  /**
   * Merges whose sole re-check also failed or was refused, one per PR (the latest head), with when the
   * ready-for-human-merge comment was confirmed posted (TECH-4987, TECH-5077).
   */
  refusedMerges: z.array(RefusedMerge.extend({ commentPostedAt: z.iso.datetime().optional(), fingerprint: z.string().optional() })).default([]),
  /** A first failed/refused merge, eligible for its sole automatic re-check after the waiting grace. */
  mergeRetries: z.array(RefusedMerge.extend({ fingerprint: z.string() })).default([]),
  /** Per finished review: the later-known facts its last `reviews.jsonl` line carried. */
  reviewsRecorded: z.record(z.string(), z.string()).default({}),
});
export type TaskState = z.infer<typeof TaskState>;
type State = TaskState;

/** What a turn changes in the task's state; `fingerprint` is the one to commit, if any. */
export function applyTurn(
  state: State,
  turn: { at: string; situation: SituationReport; summary: string; costUsd: number; outcomes: ActionOutcome[]; described: string[]; fingerprint: string | undefined },
  log: (line: string) => void,
): void {
  const { at, situation, outcomes, described } = turn;
  state.turns += 1;
  state.turnCostUsd += turn.costUsd;
  state.lastTurnAt = at;
  state.lastFingerprint = turn.fingerprint;
  state.seen = { revision: conversationRevision(situation.conversation), issue: issueRevision(situation.conversation.issue) };
  state.recentTurns = [...state.recentTurns, { at, summary: turn.summary, outcomes: described }].slice(-8);
  // A turn that proposed asking a human, whatever became of the ask, has not moved on (Q1: it does
  // nothing else); any other turn has acted on every human comment it read, a zero-action turn included.
  if (!outcomes.some((o) => o.action.kind === "ask_human")) {
    const read = situation.conversation.humanComments.map((c) => c.createdAt);
    const newest = [state.actedThrough, ...read].filter((t) => t !== undefined).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (newest) state.actedThrough = newest;
  }
  const done = outcomes.flatMap((o) => (o.status === "done" ? [o] : []));
  for (const o of done) {
    const { started } = o;
    if (started) state.unconfirmedStarts = state.unconfirmedStarts.filter((id) => id !== started.runId);
    const { followup } = o;
    if (followup && !state.followups.some((f) => f.key === followup.key)) state.followups.push(followup);
  }
  // After the follow-ups, so a merge lists those filed earlier in the same turn.
  for (const o of done) {
    if (o.action.kind === "merge_pr" && o.merged) {
      if (reportedClosing(situation.runs, o.merged.pr) !== true) {
        log(`${o.action.repo}#${o.action.number} merged as Part of ${situation.conversation.issue.identifier}; the task continues`);
        continue;
      }
      const mergedSha = Sha.parse(o.merged.mergedSha);
      const outcome = outcomeComment(o.merged.pr, mergedSha, situation.runs, state.followups, situation.conversation.issue);
      state.merged = { repo: o.action.repo, number: o.action.number, headSha: o.merged.pr.headSha, mergedSha, at, outcome };
    }
  }
}

/** The task's state, or a new task starting now with `window`; a task's stored window always wins. */
export async function loadState(file: string, issueId: string, window: BudgetWindow): Promise<State> {
  const budget = { window };
  const state =
    (await readTaskState(file, window)) ??
    TaskState.parse({ issueId, startedAt: new Date().toISOString(), turns: 0, runIds: [], recentTurns: [], budget });
  if (state.issueId !== issueId) throw new Error(`${file} belongs to ${state.issueId}, not ${issueId}`);
  // Before TECH-4991 a temporary 405 "Pull Request is not mergeable" was recorded as a policy refusal,
  // which M12 would keep holding until a human touched the conversation; it is not one, so drop it.
  state.refusedMerges = state.refusedMerges.filter((r) => !/pull request is not mergeable/i.test(r.reason));
  return state;
}

/** A task's saved `state.json`, if it has one. */
export async function readTaskState(file: string, window: BudgetWindow = DEFAULT_BUDGET): Promise<TaskState | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const stored = JSON.parse(raw) as { budget?: object };
  // A task saved before it had a window adopts the one it is resumed with, once.
  return TaskState.parse({ ...stored, budget: { window, ...stored.budget } });
}

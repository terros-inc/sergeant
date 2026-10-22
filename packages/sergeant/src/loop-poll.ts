import {
  conversationRevision,
  linearUploads,
  issueRevision,
  SituationReport,
  type BudgetStatus,
  type Conversation,
  type PullRequestFacts,
  type RunRecord,
} from "@terros/sergeant-contracts";
import { readFile } from "node:fs/promises";
import type { ActionOutcome, Ports } from "./execute.ts";
import type { LoopOptions } from "./loop-options.ts";
import { cancelRuns, unsettledMerges, waitFactsOf, type WaitFacts } from "./poll.ts";
import type { TaskState } from "./task-state.ts";

// What a pass of the task loop (loop.ts) reads before it decides anything: the runs it started, and
// the fresh Situation Report a reasoning turn sees.

/**
 * A start never seen through: the runner either knows the run, or confirms it stopped or never
 * started, which drops it. Until then it stays in `runIds`, unknown, so it is canceled like any
 * other run on an undelegation or an exhausted budget.
 */
export async function confirmStarts(state: TaskState, deps: Ports, log: (line: string) => void, save: () => Promise<void>): Promise<void> {
  for (const runId of state.unconfirmedStarts) {
    const known = await deps.runner.status(runId).then(() => true, () => false);
    if (!known && (await cancelRuns([runId], deps, log)) > 0) continue;
    state.unconfirmedStarts = state.unconfirmedStarts.filter((id) => id !== runId);
    if (!known) state.runIds = state.runIds.filter((id) => id !== runId);
    await save();
  }
}

/** The task's runs. A run whose status cannot be read is unknown, never stopped (04 §6). */
export async function readRuns(state: TaskState, deps: Ports) {
  const read = await Promise.all(state.runIds.map((id) => deps.runner.status(id).catch((e: Error) => ({ unknown: id, error: e.message }))));
  return { runs: read.filter((r): r is RunRecord => !("unknown" in r)), unknown: read.filter((r) => "unknown" in r) };
}

/** The Situation Report for a reasoning turn, built fresh from the live facts and the task's state. */
export function situationOf(
  conversation: Conversation,
  pullRequests: PullRequestFacts[],
  runs: RunRecord[],
  budget: BudgetStatus,
  state: TaskState,
  opts: Pick<LoopOptions, "enrolledRepositories">,
): SituationReport {
  return SituationReport.parse({
    taskId: `canary_${conversation.issue.identifier}`,
    generatedAt: new Date().toISOString(),
    conversationRevision: conversationRevision(conversation, pullRequests),
    conversation,
    uploads: linearUploads(conversation),
    issueRevision: issueRevision(conversation.issue),
    enrolledRepositories: opts.enrolledRepositories,
    pullRequests,
    runs,
    followups: state.followups,
    refusedMerges: state.refusedMerges,
    ciReruns: state.ciReruns,
    budget,
    recentTurns: state.recentTurns,
  });
}

/**
 * TECH-6669: the wait facts of the task's last turn, read back from its line in `turns.jsonl`, for a task
 * saved before they were kept, so a base that moved since then does not wake one more turn (or, on an
 * exhausted window, ask the budget question). Undefined when it cannot be read: the fingerprint then
 * decides until a quiet poll or the next turn records them.
 */
export async function lastTurnWaitFacts(file: string, opts: Omit<Parameters<typeof waitFactsOf>[1], "unsettled">): Promise<WaitFacts | undefined> {
  const line = (await readFile(file, "utf8").catch(() => "")).trimEnd().split("\n").at(-1);
  try {
    const { situation, outcomes } = JSON.parse(line ?? "") as { situation: SituationReport; outcomes: ActionOutcome[] };
    return waitFactsOf(situation, { ...opts, unsettled: unsettledMerges(outcomes, situation) });
  } catch {
    return undefined;
  }
}

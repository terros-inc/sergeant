import { createHash } from "node:crypto";
import { reportedClosing, type PullRequestFacts, type PullRequestRef, type RepoSlug, type RunId, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import type { ActionOutcome, Ports } from "./execute.ts";

// What the loop reads and compares on each poll (loop.ts).

/**
 * A merge that did not happen for a reason the poll may never show (TECH-4991): GitHub still computing
 * mergeability at merge time though the turn's poll saw it mergeable (M7), or the merge call failing
 * (a temporary 405 such as "Base branch was modified", a network error). The next poll can then look
 * exactly like this turn's, so the loop leaves the fingerprint uncommitted and takes another turn
 * rather than going quiet, across a restart too. An M7 denial the poll already showed is left to the
 * fingerprint: `mergeable` changing wakes the turn.
 */
export function mergeNotSettled(o: ActionOutcome, situation: SituationReport): boolean {
  const a = o.action;
  if (a.kind !== "merge_pr") return false;
  if (o.status === "failed") return true;
  const polled = situation.pullRequests.find((p) => p.repo === a.repo && p.number === a.number);
  return o.status === "denied" && o.rule === "M7" && polled?.mergeable === true;
}

/**
 * Cancels each run through the runner and returns how many are not confirmed stopped. The runner
 * resolves `cancel` only once the run is stopped or gone; anything else is retried next poll.
 */
export async function cancelRuns(runIds: RunId[], deps: Ports, log: (line: string) => void): Promise<number> {
  let unconfirmed = 0;
  for (const runId of runIds) {
    await deps.runner.cancel(runId).then(
      () => log(`canceled ${runId}`),
      (e: Error) => (unconfirmed++, log(`cancel ${runId} not confirmed: ${e.message}`)),
    );
  }
  return unconfirmed;
}

/** The worker's own PR it reported closing the issue, merged. */
export const landedOf = (pullRequests: PullRequestFacts[], runs: RunRecord[], workerLogin: string) =>
  pullRequests.find((p) => p.state === "merged" && p.author === workerLogin && reportedClosing(runs, p) === true);

/**
 * Every PR in an enrolled repository that Linear links to the issue or a worker reported, re-read
 * live. Linear's link is authoritative on its own: one no recorded run reported (a human attached it,
 * or a restart lost the run id) still has its head and checks polled.
 */
export async function readPullRequests(runs: RunRecord[], linked: PullRequestRef[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
  const reported = runs.flatMap((run) => (run.role === "worker" ? (run.report?.pullRequests ?? []) : []));
  const refs = new Map<string, PullRequestRef>();
  for (const pr of [...linked, ...reported]) if (enrolled.includes(pr.repo)) refs.set(`${pr.repo}#${pr.number}`, { repo: pr.repo, number: pr.number });
  return Promise.all([...refs.values()].map((r) => deps.github.readPullRequest(r.repo, r.number)));
}

/** What a turn depends on. `generatedAt` and recentTurns are excluded: they change every poll. */
export function fingerprintOf(s: SituationReport): string {
  const facts = {
    conversation: s.conversationRevision,
    // A PR newly linked to the issue can make a refused review or merge allowable.
    linked: s.conversation.issue.linkedPullRequests.map((p) => `${p.repo}#${p.number}`).sort(),
    runs: s.runs.map((r) => [r.runId, r.status]),
    budget: s.budget.grants.length,
    prs: s.pullRequests.map((p) => [p.repo, p.number, p.state, p.draft, p.headSha, p.mergeable, p.checks]),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export const describePr = (p: PullRequestFacts) =>
  `${p.repo}#${p.number} ${p.state} @${p.headSha.slice(0, 12)} checks ${p.checks.required.map((c) => `${c.name}=${c.state}`).join(",") || "none"}`;

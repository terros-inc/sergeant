import { createHash } from "node:crypto";
import { mergeRefusal, reportedClosing, type PullRequestFacts, type PullRequestRef, type RefusedMerge, type RepoSlug, type RunId, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { withSource } from "./api-calls.ts";
import type { ActionOutcome, Ports } from "./execute.ts";
import type { LoopOptions } from "./loop-options.ts";
import type { Wake } from "./wake.ts";

// What the loop reads and compares on each poll (loop.ts).

/**
 * The PRs whose merge M7 denied though the turn's poll saw them mergeable (TECH-5062): the merge's own
 * live read found GitHub still computing, or conflicting. The turn's fingerprint records them as
 * unknown (`mergeable: null`, `mergeableState: "unknown"`), what GitHub last said, so a later poll's
 * definite value is a fact change that wakes exactly one turn, and polls that still show it computing
 * wake none. A PR the poll already saw M7 refuse (behind, say) is not unsettled: the same facts again
 * must not wake a turn. Failed calls and
 * policy refusals use the separate, timestamped bounded retry in loop.ts (TECH-5077).
 */
export function unsettledMerges(outcomes: ActionOutcome[], situation: SituationReport): string[] {
  return outcomes.flatMap((o) => {
    const a = o.action;
    if (a.kind !== "merge_pr" || o.status !== "denied" || o.rule !== "M7") return [];
    const polled = situation.pullRequests.find((p) => p.repo === a.repo && p.number === a.number);
    return polled && mergeRefusal(polled) === null ? [`${a.repo}#${a.number}`] : [];
  });
}

/** Merge calls that reached GitHub but did not happen: faults, explicit repository refusals, and human-merge handoffs. */
export function failedMerges(outcomes: ActionOutcome[], situation: SituationReport): RefusedMerge[] {
  return outcomes.flatMap((o) => {
    const action = o.action;
    if (action.kind !== "merge_pr") return [];
    if (o.status === "denied" && o.refused) return [o.refused];
    if (o.status !== "failed") return [];
    const pr = situation.pullRequests.find((p) => p.repo === action.repo && p.number === action.number && p.headSha === action.expectedHeadSha);
    if (!pr) return [];
    return [{ repo: pr.repo, number: pr.number, url: pr.url, headSha: pr.headSha, conversationRevision: situation.conversationRevision, reason: o.error, temporary: true as const, ...(o.handoffStep && { humanFailure: o.handoffStep }), at: new Date().toISOString() }];
  });
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

/**
 * TECH-5336: a task loop's PR reads. With `everyMs()` set (TECH-5942: the safety interval, at least
 * 15 minutes) the loop rereads its PRs when a GitHub event names one of them or its head (`Wake.github`,
 * with a GitHub webhook secret, TECH-4937), and otherwise only every `everyMs()`, polling being the
 * webhooks' backup. They are also reread when the PRs to read or a run's status changed, after a turn
 * (`forget`), at a human's wake, and while GitHub is still computing a PR's mergeability, which no
 * webhook announces. Without `everyMs()`, every pass.
 */
export function pullRequestPolls(everyMs: () => number | undefined, wake: Wake | undefined, now: () => number = Date.now) {
  let last: { at: number; key: string; prs: PullRequestFacts[] } | undefined;
  return {
    async read(runs: RunRecord[], linked: PullRequestRef[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
      const key = JSON.stringify([runs.map((r) => [r.runId, r.status]), linked.map((p) => `${p.repo}#${p.number}`).sort()]);
      const every = everyMs();
      if (every !== undefined && last && last.key === key && mergeabilityKnown(last.prs) && !wake?.github && !wake?.pending && now() - last.at < every) return last.prs;
      if (wake) wake.github = false;
      const prs = await withSource("task PR reads", () => readPullRequests(runs, linked, enrolled, deps));
      last = { at: now(), key, prs };
      return prs;
    },
    forget(): void {
      last = undefined;
    },
  };
}

/**
 * TECH-5942: how often a task loop rereads PRs no event names: the safety interval (`slowPollSeconds`)
 * whether or not webhooks deliver, or `githubPollSeconds` if that is longer. Without either, every pass.
 */
export const pullRequestPollMs = (opts: Pick<LoopOptions, "githubPollSeconds" | "slowPollSeconds">) => (): number | undefined => {
  const ms = [opts.githubPollSeconds, opts.slowPollSeconds].filter((s) => s !== undefined).map((s) => s * 1000);
  return ms.length === 0 ? undefined : Math.max(...ms);
};

/** No open PR whose mergeability GitHub is still computing, which no webhook announces. */
export const mergeabilityKnown = (prs: PullRequestFacts[]) => prs.every((p) => p.state !== "open" || (p.mergeable !== null && p.mergeableState !== "unknown"));

/**
 * TECH-5942: how long a waiting task loop sleeps before its next poll: the safety interval
 * (`slowPollSeconds`) whether or not webhooks deliver, since falling back to fast polling when they stop
 * would multiply Linear and GitHub load at the worst time; the ordinary poll interval only while
 * something is in flight that no webhook announces (a run, a mergeability GitHub is computing, a merge
 * retry coming due). A webhook naming the task, a human's wake, or a slot ends the wait sooner.
 */
export function waitMs(opts: Pick<LoopOptions, "slowPollSeconds">, pollMs: number, inFlight: boolean): number {
  return !inFlight && opts.slowPollSeconds !== undefined ? Math.max(pollMs, opts.slowPollSeconds * 1000) : pollMs;
}

/**
 * What a turn depends on. `generatedAt` and recentTurns are excluded: they change every poll. The PRs
 * in `unsettled` count as GitHub still computing their mergeability (`unsettledMerges`).
 */
export function fingerprintOf(s: SituationReport, unsettled: string[] = []): string {
  const facts = {
    conversation: s.conversationRevision,
    // A PR newly linked to the issue can make a refused review or merge allowable.
    linked: s.conversation.issue.linkedPullRequests.map((p) => `${p.repo}#${p.number}`).sort(),
    runs: s.runs.map((r) => [r.runId, r.status]),
    // A fresh budget window can allow what the last one refused.
    budget: s.budget.windowStart,
    // A moved base can let a merge GitHub rejected ("Base branch was modified") through.
    prs: s.pullRequests.map((p) => {
      const settled = !unsettled.includes(`${p.repo}#${p.number}`);
      return [p.repo, p.number, p.state, p.draft, p.headSha, p.baseSha, settled ? p.mergeable : null, settled ? p.mergeableState : "unknown", p.checks];
    }),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export const describePr = (p: PullRequestFacts) =>
  `${p.repo}#${p.number} ${p.state} @${p.headSha.slice(0, 12)} checks ${p.checks.required.map((c) => `${c.name}=${c.state}`).join(",") || "none"}`;

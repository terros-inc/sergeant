import { commentIdFor, type AgentComment, type PullRequestFacts } from "@terros/sergeant-contracts";
import type { Ports } from "./execute-types.ts";
import type { TaskState } from "./task-state.ts";

// TECH-6489: GitHub deletes a workflow run, and its check results with it, once the repository's Actions
// retention passes. A required check that had passed on a PR's head then reads `missing`, exactly like
// one that has not reported yet, and an expired run cannot be rerun. Sergeant tells the two apart by what
// it saw on that head before (`passedChecks`), or by the head being older than the retention, and then
// re-triggers CI on the same head once (the GitHub port's draft and ready toggle, never a commit, so the
// head and its approvals stay valid). If that fails, or the checks have not come back after a grace, it
// says so once on the issue, and the task waits on a human (pr-wait.ts). A new head whose checks have not
// reported, and seen pass on none of them, waits as before.

/** How long a re-trigger has to bring the checks back (pending is back) before Sergeant reports it did not. */
export const RETRIGGER_GRACE_MS = 15 * 60_000;

/** Once per PR head: the comment's id is derived from this key, so Linear shows whether it was posted. */
export const expiredChecksKey = (issueId: string, pr: Pick<PullRequestFacts, "repo" | "number" | "headSha">) => `expired-checks:${issueId}:${pr.repo}#${pr.number}:${pr.headSha}`;

type Recovery = TaskState["checkRecoveries"][number];
type Context = { issueId: string; agentComments: AgentComment[]; log: (line: string) => void; save: () => Promise<void>; now?: () => number };

const samePr = (a: Pick<PullRequestFacts, "repo" | "number">, b: Pick<PullRequestFacts, "repo" | "number">) => a.repo === b.repo && a.number === b.number;

export function expiredChecksComment(pr: PullRequestFacts, r: Recovery, missing: string[]): string {
  const checks = missing.map((c) => `\`${c}\``).join(", ");
  const tried =
    r.outcome === "failed"
      ? `Sergeant tried to re-run CI on that same head by converting the PR to draft and back to ready for review, but that failed: ${r.reason}`
      : `Sergeant re-ran CI on that same head at ${r.at} by converting the PR to draft and back to ready for review, but the checks have not come back since.`;
  return [
    "**Required checks missing**",
    "",
    `[${pr.repo}#${pr.number}](${pr.url}) at head \`${pr.headSha}\` is missing its required ${missing.length === 1 ? "check" : "checks"} ${checks}: ${r.why}, so GitHub most likely deleted the workflow run when its Actions retention expired, and the run cannot be re-run.`,
    "",
    tried,
    "",
    "A human can re-trigger CI on this head without a new commit: convert the PR to draft and back to ready for review (make sure it ends ready), or start the workflow by hand if it allows that. A new commit would also work, but it changes the head and its approvals. Sergeant won't try again on this head, and continues once the checks report.",
  ].join("\n");
}

/** Keeps, per PR, the required checks seen passed on its current head; a new head starts afresh. */
function remember(state: Pick<TaskState, "passedChecks">, pr: PullRequestFacts): boolean {
  const passed = pr.checks.required.filter((c) => c.state === "passed").map((c) => c.name);
  const kept = state.passedChecks.find((p) => samePr(p, pr));
  if (kept?.headSha === pr.headSha) {
    const added = passed.filter((c) => !kept.checks.includes(c));
    kept.checks.push(...added);
    return added.length > 0;
  }
  if (!kept && passed.length === 0) return false;
  state.passedChecks = [...state.passedChecks.filter((p) => !samePr(p, pr)), { repo: pr.repo, number: pr.number, headSha: pr.headSha, checks: passed }];
  return true;
}

/** Why the missing checks count as expired, or undefined while they may simply not have reported yet. */
async function expiredBecause(pr: PullRequestFacts, missing: string[], state: Pick<TaskState, "passedChecks">, github: Ports["github"], log: Context["log"]): Promise<string | undefined> {
  const seen = state.passedChecks.find((p) => samePr(p, pr) && p.headSha === pr.headSha)?.checks ?? [];
  if (missing.some((c) => seen.includes(c))) return "Sergeant saw it pass on this head earlier";
  const outlived = await github.outlivedActionsRetention?.(pr.repo, pr.headSha).catch((e: Error) => {
    log(`${pr.repo}#${pr.number}: could not read when its head was committed: ${e.message}`);
    return false;
  });
  return outlived ? "the head was committed longer ago than the repository keeps its Actions runs" : undefined;
}

/**
 * For each of the task's open, ready PRs from the worker whose head is missing required checks GitHub
 * expired: re-triggers CI on that head once, then tells the issue once if that failed or did not bring
 * the checks back within `RETRIGGER_GRACE_MS`. Returns how many it re-triggered, so the caller rereads
 * the PRs before a turn.
 */
export async function recoverExpiredChecks(
  pullRequests: PullRequestFacts[],
  state: Pick<TaskState, "passedChecks" | "checkRecoveries">,
  deps: Pick<Ports, "github" | "linear" | "workerLogin">,
  ctx: Context,
): Promise<number> {
  const now = ctx.now ?? Date.now;
  let retriggered = 0;
  for (const pr of pullRequests.filter((p) => p.state === "open")) {
    if (remember(state, pr)) await ctx.save();
    const missing = pr.checks.required.filter((c) => c.state === "missing").map((c) => c.name);
    // Only Sergeant's own PRs are toggled. A draft is not ready for CI, and a conflicted PR gets no
    // `pull_request` CI at all: its rebase makes a new head.
    if (missing.length === 0 || pr.draft || pr.author !== deps.workerLogin || pr.mergeableState === "dirty") continue;
    let recovery = state.checkRecoveries.find((r) => samePr(r, pr) && r.headSha === pr.headSha);
    if (!recovery) {
      const why = await expiredBecause(pr, missing, state, deps.github, ctx.log);
      if (!why) continue;
      const attempt = { repo: pr.repo, number: pr.number, headSha: pr.headSha, checks: missing, why, at: new Date(now()).toISOString() };
      const retrigger = deps.github.retriggerChecks;
      recovery = retrigger
        ? await retrigger({ repo: pr.repo, number: pr.number, expectedHeadSha: pr.headSha }).then(
            (): Recovery => ({ ...attempt, outcome: "retriggered", reason: "converted to draft and back to ready for review" }),
            (e: Error): Recovery => ({ ...attempt, outcome: "failed", reason: e.message }),
          )
        : { ...attempt, outcome: "failed", reason: "this Sergeant's GitHub connection cannot re-trigger CI" };
      state.checkRecoveries = [...state.checkRecoveries.filter((r) => !samePr(r, pr)), recovery];
      await ctx.save();
      ctx.log(`${pr.repo}#${pr.number}: required checks ${missing.join(", ")} missing (${why}); re-trigger on the same head ${recovery.outcome}: ${recovery.reason}`);
      if (recovery.outcome === "retriggered") {
        retriggered++;
        continue;
      }
    }
    if (recovery.reportedAt) continue;
    if (recovery.outcome === "retriggered" && now() - Date.parse(recovery.at) < RETRIGGER_GRACE_MS) continue;
    const key = expiredChecksKey(ctx.issueId, pr);
    const posted =
      ctx.agentComments.some((c) => c.id === commentIdFor(key)) ||
      (await deps.linear.postComment({ issueId: ctx.issueId, body: expiredChecksComment(pr, recovery, missing), key }).then(
        () => (ctx.log(`${pr.repo}#${pr.number}: told the issue its required checks are still missing`), true),
        (e: Error) => (ctx.log(`${pr.repo}#${pr.number}: missing-checks comment not posted: ${e.message}`), false),
      ));
    if (!posted) continue;
    recovery.reportedAt = new Date(now()).toISOString();
    await ctx.save();
  }
  return retriggered;
}

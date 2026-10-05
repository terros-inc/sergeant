import { checkDelegation, commentIdFor, reportedClosing, type LinearPort, type ReviewReport, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import type { ActionOutcome } from "./execute.ts";

// TECH-5227: after each review round Sergeant says on the issue, in about five lines, what changed, the
// review's verdict, what happens next, and the cost so far (cost.ts), so a human need not open the PR.
// Every finished review gets its own comment, keyed by its review run, posted after the next turn, also
// when that turn asks a question or merges. Built only from the worker and reviewer reports and the run
// records; nothing is stored: a round is told once because Linear keeps one comment per key.
// `review.progressComments: false` in the installation config turns it off (loop.ts).

/** A round to report: its comment key, and the lines that say what changed and the verdict. */
export type Progress = { key: string; lines: string[]; approved: boolean; cost: string };

const short = (sha: string) => sha.slice(0, 12);
const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const count = (n: number, what: string) => `${n} ${what} finding${n === 1 ? "" : "s"}`;

/**
 * Every finished review not yet told on the issue whose PRs have not moved on since (a new head, a
 * merge): a superseded round is never reported late. `cost` is the cost-so-far line each one ends with.
 */
export function pendingProgress(situation: Pick<SituationReport, "conversation" | "runs" | "pullRequests">, cost: string): Progress[] {
  const { conversation, runs, pullRequests } = situation;
  return runs.flatMap((review) => {
    const report = review.role === "reviewer" && review.status === "succeeded" ? review.report : null;
    if (!report) return [];
    const key = `progress:${conversation.issue.id}:${review.runId}`;
    if (conversation.agentComments.some((c) => c.id === commentIdFor(key))) return [];
    const heads = report.reviewed.map((h) => ({ ...h, pr: pullRequests.find((p) => p.repo === h.repo && p.number === h.number) }));
    if (heads.some((h) => h.pr?.state !== "open" || h.pr.headSha !== h.headSha)) return [];
    return [roundOf(report, heads, runs, key, cost)];
  });
}

function roundOf(
  report: ReviewReport,
  heads: { repo: string; number: number; headSha: string; pr?: { url: string } | undefined }[],
  runs: RunRecord[],
  key: string,
  cost: string,
): Progress {
  const atHead = (p: { repo: string; number: number; headSha: string }) => report.reviewed.some((h) => h.repo === p.repo && h.number === p.number && h.headSha === p.headSha);
  const worker = runs.findLast((r) => r.role === "worker" && r.report?.pullRequests.some(atHead));
  const summary = worker?.role === "worker" ? (worker.report?.summary.split(/(?<=[.!?])\s/)[0] ?? "") : "";
  const blocking = report.findings.filter((f) => f.severity === "blocking");
  const others = report.findings.filter((f) => f.severity !== "blocking");
  const counts = [...(blocking.length > 0 ? [count(blocking.length, "blocking")] : []), ...(others.length > 0 ? [count(others.length, "non-blocking")] : [])].join(" and ");
  const verdict =
    report.verdict === "approve"
      ? `approved${counts ? `, with ${counts}` : ""}`
      : `${report.verdict === "needs_human" ? "a human is needed" : "changes requested"}${counts ? `: ${counts}` : ""}`;
  // At most two findings, blocking first, one line each; the rest are counted.
  const shown = [...blocking, ...others].slice(0, 2);
  const more = report.findings.length - shown.length;
  const findings = shown.map((f, i) => `- ${f.severity === "blocking" ? "Blocking" : "Non-blocking"}: ${oneLine(f.description.split("\n")[0] ?? "", 160)}${i === shown.length - 1 && more > 0 ? ` (+${more} more)` : ""}`);
  return {
    key,
    approved: report.verdict === "approve",
    cost,
    lines: [
      `**Progress:** ${summary.trim() ? oneLine(summary, 240) : "a review round finished"}`,
      `Reviewed ${heads.map((h) => `[${h.repo}#${h.number}](${h.pr?.url}) at \`${short(h.headSha)}\``).join(", ")}: ${verdict}.`,
      ...findings,
    ],
  };
}

/** What the round's turn did next, in one line; reasoning's own words stay in the PR and its runs. */
export function nextStep(outcomes: ActionOutcome[], runs: RunRecord[], progress: Progress): string {
  const done = (kind: ActionOutcome["action"]["kind"]) => outcomes.some((o) => o.status === "done" && o.action.kind === kind);
  const { approved } = progress;
  const merged = outcomes.flatMap((o) => (o.status === "done" && o.merged ? [o.merged.pr] : []));
  if (merged.some((pr) => reportedClosing(runs, pr) === true)) return "Next: merged; Sergeant posts the outcome and the task's total cost.";
  if (merged.length > 0) return "Next: this PR is merged as part of the issue; Sergeant continues with the rest.";
  if (done("accept_as_is")) return "Next: nothing; the work is accepted as it is.";
  if (done("send_run") || done("start_worker")) return approved ? "Next: a worker continues the remaining work." : "Next: a worker fixes the findings.";
  if (done("start_reviewer")) return "Next: another review.";
  if (outcomes.some((o) => o.action.kind === "merge_pr")) return "Next: merging once GitHub allows it.";
  return approved ? "Next: merging once the PR is ready." : "Next: Sergeant decides how to handle the findings.";
}

/**
 * Posts each finished round not yet told (`pendingProgress`) as its own comment under its key, so a
 * retry posts nothing more, after the turn that follows it, whose outcomes say what happens next. Only
 * while the issue is still delegated to Sergeant (A1), read live: a closing merge this turn may already
 * have moved it to Done. Never fails the turn: a failure is left to the next turn.
 */
export async function postProgress(
  issueId: string,
  situation: Pick<SituationReport, "conversation" | "runs" | "pullRequests">,
  cost: string,
  outcomes: ActionOutcome[],
  deps: { linear: Pick<LinearPort, "readConversation" | "postComment">; agentUserId: string },
  log: (line: string) => void,
): Promise<void> {
  const rounds = pendingProgress(situation, cost);
  if (rounds.length === 0) return;
  try {
    const { issue } = await deps.linear.readConversation(issueId);
    if (!checkDelegation(issue, deps.agentUserId).allowed) return;
    for (const round of rounds) {
      await deps.linear.postComment({ issueId: issue.id, body: [...round.lines, nextStep(outcomes, situation.runs, round), round.cost].join("\n"), key: round.key });
      log(`posted the progress comment ${round.key}`);
    }
  } catch (e) {
    log(`could not post a progress comment; the next turn tries again: ${(e as Error).message}`);
  }
}

import { checkLive, commentIdFor, type Conversation, type LinearPort, type SituationReport } from "@terros/sergeant-contracts";
import type { ActionOutcome } from "./execute.ts";

// TECH-5227: after each review round Sergeant says on the issue, in about five lines, what changed, the
// review's verdict, and what happens next, so a human need not open the PR. A round ends at the first
// turn after its reviewer finished. When that turn asks a human or makes the closing merge, the summary
// is folded into that one comment instead (the question, or the merge's outcome comment). Built only
// from the worker and reviewer reports; nothing is stored. A round is reported once: a standalone post
// is keyed by its review run, and a folded summary is recognized on the issue by its reviewed heads.
// `review.progressComments: false` in the installation config turns all of it off (loop.ts).

/**
 * The round to report: its comment key, the lines that say what changed and the verdict, and whether a
 * question this turn carries them (`askHuman` sets it), so no comment of its own is posted.
 */
export type Progress = { key: string; lines: string[]; approved: boolean; folded?: boolean };

const short = (sha: string) => sha.slice(0, 12);
const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const count = (n: number, what: string) => `${n} ${what} finding${n === 1 ? "" : "s"}`;

/**
 * The newest finished review's round, unless it was already reported or its PRs have moved on since
 * (a new head, a merge): a superseded round is never reported late.
 */
export function pendingProgress(situation: Pick<SituationReport, "conversation" | "runs" | "pullRequests">): Progress | undefined {
  const { conversation, runs, pullRequests } = situation;
  const review = runs.findLast((r) => r.role === "reviewer" && r.status === "succeeded" && r.report !== null);
  const report = review?.role === "reviewer" ? review.report : null;
  if (!review || !report) return undefined;
  const heads = report.reviewed.map((h) => ({ ...h, pr: pullRequests.find((p) => p.repo === h.repo && p.number === h.number) }));
  if (heads.some((h) => h.pr?.state !== "open" || h.pr.headSha !== h.headSha)) return undefined;
  const key = `progress:${conversation.issue.id}:${review.runId}`;
  if (reported(conversation, key, report.reviewed)) return undefined;

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
    lines: [
      `**Progress:** ${summary.trim() ? oneLine(summary, 240) : "a review round finished"}`,
      `Reviewed ${heads.map((h) => `[${h.repo}#${h.number}](${h.pr?.url}) at \`${short(h.headSha)}\``).join(", ")}: ${verdict}.`,
      ...findings,
    ],
  };
}

/**
 * Whether the round was already told on the issue: posted under its key, or folded into a comment that
 * names every reviewed head. A comment that happens to name those heads counts too, so a round is at
 * worst not reported, never reported twice.
 */
function reported(conversation: Conversation, key: string, heads: { headSha: string }[]): boolean {
  const id = commentIdFor(key);
  return conversation.agentComments.some((c) => c.id === id || (c.body.includes("Reviewed") && heads.every((h) => c.body.includes(short(h.headSha)))));
}

/** What the round's turn did next, in one line; reasoning's own words stay in the PR and its runs. */
export function nextStep(outcomes: ActionOutcome[], progress: Progress): string {
  const done = (kind: ActionOutcome["action"]["kind"]) => outcomes.some((o) => o.status === "done" && o.action.kind === kind);
  const { approved } = progress;
  if (done("merge_pr")) return "Next: this PR is merged as part of the issue; Sergeant continues with the rest.";
  if (done("accept_as_is")) return "Next: nothing; the work is accepted as it is.";
  if (done("send_run") || done("start_worker")) return approved ? "Next: a worker continues the remaining work." : "Next: a worker fixes the findings.";
  if (done("start_reviewer")) return "Next: another review.";
  if (outcomes.some((o) => o.action.kind === "merge_pr")) return "Next: merging once GitHub allows it.";
  return approved ? "Next: merging once the PR is ready." : "Next: Sergeant decides how to handle the findings.";
}

/**
 * Posts the round's own comment under its key, so a retry posts nothing more, and only while the issue
 * is still Sergeant's (A1, A2), read live. Never fails the turn: a failure is left to the next turn.
 */
export async function postProgress(
  issueId: string,
  progress: Progress,
  outcomes: ActionOutcome[],
  deps: { linear: Pick<LinearPort, "readConversation" | "postComment">; agentUserId: string },
  log: (line: string) => void,
): Promise<void> {
  const body = [...progress.lines, nextStep(outcomes, progress)].join("\n");
  try {
    const { issue } = await deps.linear.readConversation(issueId);
    if (!checkLive(issue, deps.agentUserId).allowed) return;
    await deps.linear.postComment({ issueId: issue.id, body, key: progress.key });
    log("posted the review round's progress comment");
  } catch (e) {
    log(`could not post the progress comment; the next turn tries again: ${(e as Error).message}`);
  }
}

/** The round's summary folded into a comment the same turn posts anyway. */
export const withProgress = (body: string, progress: Progress | undefined) => (progress ? `${body}\n\n${progress.lines.join("\n")}` : body);

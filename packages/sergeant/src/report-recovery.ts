import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { conversationRevision, type GitHubPort, type ProposedAction, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { describeOutcome, execute, type Ports } from "./execute.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5259: a worker that exits without its report, or a reviewer whose report does not parse, leaves
// its head with no review standing. Waiting on reasoning for that used to burn the rest of the budget
// window, so the loop retries such a run at once, before the next turn, and says why: a reviewer is
// rerun on the same heads, a worker is restarted on its objective with an instruction to write its
// report. Once per run: a retry that also ends without one is left to reasoning, like a run whose start
// is not on record, that a later run already followed, or whose heads to review moved. So is one while
// the conversation has changed since the last turn (a human's reply to the budget question, a comment, an
// issue edit, a PR review): the retry starts only after reasoning has read it. Every such run
// gets one line in `report-recoveries.jsonl`, with what followed, so how often it happens is counted.
//
// TECH-6106: a worker usually quits this way after it pushed its work, ending its headless session to
// wait on CI it expected to be told about. A retry told to finish the objective spent most of its run
// confirming that work. So when the issue's branch has a head committed since the run started, the retry
// is report-only: it reviews what was pushed against the Task and CI, writes the report, and changes nothing.

/** How much of a run's report error a retry's brief and the telemetry carry. */
const ERROR_CHARS = 1_000;

type Context = { issueId: string; dir: string; log: (line: string) => void; save: () => Promise<void>; work?: () => boolean };

/**
 * Records each ended run of the task that has no usable report and retries those due one through the
 * Gate, like any start. Call it only while no run is going. `retried` when a retry started; `unposted`
 * the question to the owner a retry's start could not post (TECH-5217), for the loop to ask again.
 */
export async function recoverReports(
  situation: SituationReport,
  state: TaskState,
  ports: Ports,
  ctx: Context,
): Promise<{ retried: boolean; waitingForSlot?: boolean; unposted?: ProposedAction }> {
  const { runs } = situation;
  const lines: string[] = [];
  let retried = false;
  let waitingForSlot = false;
  let unposted: ProposedAction | undefined;
  // What a human said that no turn has read: the conversation the last turn saw (TECH-5034) differs, or
  // a human's PR review or comment came after that turn.
  const lastTurn = Date.parse(state.lastTurnAt ?? state.startedAt);
  const unread =
    state.seen?.revision !== conversationRevision(situation.conversation) ||
    situation.pullRequests.some((p) => p.humanFeedback.some((f) => Date.parse(f.updatedAt) > lastTurn));
  for (const [i, run] of runs.entries()) {
    if (run.status === "running" || run.status === "canceled" || run.report || state.reportRecoveries[run.runId]) continue;
    const at = new Date().toISOString();
    const problem = run.reportProblem ?? (/^no report written|left no result/.test(run.reportError ?? "") ? "missing" : "malformed");
    const error = (run.reportError ?? "").slice(0, ERROR_CHARS);
    const why = `${run.role} run ${run.runId} ended with no usable report (${problem}${error && `: ${error}`})`;
    const start = state.starts[run.runId];
    const skip = run.failureReason
      ? `it failed on ${run.failureReason}; its account is set aside and reasoning decides`
      : Object.values(state.reportRecoveries).some((r) => r.retryRunId === run.runId)
        ? "it was itself a retry, and Sergeant retries a run once"
        : runs.length > i + 1
          ? "a later run has started since"
          : !start
            ? "its start is not on record"
            : unread
              ? "the conversation changed since the last turn, so reasoning reads it first and decides"
              : start.kind === "start_reviewer" && start.subject.some((h) => !situation.pullRequests.some((p) => p.repo === h.repo && p.number === h.number && p.headSha === h.headSha))
              ? "a head it was to review has moved or is gone"
              : undefined;
    const fact = { at, issue: ctx.issueId, runId: run.runId, role: run.role, status: run.status, problem, reportError: error };
    if (skip || !start) {
      state.reportRecoveries[run.runId] = {};
      lines.push(JSON.stringify({ ...fact, recovery: "none", reason: skip }));
      ctx.log(`${why}; not retried: ${skip}`);
      continue;
    }
    // A resumed task may have released its service-wide task slot while it was waiting. Mark it
    // wanted and leave the eligible run untouched until the scheduler admits the task. Records that
    // only explain why no retry is due are telemetry and deliberately do not need a slot.
    if (ctx.work && !ctx.work()) {
      waitingForSlot = true;
      break;
    }
    const pushed = start.kind === "start_worker" ? await pushedSince(start, situation.conversation.issue.identifier, ports.github, ctx.log) : [];
    const outcome = await execute(retryOf(run, start, why, pushed), situation, ports);
    const retryRunId = outcome.status === "done" ? (outcome.result.runId as string) : undefined;
    state.reportRecoveries[run.runId] = retryRunId ? { retryRunId } : {};
    if (retryRunId) state.unconfirmedStarts = state.unconfirmedStarts.filter((id) => id !== retryRunId);
    retried ||= retryRunId !== undefined;
    if (outcome.status === "failed" && outcome.unposted) unposted ??= outcome.unposted;
    const described = describeOutcome(outcome);
    // The next turn's recentTurns say why the run was retried, or why the retry did not start.
    const reportOnly = pushed.length > 0 ? " It had pushed work, so the retry only reviews it and reports." : "";
    const summary = `Sergeant retried ${run.role} run ${run.runId} at once, before this turn, because it ended with no usable report (${problem}).${reportOnly}`;
    state.recentTurns = [...state.recentTurns, { at, summary, outcomes: [described] }].slice(-8);
    lines.push(JSON.stringify({ ...fact, recovery: retryRunId ? "retried" : "retry_not_started", ...(retryRunId ? { retryRunId } : { reason: described }), ...(pushed.length > 0 && { reportOnly: true, pushed }) }));
    ctx.log(`${why}; retrying it${reportOnly && " report-only"}: ${described}`);
  }
  if (lines.length > 0) {
    await appendFile(join(ctx.dir, "report-recoveries.jsonl"), lines.map((l) => `${l}\n`).join(""));
    await ctx.save();
  }
  return { retried, ...(waitingForSlot && { waitingForSlot }), ...(unposted && { unposted }) };
}

type WorkerStart = Extract<TaskState["starts"][string], { kind: "start_worker" }>;

/**
 * The issue's branches in the run's repositories whose head was committed since the turn that started it:
 * what the run pushed. None for a start recorded without its time, and none, logged, when GitHub cannot
 * say: the retry then finishes the objective, as before.
 */
async function pushedSince(start: WorkerStart, identifier: string, github: GitHubPort, log: (line: string) => void): Promise<string[]> {
  const read = github.issueBranches?.bind(github);
  if (!start.at || !read) return [];
  const since = Date.parse(start.at);
  try {
    const branches = await Promise.all(start.repositories.map(async (repo) => (await read(repo, identifier)).map((b) => ({ repo, ...b }))));
    return branches.flat().filter((b) => Date.parse(b.committedAt) >= since).map((b) => `${b.repo}: ${b.branch} at ${b.sha}`);
  } catch (e) {
    log(`could not read ${identifier}'s branches, so a retry finishes the objective: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Nothing tells a headless agent a background job finished: the run ends with its turn. */
const HEADLESS = "You run headless: when your turn ends the run ends, and nothing wakes you later, so never end it to wait for CI or a background job.";

/**
 * The same start again, saying why: the reviewer on the same heads; the worker told to finish and report,
 * or only to review and report on what it pushed.
 */
function retryOf(run: RunRecord, start: TaskState["starts"][string], why: string, pushed: string[]): ProposedAction {
  if (start.kind === "start_reviewer") {
    const focus = `Sergeant reran this review at once because the previous ${why}. Review the same heads, and end with exactly one valid sergeant-report block as the Report section says.${start.focus ? `\n\n${start.focus}` : ""}`;
    return { kind: "start_reviewer", subject: start.subject, focus: focus.slice(0, 4_000) };
  }
  const instruction =
    pushed.length > 0
      ? `Sergeant restarted this run at once because the previous ${why}. It had already pushed its work:

${pushed.map((p) => `- ${p}`).join("\n")}

This run only reports on that work; do not re-implement anything, change no code, and push nothing. Check out that branch and read any PR it opened (see "Where earlier work stands"). Review the pushed work against the Task section (its Done-when, where it has one) and read the PR's CI once with \`gh pr checks\`; do not wait for checks still running, since Sergeant watches CI after your report. If the branch has no PR yet, open one as rules 4 and 5 say. Then write /workspace/sergeant-report.md exactly as the Report section says, naming the pushed head. Where the work falls short of the Task, or a check failed, say what remains in the report, with outcome \`partial\`, rather than doing it. ${HEADLESS}`
      : `Sergeant restarted this work at once because the previous ${why}. Its workspace is gone, but anything it pushed is on origin: continue from its branch and any PR it opened (see "Where earlier work stands"), finish what remains of the objective below, and end by writing /workspace/sergeant-report.md exactly as the Report section says. ${HEADLESS}`;
  const objective = `${instruction}

The objective ${run.runId} was given:

${start.objective}`;
  return { kind: "start_worker", repositories: start.repositories, objective: objective.slice(0, 16_000) };
}

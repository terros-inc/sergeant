import {
  checkBudget,
  commentIdFor,
  reportedClosing,
  type BudgetStatus,
  type Conversation,
  type GateVerdict,
  type PullRequestFacts,
  type PullRequestRef,
  type RepoSlug,
  type RunId,
  type RunRecord,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { budgetQuestion, budgetQuestionKey } from "./budget.ts";
import { recordStop } from "./cancel.ts";
import { askHuman, checkLive, describeOutcome, type Ports } from "./execute.ts";
import { openQuestion } from "./question.ts";

// The checks every poll of an unmerged task makes before a turn (loop.ts): whether the issue is still
// Sergeant's (A1/A2), its budget, and the questions it waits on a human for. Each either lets the poll
// go on or says why it does not; the loop does the waiting.

type Log = (line: string) => void;

/**
 * Before anything starts and on every poll: an issue not delegated to the V2 agent, or no longer
 * (A1), or that a human moved to Backlog, Canceled, or Done (A2), is not Sergeant's to work on. Each
 * is the human's cancel, recorded here and driven by the loop: its runs are canceled so they publish
 * nothing more, its open PRs are closed, and the loop stops only once the runner confirms each run
 * stopped. Done after the worker's closing PR merged is the task's normal end instead, which the loop
 * takes. The executor re-checks both live before each effect. Returns why the task is stopping.
 */
export async function checkStop(
  conversation: Conversation,
  runs: RunRecord[],
  ctx: { dir: string; enrolledRepositories: RepoSlug[] },
  deps: Ports,
): Promise<string | undefined> {
  const active = checkLive(conversation.issue, deps.agentUserId);
  if (active.allowed) return undefined;
  const finished =
    active.rule === "A2" &&
    conversation.issue.stateType === "completed" &&
    landedOf(await readPullRequests(runs, conversation.issue.linkedPullRequests, ctx.enrolledRepositories, deps), runs, deps.workerLogin) !== undefined;
  if (finished) return undefined;
  await recordStop(ctx.dir, active.rule === "A1" ? { cause: "undelegated" } : { cause: "state", state: conversation.issue.state });
  return active.reason;
}

export type BudgetCheck = {
  budget: BudgetStatus;
  exhausted: GateVerdict;
  /** The budget question of the current window, if Linear has it. */
  budgetAsked?: Conversation["agentComments"][number];
};

/**
 * The holds before the PRs are read: an exhausted budget with work still running, a run whose status
 * is unknown, and a question Sergeant asked that has no human reply. Returns the budget the turn sees,
 * or which hold applies, already logged.
 */
export async function checkHolds(
  conversation: Conversation,
  runs: { live: RunId[]; unknown: { unknown: RunId; error: string }[] },
  budget: { grants: number; of: (questionId?: string) => BudgetStatus },
  deps: Ports,
  log: Log,
): Promise<BudgetCheck | { hold: "budget" | "unknown" | "question" }> {
  // The budget question of the current window, if Linear has it: its id is derived from a key, so a
  // crash between posting it and saving anything loses nothing.
  const questionId = commentIdFor(budgetQuestionKey(conversation.issue.id, budget.grants));
  const budgetAsked = conversation.agentComments.find((c) => c.id === questionId);
  const status = budget.of(budgetAsked && questionId);
  // UNF-728: an exhausted budget cancels running work through the runner, every poll until confirmed,
  // whatever else is going on; the executor refuses every new effect (B1).
  const exhausted = checkBudget(status, new Date());
  if (!exhausted.allowed && runs.live.length > 0) {
    log(`budget exhausted (${exhausted.reason}): canceling ${runs.live.join(", ")}`);
    await cancelRuns(runs.live, deps, log);
    return { hold: "budget" };
  }
  if (runs.unknown.length > 0) {
    log(`waiting: status unavailable for ${runs.unknown.map((u) => `${u.unknown} (${u.error})`).join(", ")}`);
    return { hold: "unknown" };
  }
  // While the question Sergeant asked is unanswered it takes no turn and makes no effect, and no
  // runaway guard ends the wait for the human (UNF-727). Any human change ends it: see question.ts.
  const question = openQuestion(conversation);
  if (question) {
    log(`waiting: the question posted at ${question.createdAt} has no human reply yet`);
    return { hold: "question" };
  }
  return { budget: status, exhausted, ...(budgetAsked && { budgetAsked }) };
}

/**
 * One question per exhausted window, posted like any question but under a key of the task and the
 * window, and retried every poll until Linear shows it. Until a human replies after it, nothing
 * happens and no runaway guard ends the wait (UNF-727); the reply wakes a turn, which may grant one
 * more window. Returns whether the poll holds.
 */
export async function holdForBudget(situation: SituationReport, check: BudgetCheck, grants: number, deps: Ports, log: Log): Promise<boolean> {
  const { exhausted, budgetAsked } = check;
  const conversation = situation.conversation;
  if (!exhausted.allowed && !budgetAsked) {
    const key = budgetQuestionKey(conversation.issue.id, grants);
    const asked = await askHuman(budgetQuestion(situation, exhausted.reason), situation, deps, key);
    log(`budget exhausted (${exhausted.reason}): asking whether to continue: ${describeOutcome(asked)}`);
    return true;
  }
  if (budgetAsked && !conversation.humanComments.some((c) => Date.parse(c.createdAt) > Date.parse(budgetAsked.createdAt))) {
    log(`waiting: the budget question posted at ${budgetAsked.createdAt} has no human reply yet`);
    return true;
  }
  return false;
}

/**
 * Cancels each run through the runner and returns how many are not confirmed stopped. The runner
 * resolves `cancel` only once the run is stopped or gone; anything else is retried next poll.
 */
export async function cancelRuns(runIds: RunId[], deps: Ports, log: Log): Promise<number> {
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

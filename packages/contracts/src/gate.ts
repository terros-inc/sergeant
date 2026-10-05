import type { AgentComment, Conversation, ConversationRevision, PullRequestRef, RepoSlug } from "./conversation.ts";
import type { HumanPullRequestFeedback, PullRequestFacts } from "./github.ts";
import type { MergePr, ReviewStanding } from "./actions.ts";
import type { RunRecord } from "./runs.ts";
import { checkBudget, type BudgetStatus } from "./budget.ts";
import type { RefusedMerge } from "./situation.ts";
import { checkLive, isOwned, type GateVerdict, type Ownership } from "./action-gate.ts";

export {
  checkClose,
  checkDelegation,
  checkIssueState,
  checkLive,
  checkSend,
  checkStart,
  STOP_STATE_TYPES,
  type GateVerdict,
  type Ownership,
} from "./action-gate.ts";

// The Gate: pure checks that refuse a proposed action which would cause a material harm (00 P3).
// Rule ids follow 03 §7 and 08 §7; only the rules the walking skeleton needs exist.

const allow: GateVerdict = { allowed: true };
const deny = (rule: string, reason: string): GateVerdict => ({ allowed: false, rule, reason });

/**
 * Whether merging this PR completes the issue, as the latest worker report naming it says
 * (`closesIssue`); undefined when no worker report names it. Only the closing PR's merge completes
 * the task: a `Part of` PR's merge leaves it open for the rest (08 §5).
 */
export function reportedClosing(runs: RunRecord[], pr: PullRequestRef): boolean | undefined {
  for (const run of runs.toReversed()) {
    if (run.role !== "worker") continue;
    const reported = run.report?.pullRequests.find((r) => r.repo === pr.repo && r.number === pr.number);
    if (reported) return reported.closesIssue;
  }
  return undefined;
}

/** A GitHub/Linear closing keyword naming the issue, e.g. `Fixes UNF-1`, `closes: UNF-1`, or one before its URL. */
export const hasClosingReference = (body: string, identifier: string) =>
  new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[:\\s]+(?:\\S*/)?${identifier}\\b`, "i").test(body);

export type MergeFacts = Ownership & {
  /** Re-read from GitHub immediately before merging. */
  pr: PullRequestFacts;
  /** The issue's identifier (`UNF-1`), which a closing reference names. */
  issueIdentifier: string;
  /** This task's other PRs as the deciding turn saw them. */
  pullRequests: PullRequestFacts[];
  /** Recomputed from a live Linear read immediately before merging; `linkedPullRequests` is from it too. */
  liveConversationRevision: ConversationRevision;
  /** `issueRevision` of the live issue's title and description, from the same read. */
  liveIssueRevision: string;
  /** The live issue's non-human comments, Sergeant's questions among them, from the same read. */
  agentComments: AgentComment[];
  enrolledRepositories: RepoSlug[];
  runs: RunRecord[];
  /** Merges GitHub refused by repository policy, and heads handed to a human (TECH-5244), from the task's record. */
  refusedMerges: RefusedMerge[];
  /**
   * TECH-5244: the head is checked to be handed to a human in a `human` repository, never merged, and
   * that handoff marks a draft ready for review itself, so M7 lets a draft through.
   */
  handToHuman?: boolean;
};

/**
 * The humans whose latest review of the PR, at any head, requests changes (M8). A later approval or a
 * dismissal by anyone with the right clears that reviewer's request; a later plain comment does not,
 * as on GitHub.
 */
export function outstandingChangeRequests(feedback: HumanPullRequestFeedback[]): string[] {
  return standingChangeRequests(feedback).map((r) => r.author);
}

/** Each human's latest decisive review, where it requests changes. */
function standingChangeRequests(feedback: HumanPullRequestFeedback[]): HumanPullRequestFeedback[] {
  const latest = new Map<string, HumanPullRequestFeedback>();
  const decisive = feedback
    .filter((f) => f.kind === "review" && f.state !== "COMMENTED")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const review of decisive) latest.set(review.author, review);
  return [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED");
}

/** What "may this merge now?" reads beyond the merge facts: the live issue (A1, A2) and the budget as of `now` (B1). */
export type MergePreflightFacts = MergeFacts & { issue: Conversation["issue"]; agentUserId: string; budget: BudgetStatus; now: Date };

/**
 * May this merge happen now (TECH-5065): the live checks (A1, A2), the merge gate, and the budget (B1),
 * in that order. The one preflight `execute(merge_pr)` applies right before GitHub's merge, and the
 * one a re-review request is asked against, so neither can drift from the other.
 */
export function checkMayMerge(action: MergePr & { conversationRevision: ConversationRevision }, facts: MergePreflightFacts): GateVerdict {
  const live = checkLive(facts.issue, facts.agentUserId);
  if (!live.allowed) return live;
  const merge = checkMerge(action, facts);
  if (!merge.allowed) return merge;
  return checkBudget(facts.budget, facts.now);
}

/**
 * The humans to ask on the issue to re-review or dismiss (TECH-4992): each requested changes on an
 * earlier head, which this head has since addressed, and the merge preflight would merge this head,
 * under some run's review standing, but for M8 (TECH-5051, TECH-5065). A review whose commit GitHub no
 * longer reports (commitId null, say after a force push) was not left on this head, so it counts as
 * addressed: asking costs nothing, and M8 still holds. Empty when there is no one to ask yet.
 */
export function rereviewRequests(facts: MergePreflightFacts): string[] {
  const { pr, runs, liveConversationRevision: conversationRevision } = facts;
  const asked = standingChangeRequests(pr.humanFeedback).filter((r) => r.commitId !== pr.headSha).map((r) => r.author);
  // M8 is the only rule that reads human reviews; without them the preflight decides everything else.
  const withoutM8 = { ...facts, pr: { ...pr, humanFeedback: [] } };
  const standings = runs.map((r): ReviewStanding => (r.role === "reviewer" ? { kind: "reviewed", reviewRunId: r.runId } : { kind: "not_required", workerRunId: r.runId }));
  return standings.some((reviewStanding) => checkMayMerge({ kind: "merge_pr", repo: pr.repo, number: pr.number, expectedHeadSha: pr.headSha, reviewStanding, conversationRevision }, withoutM8).allowed) ? asked : [];
}

/** The first line of every question Sergeant asks on an issue (07 §4). */
export const QUESTION_HEADING = "**Question for you**";

/**
 * The inputs a run reported it could not read that no Sergeant question on the issue names yet (M14).
 * Only Sergeant's own questions count, not other bot or integration comments that quote the input.
 * A question stops the task until a human next changes the conversation (Q1); M14 checks only that it
 * was asked, not that the human's change answered it.
 */
export function unaskedInputs(runs: RunRecord[], agentComments: AgentComment[]): string[] {
  const inputs = new Set(runs.flatMap((r) => r.report?.unreadableInputs ?? []).map((i) => i.trim()).filter(Boolean));
  const questions = agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING)).map((c) => c.body.toLowerCase());
  return [...inputs].filter((i) => !questions.some((q) => q.includes(i.toLowerCase())));
}

/**
 * L1 (no unreviewed, red, or unmergeable merge), M2 (only this task's PRs), M9 (no early or missing completion),
 * L4 (no merge that overtakes unseen human input or a human's requested changes), M12 (no retry
 * after a bounded merge handoff while nothing changed), M13 (no review standing given against an
 * earlier title or description), and M14 (no merge past an input a run could not read, unasked).
 * `conversationRevision` is the one the proposing turn saw, attached by the core, not by reasoning.
 */
export function checkMerge(
  action: MergePr & { conversationRevision: ConversationRevision },
  facts: MergeFacts,
): GateVerdict {
  const { repo, number, expectedHeadSha: sha } = action;
  const { pr } = facts;
  if (!facts.enrolledRepositories.includes(repo)) return deny("M1", `${repo} is not enrolled`);
  if (pr.repo !== repo || pr.number !== number) return deny("M4", "live facts are for a different PR");
  if (!isOwned(action, pr.author, facts)) return deny("M2", `${repo}#${number} is not this task's PR`);
  if (pr.headSha !== sha) return deny("M4", `head moved: expected ${sha}, live ${pr.headSha}`);

  // M8: a human's "changes requested" outranks Sergeant's own reviewer, whatever head it was left on.
  const requested = outstandingChangeRequests(pr.humanFeedback);
  if (requested.length > 0) return deny("M8", `changes requested by ${requested.join(", ")} and not since approved or dismissed`);

  const { checks } = pr;
  if (checks.sha !== sha) return deny("M5", `checks were read for ${checks.sha}, not ${sha}`);
  if (checks.required.length === 0) return deny("M5", "the base branch has no required checks");
  const notGreen = checks.required.filter((c) => c.state !== "passed");
  if (notGreen.length > 0) {
    return deny("M5", `required checks not passed: ${notGreen.map((c) => `${c.name}=${c.state}`).join(", ")}`);
  }

  const standing = checkStanding(action.reviewStanding, { repo, number, sha }, facts.runs);
  if (standing) return deny("M6", standing);

  // M13: the standing must judge the work against the current acceptance criteria. A run that started
  // before the title or description changed checked it against the old text (07 §10). A record made
  // before runs recorded their issue revision is not judged here.
  const judge = action.reviewStanding.kind === "reviewed" ? action.reviewStanding.reviewRunId : action.reviewStanding.workerRunId;
  const judged = facts.runs.find((r) => r.runId === judge)?.issueRevision;
  if (judged !== undefined && judged !== facts.liveIssueRevision) {
    return deny("M13", `${judge} checked this head against an earlier title or description of the issue; review it against the current one`);
  }

  // M14: an input the issue depends on that a run could not read is a human's call, never reasoning's.
  const unasked = unaskedInputs(facts.runs, facts.agentComments);
  if (unasked.length > 0) return deny("M14", `a run could not read ${unasked.join(", ")}; ask a human (ask_human naming each) before merging`);

  // M7: GitHub must say the PR can merge.
  const unmergeable = facts.handToHuman && pr.mergeableState === "draft" && pr.mergeable === true ? null : mergeRefusal(pr);
  if (unmergeable) return deny("M7", unmergeable);

  // M9: the PR body agrees with the worker's report on whether this merge completes the issue
  // (`Fixes` for the closing PR, `Part of` for the rest), and the closing PR merges last. Unknown fails closed.
  const closing = reportedClosing(facts.runs, pr);
  if (closing === undefined) return deny("M9", `no worker report says whether ${repo}#${number} closes the issue`);
  if (hasClosingReference(pr.body, facts.issueIdentifier) !== closing) {
    return deny("M9", closing
      ? `the worker reports ${repo}#${number} closes ${facts.issueIdentifier}, but its body has no closing reference`
      : `the worker reports ${repo}#${number} as Part of ${facts.issueIdentifier}, but its body carries a closing reference`);
  }
  const open = facts.pullRequests.filter((p) => p.state === "open" && !(p.repo === repo && p.number === number));
  if (closing && open.length > 0) return deny("M9", `the closing PR merges last; still open: ${open.map((p) => `${p.repo}#${p.number}`).join(", ")}`);

  if (facts.liveConversationRevision !== action.conversationRevision) {
    return deny("M10", "the conversation (Linear, or human feedback on the task's PRs) changed since the deciding turn; take another turn");
  }

  const refused = facts.refusedMerges.find((r) => r.repo === repo && r.number === number && r.headSha === sha);
  if (refused?.conversationRevision === facts.liveConversationRevision) {
    if (refused.human) return deny("M12", `this head was handed to a human to merge (${refused.reason}) and nothing has changed since; a human merges it`);
    return deny("M12", `GitHub did not merge this head after its bounded attempts (${refused.reason}) and nothing has changed since; a human merges it`);
  }

  // A merge ends its turn, so it must not leave a run working on the task, including one its turn started.
  const active = facts.runs.filter((r) => r.status === "running");
  if (active.length > 0) return deny("M11", `runs still active: ${active.map((r) => `${r.role} ${r.runId}`).join(", ")}`);
  return allow;
}

/**
 * M7: why GitHub would not merge the PR now, or null when it would (08 §7, TECH-5013): `mergeable` is
 * true and `mergeable_state` is `clean`, `unstable` (past M5 only non-required checks failed), or
 * `blocked`. The ruleset's required approval comes only from the merge's own approval after this Gate,
 * so every PR waiting for Sergeant reads `blocked`; anything else blocking it makes GitHub refuse the
 * merge, which M12 hands to a human. The other states are not refusals by policy: a later read that
 * changes them wakes a turn (TECH-4991), so reasoning waits, or has a worker rebase, and tries again.
 * Every reason names the state.
 */
export function mergeRefusal(pr: Pick<PullRequestFacts, "mergeable" | "mergeableState">): string | null {
  const state = `GitHub's mergeable_state is ${pr.mergeableState}`;
  if (pr.mergeable === null || pr.mergeableState === "unknown") return `GitHub is still computing whether the PR is mergeable (${state}); wait`;
  if (pr.mergeable === false || pr.mergeableState === "dirty") return `GitHub reports the PR not mergeable (${state}: it conflicts with its base); a worker rebases it`;
  switch (pr.mergeableState) {
    case "clean":
    case "unstable":
    case "blocked":
      return null;
    case "behind":
      return `${state}: the head is behind its base; a worker rebases it`;
    case "draft":
      return `${state}: the PR is a draft`;
    case "has_hooks":
      return `${state}, not clean or unstable`;
  }
}

/** Returns why the standing does not cover this exact head, or null when it does (06 §6). */
function checkStanding(
  standing: ReviewStanding,
  head: { repo: RepoSlug; number: number; sha: string },
  runs: RunRecord[],
): string | null {
  const covers = (r: { repo: RepoSlug; number: number; headSha: string }) =>
    r.repo === head.repo && r.number === head.number && r.headSha === head.sha;

  if (standing.kind === "reviewed") {
    const run = runs.find((r) => r.runId === standing.reviewRunId);
    if (run?.role !== "reviewer") return `${standing.reviewRunId} is not a reviewer run of this task`;
    if (run.status !== "succeeded" || !run.report) return `review ${run.runId} has no successful report`;
    if (!run.report.reviewed.some(covers)) return `review ${run.runId} did not review head ${head.sha}`;
    if (run.report.verdict !== "approve") return `review ${run.runId} verdict is ${run.report.verdict}`;
    const blocking = run.report.findings.filter((f) => f.severity === "blocking");
    if (blocking.length > 0) return `review ${run.runId} has blocking findings: ${blocking.map((f) => f.id).join(", ")}`;
    return null;
  }

  const run = runs.find((r) => r.runId === standing.workerRunId);
  if (run?.role !== "worker") return `${standing.workerRunId} is not a worker run of this task`;
  if (run.status !== "succeeded" || !run.report) return `worker ${run.runId} has no successful final report`;
  const reported = run.report.pullRequests.find(covers);
  if (!reported) return `worker ${run.runId} did not report head ${head.sha}`;
  if (reported.review.required) return `worker ${run.runId} says head ${head.sha} requires review`;
  return null;
}

import type { Conversation, ConversationRevision, PullRequestRef, RepoSlug } from "./conversation.ts";
import type { PullRequestFacts } from "./github.ts";
import type { MergePr, ProposedAction, ReviewStanding } from "./actions.ts";
import type { RunRecord } from "./runs.ts";
import type { FiledFollowup } from "./situation.ts";

// The Gate: pure checks that refuse a proposed action which would cause a material harm (00 P3).
// Rule ids follow 03 §7 and 08 §7; only the rules the walking skeleton needs exist.

export type GateVerdict = { allowed: true } | { allowed: false; rule: string; reason: string };

const allow: GateVerdict = { allowed: true };
const deny = (rule: string, reason: string): GateVerdict => ({ allowed: false, rule, reason });

/**
 * A1 (07 §5 rule 1), re-checked against a live Linear read before every effect, not only at the
 * start: Sergeant acts on an issue only while it is delegated to its own V2 agent. Undelegation or
 * reassignment (to V1's agent, say) stops it, so another agent never races a run it does not own.
 */
export function checkDelegation(issue: Conversation["issue"], agentUserId: string): GateVerdict {
  if (issue.delegate?.id === agentUserId) return allow;
  const now = issue.delegate ? `delegated to ${issue.delegate.name}` : "not delegated";
  return deny("A1", `${issue.identifier} is ${now}, not to Sergeant's agent`);
}

/** Who says which PRs are this task's: one live Linear read and Sergeant's worker App login. */
export type Ownership = { linkedPullRequests: PullRequestRef[]; workerLogin: string };

/**
 * A PR is this task's only if Linear links it to the issue (08 §4) and Sergeant's worker App opened it.
 * Linear's GitHub integration also links a PR whose branch, title, or body names the issue, so the
 * link alone is PR-controlled text; the opener is not. A human-opened PR is never Sergeant's to merge.
 */
const isOwned = (pr: PullRequestRef, author: string | undefined, o: Ownership) =>
  author === o.workerLogin && o.linkedPullRequests.some((l) => l.repo === pr.repo && l.number === pr.number);

export function checkStart(
  action: Extract<ProposedAction, { kind: "start_worker" | "start_reviewer" }>,
  /** Ownership and the subject PRs come from the live Linear and GitHub reads made for this start. */
  facts: Ownership & { runs: RunRecord[]; enrolledRepositories: RepoSlug[]; subjectPullRequests: PullRequestFacts[] },
): GateVerdict {
  // L2: runs only ever get enrolled repositories.
  const repos = action.kind === "start_worker" ? action.repositories : action.subject.map((s) => s.repo);
  const unenrolled = repos.filter((r) => !facts.enrolledRepositories.includes(r));
  if (unenrolled.length > 0) return deny("RS1", `not enrolled: ${unenrolled.join(", ")}`);
  // G3: a reviewer reviews only this task's PRs, so an approval can never be minted for another one.
  if (action.kind === "start_reviewer") {
    const authorOf = (s: PullRequestRef) => facts.subjectPullRequests.find((p) => p.repo === s.repo && p.number === s.number)?.author;
    const foreign = action.subject.filter((s) => !isOwned(s, authorOf(s), facts));
    if (foreign.length > 0) return deny("G3", `not this task's PRs: ${foreign.map((s) => `${s.repo}#${s.number}`).join(", ")}`);
  }
  // L3 and the captain's rule: one primary worker at a time; the canary allows one reviewer at a time.
  const role = action.kind === "start_worker" ? "worker" : "reviewer";
  const active = facts.runs.find((r) => r.role === role && r.status === "running");
  if (active) return deny(role === "worker" ? "R1" : "R2", `${role} ${active.runId} is still running`);
  return allow;
}

/** G3/S1: steering goes only to this task's running worker. */
export function checkSend(action: Extract<ProposedAction, { kind: "send_run" }>, facts: { runs: RunRecord[] }): GateVerdict {
  const run = facts.runs.find((r) => r.runId === action.runId);
  if (run?.role !== "worker") return deny("S1", `${action.runId} is not a worker run of this task`);
  if (run.status !== "running") return deny("S1", `${run.runId} is ${run.status}`);
  return allow;
}

/** F1: follow-up issues one task may file (14: at most 3), so a confused turn cannot flood Linear. */
export const MAX_FOLLOWUPS_PER_TASK = 3;

export function checkFollowup(facts: { filed: FiledFollowup[] }): GateVerdict {
  if (facts.filed.length >= MAX_FOLLOWUPS_PER_TASK) {
    return deny("F1", `this task already filed ${facts.filed.length} follow-ups: ${facts.filed.map((f) => f.identifier).join(", ")}`);
  }
  return allow;
}

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
const hasClosingReference = (body: string, identifier: string) =>
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
  enrolledRepositories: RepoSlug[];
  runs: RunRecord[];
};

/**
 * L1 (no unreviewed or red merge), M2 (only this task's PRs), M9 (no early or missing completion),
 * and L4 (no merge that overtakes unseen human input).
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

  const { checks } = pr;
  if (checks.sha !== sha) return deny("M5", `checks were read for ${checks.sha}, not ${sha}`);
  if (checks.required.length === 0) return deny("M5", "the base branch has no required checks");
  const notGreen = checks.required.filter((c) => c.state !== "passed");
  if (notGreen.length > 0) {
    return deny("M5", `required checks not passed: ${notGreen.map((c) => `${c.name}=${c.state}`).join(", ")}`);
  }

  const standing = checkStanding(action.reviewStanding, { repo, number, sha }, facts.runs);
  if (standing) return deny("M6", standing);

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
    return deny("M10", "the Linear conversation changed since the deciding turn; take another turn");
  }

  // A merge ends its turn, so it must not leave a run working on the task, including one its turn started.
  const active = facts.runs.filter((r) => r.status === "running");
  if (active.length > 0) return deny("M11", `runs still active: ${active.map((r) => `${r.role} ${r.runId}`).join(", ")}`);
  return allow;
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

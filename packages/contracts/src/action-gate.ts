import type { Conversation, PullRequestRef, RepoSlug } from "./conversation.ts";
import type { PullRequestFacts } from "./github.ts";
import type { ProposedAction } from "./actions.ts";
import type { RunRecord } from "./runs.ts";

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

/** Linear state types that stop a task (TECH-4989), unless Sergeant's own closing merge led there. */
export const STOP_STATE_TYPES: readonly string[] = ["backlog", "canceled", "completed"];

/**
 * A2, re-checked against the same live read as A1 before every effect: an issue a human moved to
 * Backlog, Canceled, or Done is not Sergeant's to work on, as if it were undelegated. The steps after
 * Sergeant's closing merge (the outcome comment, the audit draw) check only A1: Done is where it leads.
 */
export function checkIssueState(issue: Conversation["issue"]): GateVerdict {
  if (!STOP_STATE_TYPES.includes(issue.stateType)) return allow;
  return deny("A2", `${issue.identifier} is in ${issue.state} (${issue.stateType})`);
}

/**
 * The live read's check before every effect: the issue is delegated to the V2 agent (A1) and not in
 * Backlog, Canceled, or Done (A2, TECH-4989).
 */
export function checkLive(issue: Conversation["issue"], agentUserId: string): GateVerdict {
  const delegation = checkDelegation(issue, agentUserId);
  return delegation.allowed ? checkIssueState(issue) : delegation;
}

/** Who says which PRs are this task's: one live Linear read and Sergeant's worker App login. */
export type Ownership = { linkedPullRequests: PullRequestRef[]; workerLogin: string };

/**
 * A PR is this task's only if Linear links it to the issue (08 §4) and Sergeant's worker App opened it.
 * Linear's GitHub integration also links a PR whose branch, title, or body names the issue, so the
 * link alone is PR-controlled text; the opener is not. A human-opened PR is never Sergeant's to merge.
 */
export const isOwned = (pr: PullRequestRef, author: string | undefined, o: Ownership) =>
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

/**
 * TECH-5232: may Sergeant close the issue itself, as Done or Canceled, because the task's own
 * verification shows nothing to change? Only while the issue is delegated to Sergeant and not stopped
 * (A1, A2), with no PR in the task, linked to the issue or reported by any run (C1), with evidence
 * (C2), after a worker finished and reported its verification and with no run still going (C3), and
 * decided on the live conversation, since closing ends the task (C4). Whether the evidence shows
 * nothing to change is reasoning's judgment, never this check's.
 */
export function checkClose(
  action: Extract<ProposedAction, { kind: "close_issue" }>,
  /** `issue` and `liveRevision` come from one live Linear read made for this close. */
  facts: { issue: Conversation["issue"]; agentUserId: string; runs: RunRecord[]; turnRevision: string; liveRevision: string },
): GateVerdict {
  const live = checkLive(facts.issue, facts.agentUserId);
  if (!live.allowed) return live;
  const reported = facts.runs.flatMap((r) => (r.role === "worker" ? (r.report?.pullRequests ?? []) : []));
  const prs = [...new Set([...facts.issue.linkedPullRequests, ...reported].map((p) => `${p.repo}#${p.number}`))];
  if (prs.length > 0) return deny("C1", `the task has PRs (${prs.join(", ")}); a human closes the issue or they merge`);
  if (!action.evidence.trim()) return deny("C2", "no evidence to post with the close");
  const running = facts.runs.filter((r) => r.status === "running");
  if (running.length > 0) return deny("C3", `runs still active: ${running.map((r) => `${r.role} ${r.runId}`).join(", ")}`);
  if (!facts.runs.some((r) => r.role === "worker" && r.status === "succeeded" && r.report)) {
    return deny("C3", "no worker has finished and reported its verification");
  }
  if (facts.liveRevision !== facts.turnRevision) return deny("C4", "the conversation changed since this turn's Situation Report; the next turn reads it");
  return allow;
}

/** G3/S1: steering goes only to this task's running worker. */
export function checkSend(action: Extract<ProposedAction, { kind: "send_run" }>, facts: { runs: RunRecord[] }): GateVerdict {
  const run = facts.runs.find((r) => r.runId === action.runId);
  if (run?.role !== "worker") return deny("S1", `${action.runId} is not a worker run of this task`);
  if (run.status !== "running") return deny("S1", `${run.runId} is ${run.status}`);
  return allow;
}

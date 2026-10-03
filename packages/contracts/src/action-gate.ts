import type { Conversation, PullRequestRef, RepoSlug } from "./conversation.ts";
import type { PullRequestFacts } from "./github.ts";
import type { ProposedAction } from "./actions.ts";
import type { RunRecord } from "./runs.ts";
import type { FiledFollowup } from "./situation.ts";

export type GateVerdict = { allowed: true } | { allowed: false; rule: string; reason: string };

const allow: GateVerdict = { allowed: true };
const deny = (rule: string, reason: string): GateVerdict => ({ allowed: false, rule, reason });

export function checkDelegation(issue: Conversation["issue"], agentUserId: string): GateVerdict {
  if (issue.delegate?.id === agentUserId) return allow;
  const now = issue.delegate ? `delegated to ${issue.delegate.name}` : "not delegated";
  return deny("A1", `${issue.identifier} is ${now}, not to Sergeant's agent`);
}

export const STOP_STATE_TYPES: readonly string[] = ["backlog", "canceled", "completed"];

export function checkIssueState(issue: Conversation["issue"]): GateVerdict {
  if (!STOP_STATE_TYPES.includes(issue.stateType)) return allow;
  return deny("A2", `${issue.identifier} is in ${issue.state} (${issue.stateType})`);
}

export function checkLive(issue: Conversation["issue"], agentUserId: string): GateVerdict {
  const delegation = checkDelegation(issue, agentUserId);
  return delegation.allowed ? checkIssueState(issue) : delegation;
}

export type Ownership = { linkedPullRequests: PullRequestRef[]; workerLogin: string };

export const isOwned = (pr: PullRequestRef, author: string | undefined, o: Ownership) =>
  author === o.workerLogin && o.linkedPullRequests.some((l) => l.repo === pr.repo && l.number === pr.number);

export function checkStart(
  action: Extract<ProposedAction, { kind: "start_worker" | "start_reviewer" }>,
  facts: Ownership & { runs: RunRecord[]; enrolledRepositories: RepoSlug[]; subjectPullRequests: PullRequestFacts[] },
): GateVerdict {
  const repos = action.kind === "start_worker" ? action.repositories : action.subject.map((s) => s.repo);
  const unenrolled = repos.filter((r) => !facts.enrolledRepositories.includes(r));
  if (unenrolled.length > 0) return deny("RS1", `not enrolled: ${unenrolled.join(", ")}`);
  if (action.kind === "start_reviewer") {
    const authorOf = (s: PullRequestRef) => facts.subjectPullRequests.find((p) => p.repo === s.repo && p.number === s.number)?.author;
    const foreign = action.subject.filter((s) => !isOwned(s, authorOf(s), facts));
    if (foreign.length > 0) return deny("G3", `not this task's PRs: ${foreign.map((s) => `${s.repo}#${s.number}`).join(", ")}`);
  }
  const role = action.kind === "start_worker" ? "worker" : "reviewer";
  const active = facts.runs.find((r) => r.role === role && r.status === "running");
  if (active) return deny(role === "worker" ? "R1" : "R2", `${role} ${active.runId} is still running`);
  return allow;
}

export function checkSend(action: Extract<ProposedAction, { kind: "send_run" }>, facts: { runs: RunRecord[] }): GateVerdict {
  const run = facts.runs.find((r) => r.runId === action.runId);
  if (run?.role !== "worker") return deny("S1", `${action.runId} is not a worker run of this task`);
  if (run.status !== "running") return deny("S1", `${run.runId} is ${run.status}`);
  return allow;
}

export const MAX_FOLLOWUPS_PER_TASK = 3;

export function checkFollowup(facts: { filed: FiledFollowup[] }): GateVerdict {
  if (facts.filed.length >= MAX_FOLLOWUPS_PER_TASK) {
    return deny("F1", `this task already filed ${facts.filed.length} follow-ups: ${facts.filed.map((f) => f.identifier).join(", ")}`);
  }
  return allow;
}

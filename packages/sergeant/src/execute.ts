import { randomUUID } from "node:crypto";
import {
  checkBudget,
  checkLive,
  checkMayMerge,
  checkSend,
  checkStart,
  commentIdFor,
  NoModelAccount,
  conversationRevision,
  issueRevision,
  type FiledFollowup,
  type FollowupCategory,
  type GitHubPort,
  type LinearPort,
  type ProposedAction,
  type PullRequestFacts,
  type RefusedMerge,
  type RunId,
  type RunnerPort,
  type RunRecord,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { answeredBudgetQuestion } from "./budget.ts";
import { accountRefusal, notOwned, type TaskOwner } from "./owner.ts";
import { ownQuestion, questionComment, questionKey } from "./question.ts";

export type Ports = {
  linear: LinearPort;
  github: GitHubPort;
  runner: RunnerPort;
  /** Resolves a GitHub login to the Linear profile URL that Markdown turns into a notifying mention. */
  linearProfileForGitHubLogin?: (login: string) => string | undefined;
  /** The V2 agent's Linear user: every effect requires the issue to be delegated to it (A1). */
  agentUserId: string;
  /** The worker App's GitHub login: Sergeant reviews and merges only PRs it opened (G3, M2). */
  workerLogin: string;
  /**
   * Called with a run's id before the runner is asked to start it. The loop saves the id here, so a
   * crash between the start and the loop's save still leaves a run it can cancel (UNF-728).
   */
  recordRun?: (runId: RunId) => Promise<void>;
  /**
   * The task's start/cancel lock, held from a start's live delegation check until the runner is asked
   * to start it. A task cancel lists the runs to stop under the same lock, so a start either sees the
   * delegation gone or is among the runs the cancel stops, across a restart too.
   */
  exclusive?: <T>(step: () => Promise<T>) => Promise<T>;
  /** Best-effort progress line (e.g. moving the issue to In Progress). No-op when absent. */
  log?: (line: string) => void;
  /**
   * The task's owner (TECH-5179, owner.ts), set by the loop once the task is admitted: every run uses
   * only their model accounts. Without one, no run starts.
   */
  owner?: TaskOwner;
  /**
   * Records the task's handoff stop (cancel.ts) when an effect finds the episode no longer its owner's
   * (TECH-5179); the loop's stop path then cancels its runs and keeps its PRs.
   */
  handoff?: (reason: string) => Promise<void>;
};

/** How a follow-up's category reads on the filed issue (TECH-5186). */
const categoryLabel: Record<FollowupCategory, string> = {
  concrete_bug: "a concrete bug",
  required_unfinished_work: "required unfinished work",
  real_blocker: "a real blocker",
  operational_or_security: "a current operational or security problem",
};

export type ActionOutcome =
  | {
      action: ProposedAction;
      status: "done";
      result: Record<string, unknown>;
      started?: RunRecord;
      /** The live PR facts the merge was allowed on, and its result. */
      merged?: { pr: PullRequestFacts; mergedSha: string };
      /** The follow-up issue filed or already on record under the action's key. */
      followup?: FiledFollowup;
    }
  | {
      action: ProposedAction;
      status: "denied";
      rule: string;
      reason: string;
      /** GitHub explicitly refused the merge by repository policy. */
      refused?: RefusedMerge;
    }
  | {
      action: ProposedAction;
      status: "failed";
      error: string;
      /** A refusal comment Linear did not accept: the loop posts it again every poll until it does. */
      unposted?: { issueId: string; key: string; body: string };
    };

/**
 * Performs one proposed action if the Gate allows it. This is the only path from reasoning to an
 * effect. Merge facts are re-read live here, never taken from the turn's snapshot.
 */
export async function execute(action: ProposedAction, situation: SituationReport, ports: Ports): Promise<ActionOutcome> {
  const denied = (v: { rule: string; reason: string }): ActionOutcome => ({ action, status: "denied", rule: v.rule, reason: v.reason });
  const { conversation, runs, enrolledRepositories } = situation;
  // B1 before every new effect: once the wall time or the observed spend is exhausted, only asking the
  // human (or ending the task on their word) remains (UNF-728); their answer opens a fresh window (TECH-5059). Checked here and again after
  // the live reads, immediately before the effect, since the deadline can pass while they wait.
  const inBudget = () => checkBudget(situation.budget, new Date());
  if (action.kind !== "ask_human" && action.kind !== "accept_as_is") {
    const budget = inBudget();
    if (!budget.allowed) return denied(budget);
  }
  try {
    switch (action.kind) {
      case "start_worker":
      case "start_reviewer": {
        const { owner } = ports;
        const payer = owner && { id: owner.id, name: owner.name };
        if (!owner || !payer) return denied({ rule: "O1", reason: "the task has no admitted owner to pay for its runs (TECH-5179)" });
        const exclusive = ports.exclusive ?? ((step) => step());
        return await exclusive(async (): Promise<ActionOutcome> => {
          // Delegation, the issue's linked PRs, and who opened a reviewer's subject PRs come from live
          // reads, never the snapshot.
          const subjects = action.kind === "start_reviewer" ? action.subject.filter((s) => enrolledRepositories.includes(s.repo)) : [];
          const [{ issue }, subjectPullRequests] = await Promise.all([
            ports.linear.readConversation(conversation.issue.id),
            Promise.all(subjects.map((s) => ports.github.readPullRequest(s.repo, s.number))),
          ]);
          const active = checkLive(issue, ports.agentUserId);
          if (!active.allowed) return denied(active);
          // The issue reassigned, or Linear's history showing a newer or someone else's delegation, since
          // the task was admitted, reread here at the effect: nothing starts and the task is handed off
          // (owner.ts). Unreadable history throws, so nothing starts either.
          const moved = await notOwned(owner, issue, ports);
          if (moved) {
            await ports.handoff?.(moved);
            return denied({ rule: "O1", reason: moved });
          }
          const verdict = checkStart(action, {
            runs,
            enrolledRepositories,
            linkedPullRequests: issue.linkedPullRequests,
            workerLogin: ports.workerLogin,
            subjectPullRequests,
          });
          if (!verdict.allowed) return denied(verdict);
          const late = inBudget();
          if (!late.allowed) return denied(late);
          const runId = `run_${randomUUID()}`;
          // Accepted: the deadline can pass during this milliseconds-long write, and the run still starts.
          await ports.recordRun?.(runId);
          await ports.runner.start(
            action.kind === "start_worker"
              ? {
                  runId,
                  owner: payer,
                  role: "worker",
                  conversation,
                  repositories: action.repositories,
                  objective: action.objective,
                  context: { pullRequests: situation.pullRequests, runs },
                }
              : {
                  runId,
                  owner: payer,
                  role: "reviewer",
                  conversation,
                  repositories: [...new Set(action.subject.map((s) => s.repo))],
                  subject: action.subject,
                  pullRequests: subjectPullRequests,
                  ...(action.focus !== undefined && { focus: action.focus }),
                },
          );
          const role = action.kind === "start_worker" ? "worker" : "reviewer";
          const started: RunRecord = { runId, role, status: "running", provider: "unknown", model: "unknown", report: null, issueRevision: issueRevision(conversation.issue) };
          // Best effort, after the start is a done fact: show the issue as In Progress the moment the
          // first worker starts (TECH-4947). A failed status write is logged and never fails the start,
          // and the move itself only runs for a worker and never moves a started/done issue backward.
          if (action.kind === "start_worker") {
            try {
              const moved = await ports.linear.moveIssueToStarted(conversation.issue.id);
              if (moved.moved) ports.log?.(`moved ${conversation.issue.identifier} to In Progress (${moved.from} -> ${moved.to})`);
            } catch (e) {
              ports.log?.(`could not move ${conversation.issue.identifier} to In Progress: ${(e as Error).message}`);
            }
          }
          return { action, status: "done", result: { runId }, started };
        }).catch(async (e: unknown) => {
          // Nothing started: the owner is told once per condition what to fix (owner.ts), retried until
          // Linear accepts it.
          if (!(e instanceof NoModelAccount)) throw e;
          const refusal = accountRefusal(conversation.issue.id, owner, e);
          const comment = { issueId: conversation.issue.id, ...refusal };
          const unposted = await ports.linear.postComment(comment).then(
            () => undefined,
            (p: Error) => p,
          );
          if (unposted) return { action, status: "failed", error: `${e.message}; its refusal comment was not posted: ${unposted.message}`, unposted: comment };
          return denied({ rule: "O2", reason: e.message });
        });
      }
      case "send_run": {
        const verdict = checkSend(action, { runs });
        if (!verdict.allowed) return denied(verdict);
        if (!ports.runner.send) return { action, status: "failed", error: "this runner cannot message a running run" };
        await ports.runner.send(action.runId, action.message);
        return { action, status: "done", result: {} };
      }
      case "merge_pr": {
        // One control-plane action: fresh reads of the exact-head PR with its required checks and
        // of the Linear issue with its linked PRs and conversation, the Gate over them, and GitHub's
        // SHA-guarded merge, with nothing that waits in between. A PR the issue does not link, or that
        // the worker App did not open, is refused (M2). A push or a human edit that lands before the reads denies the merge (M4,
        // M10); the changed facts change the loop's fingerprint, which wakes a new reasoning turn. An undelegation or a stop state denies it too (A1, A2), and the loop then stops. One landing
        // between the reads and the merge is the accepted race (08 §7), and GitHub's `sha` guard
        // still refuses a moved head.
        const [pr, live] = await Promise.all([
          ports.github.readPullRequest(action.repo, action.number),
          ports.linear.readConversation(conversation.issue.id),
        ]);
        // The revision covers human feedback on the task's PRs too: the deciding turn's, and the same
        // PRs with the one being merged re-read live, so feedback on it since the turn denies (M10).
        const liveRevision = conversationRevision(live, situation.pullRequests.map((p) => (p.repo === pr.repo && p.number === pr.number ? pr : p)));
        // The shared "may merge now?" preflight (TECH-5065): A1/A2 on the live issue, the merge gate, and
        // B1 again as of now, the same one a re-review request is asked against (rereview.ts).
        const verdict = checkMayMerge(
          // The revision of the conversation reasoning was actually shown, never a supplied one.
          { ...action, conversationRevision: conversationRevision(conversation, situation.pullRequests) },
          {
            pr,
            issueIdentifier: live.issue.identifier,
            pullRequests: situation.pullRequests,
            liveConversationRevision: liveRevision,
            liveIssueRevision: issueRevision(live.issue),
            agentComments: live.agentComments,
            linkedPullRequests: live.issue.linkedPullRequests,
            workerLogin: ports.workerLogin,
            enrolledRepositories,
            runs,
            refusedMerges: situation.refusedMerges,
            issue: live.issue,
            agentUserId: ports.agentUserId,
            budget: situation.budget,
            now: new Date(),
          },
        );
        if (!verdict.allowed) return denied(verdict);
        // TECH-5179: the work merges only while the episode is still its owner's, read live as for a
        // start; otherwise the task is handed off and the PR kept for the new assignee.
        const moved = ports.owner && (await notOwned(ports.owner, live.issue, ports));
        if (moved) {
          await ports.handoff?.(moved);
          return denied({ rule: "O1", reason: moved });
        }
        const result = await ports.github.mergePullRequest(action);
        if ("refused" in result) {
          // Repository policy, not a fault. The loop gives it the same one bounded re-check as a
          // failed merge call, then hands it to a human if nothing changed (TECH-5077).
          const refused = { repo: pr.repo, number: pr.number, url: pr.url, headSha: pr.headSha, conversationRevision: liveRevision, reason: result.refused, at: new Date().toISOString() };
          return { action, status: "denied", rule: "GitHub", reason: `refused by repository policy: ${result.refused}`, refused };
        }
        return { action, status: "done", result: { mergedSha: result.mergedSha }, merged: { pr, mergedSha: result.mergedSha } };
      }
      case "ask_human":
        // Keyed by the revision reasoning asked from, so a restart or a second ask before any human
        // reply posts nothing new, and the loop finds this comment to know it is waiting.
        return askHuman(action, situation, ports, questionKey(conversation.issue.id, conversationRevision(conversation)));
      case "accept_as_is": {
        // No effect: the loop ends the task (TECH-5118). Only a human's reply to the budget question
        // can accept the work as it is; an answer to any other question leaves the task going.
        if (!answeredBudgetQuestion(conversation, situation.budget)) {
          return denied({ rule: "Q2", reason: "no human has replied to Sergeant's budget question in this budget window" });
        }
        // Ending is terminal, so it is decided on the live conversation, not the turn's: an "extend" or
        // a steer posted while reasoning ran denies it, and the next turn reads that comment instead.
        const live = await ports.linear.readConversation(conversation.issue.id);
        if (conversationRevision(live) !== conversationRevision(conversation)) {
          return denied({ rule: "Q2", reason: "the conversation changed since this turn's Situation Report; the next turn reads it" });
        }
        return { action, status: "done", result: {} };
      }
      case "create_followup": {
        const filed = situation.followups.find((f) => f.key === action.key);
        if (filed) return { action, status: "done", result: { identifier: filed.identifier, alreadyFiled: true }, followup: filed };
        const active = checkLive((await ports.linear.readConversation(conversation.issue.id)).issue, ports.agentUserId);
        if (!active.allowed) return denied(active);
        const late = inBudget();
        if (!late.allowed) return denied(late);
        const { identifier, url } = conversation.issue;
        const issue = await ports.linear.createFollowupIssue({
          originIssueId: conversation.issue.id,
          title: action.title,
          description: `**Why a follow-up (${categoryLabel[action.category]}):** ${action.why}\n\n${action.description}\n\n---\nFollow-up from [${identifier}](${url}), filed by Sergeant. Not delegated: move it to Todo and delegate it when it should start.`,
          relation: action.relation,
          // Per task and reasoning's key, never per turn or run: a re-proposal, a retry, or a
          // restarted loop files nothing new, even when state.json never recorded the first one.
          key: `followup:${situation.taskId}:${action.key}`,
        });
        return { action, status: "done", result: { identifier: issue.identifier }, followup: { key: action.key, title: action.title, ...issue } };
      }
    }
  } catch (e) {
    return { action, status: "failed", error: (e as Error).message };
  }
}

/**
 * Posts a question as the V2 agent under `key`, at most once however often it is retried. A follow-up
 * to one of Sergeant's own questions is a reply in that question's thread (TECH-5052).
 */
export async function askHuman(
  action: Extract<ProposedAction, { kind: "ask_human" }>,
  situation: SituationReport,
  ports: Ports,
  key: string,
): Promise<ActionOutcome> {
  const { issue } = situation.conversation;
  try {
    const active = checkLive((await ports.linear.readConversation(issue.id)).issue, ports.agentUserId);
    if (!active.allowed) return { action, status: "denied", rule: active.rule, reason: active.reason };
    const thread = ownQuestion(situation.conversation, action.followsUp);
    const parentId = thread && (thread.parentId ?? thread.id);
    await ports.linear.postComment({ issueId: issue.id, body: questionComment(action), key, ...(parentId && { parentId }) });
    return { action, status: "done", result: { commentId: commentIdFor(key) } };
  } catch (e) {
    return { action, status: "failed", error: (e as Error).message };
  }
}

/** One line per outcome, for the next turn's `recentTurns`. */
export function describeOutcome(o: ActionOutcome): string {
  const a = o.action;
  const what =
    a.kind === "merge_pr"
      ? `merge_pr ${a.repo}#${a.number}@${a.expectedHeadSha.slice(0, 12)}`
      : a.kind === "create_followup"
        ? `create_followup ${a.key}`
        : a.kind;
  if (o.status === "done") return `${what}: done ${JSON.stringify(o.result)}`;
  if (o.status === "denied") return `${what}: denied by ${o.rule} (${o.reason})`;
  return `${what}: failed (${o.error})`;
}

import { randomUUID } from "node:crypto";
import {
  checkBudget,
  checkClose,
  checkLive,
  checkMayMerge,
  checkSend,
  checkStart,
  NoModelAccount,
  conversationRevision,
  issueRevision,
  reportedClosing,
  type FollowupCategory,
  type ProposedAction,
  type RunRecord,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { closedComment, closedKey } from "./accepted.ts";
import { askHuman } from "./ask-human.ts";
import { answeredBudgetQuestion } from "./budget.ts";
import { builtByLine } from "./built-by.ts";
import { handToHuman } from "./human-merge.ts";
import type { ActionOutcome, Ports } from "./execute-types.ts";
import { accountQuestion, notOwned } from "./owner.ts";
import { questionKey } from "./question.ts";
import { writtenAgainst } from "./written-against.ts";

export { askHuman } from "./ask-human.ts";
export type { ActionOutcome, Ports } from "./execute-types.ts";

/** How a follow-up's category reads on the filed issue (TECH-5186). */
const categoryLabel: Record<FollowupCategory, string> = {
  concrete_bug: "a concrete bug",
  required_unfinished_work: "required unfinished work",
  real_blocker: "a real blocker",
  operational_or_security: "a current operational or security problem",
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
          const repositories = action.kind === "start_worker" ? action.repositories : [...new Set(action.subject.map((s) => s.repo))];
          await ports.recordRun?.(runId, repositories);
          await ports.runner.start(
            action.kind === "start_worker"
              ? {
                  runId,
                  owner: payer,
                  role: "worker",
                  conversation,
                  repositories,
                  objective: action.objective,
                  context: { pullRequests: situation.pullRequests, runs },
                }
              : {
                  runId,
                  owner: payer,
                  role: "reviewer",
                  conversation,
                  repositories,
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
          // Nothing started: the owner is asked, through the ordinary question path, to register or fix
          // an account (TECH-5217). The loop then waits for their reply, which opens a fresh budget window
          // (TECH-5059) and wakes a turn that may start the run again. Keyed like any question, so one
          // wait asks once; a failed post is retried every poll until Linear shows it.
          if (!(e instanceof NoModelAccount)) throw e;
          const ask = accountQuestion(owner, e);
          const asked = await askHuman(ask, situation, ports, questionKey(conversation.issue.id, conversationRevision(conversation)));
          if (asked.status === "failed") return { action, status: "failed", error: `${e.message}; the question to ${owner.name} was not posted: ${asked.error}`, unposted: ask };
          if (asked.status === "denied") return asked;
          return denied({ rule: "O2", reason: `${e.message}; asked ${owner.name} to register or fix a model account` });
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
        // TECH-5244: the repository's live merge policy. In a `human` one the same preflight decides
        // whether the head is ready, and a ready head is handed to a human, never approved or merged.
        const policy = enrolledRepositories.includes(action.repo) ? (ports.github.mergePolicy?.(action.repo) ?? "human") : "human";
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
            handToHuman: policy !== "sergeant",
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
        if (policy !== "sergeant") return await handToHuman(action, pr, live.issue, { runs, liveRevision, ports });
        // Whether the squash commit may close the issue is the worker's report, the one M9 just checked
        // the body against, never a re-reading of the body (TECH-5085).
        const squash = { issueIdentifier: live.issue.identifier, closesIssue: reportedClosing(runs, pr) === true, builtBy: builtByLine(runs) };
        const result = await ports.github.mergePullRequest({ ...action, squash });
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
        if (!answeredBudgetQuestion(conversation, situation.budget, situation.pullRequests)) {
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
      case "close_issue": {
        // TECH-5232: the evidence comment and the close, made here on the live read the Gate allowed, with
        // nothing that waits in between (TECH-5236): a human comment, an edit, or a PR linked while
        // reasoning ran denies it (C1, C4), and the next turn reads it. Then the loop ends the task like an
        // accept (accepted.ts). Both effects are safe to repeat: the comment is keyed by the revision the
        // close was decided on, and an issue already closed is not moved again.
        const live = await ports.linear.readConversation(conversation.issue.id);
        const turnRevision = conversationRevision(conversation);
        const verdict = checkClose(action, {
          issue: live.issue,
          agentUserId: ports.agentUserId,
          runs,
          turnRevision,
          liveRevision: conversationRevision(live),
        });
        if (!verdict.allowed) return denied(verdict);
        if (!ports.linear.closeIssue) return { action, status: "failed", error: "this Sergeant cannot close an issue" };
        const body = closedComment(action, ports.costLine?.());
        await ports.linear.postComment({ issueId: conversation.issue.id, key: closedKey(conversation.issue.id, turnRevision), body });
        await ports.linear.closeIssue(conversation.issue.id, action.state);
        return { action, status: "done", result: { state: action.state } };
      }
      case "create_followup": {
        const filed = situation.followups.find((f) => f.key === action.key);
        if (filed) return { action, status: "done", result: { identifier: filed.identifier, alreadyFiled: true }, followup: filed };
        const active = checkLive((await ports.linear.readConversation(conversation.issue.id)).issue, ports.agentUserId);
        if (!active.allowed) return denied(active);
        const late = inBudget();
        if (!late.allowed) return denied(late);
        const { identifier, url } = conversation.issue;
        // TECH-5258: the task's PRs' repositories, else the one repository a run could have been given.
        const prRepos = situation.pullRequests.map((p) => p.repo);
        const against = await writtenAgainst(ports.github, prRepos.length > 0 ? prRepos : enrolledRepositories.length === 1 ? enrolledRepositories : []);
        const issue = await ports.linear.createFollowupIssue({
          originIssueId: conversation.issue.id,
          title: action.title,
          description: `**Why a follow-up (${categoryLabel[action.category]}):** ${action.why}\n\n${action.description}\n\n---\nFollow-up from [${identifier}](${url}), filed by Sergeant. Not delegated: move it to Todo and delegate it when it should start.${against && `\n\n${against}`}`,
          relation: action.relation,
          // Per task and reasoning's key, never per turn or run: a re-proposal, a retry, or a
          // restarted loop files nothing new, even when state.json never recorded the first one.
          key: `followup:${situation.taskId}:${action.key}`,
        });
        return { action, status: "done", result: { identifier: issue.identifier }, followup: { key: action.key, title: action.title, ...issue } };
      }
      case "record_blocked_by": {
        // TECH-5278: only a dependency of this task's issue, on another issue, either way round.
        const own = conversation.issue.identifier;
        if (action.blocked === action.blockedBy || (action.blocked !== own && action.blockedBy !== own)) {
          return denied({ rule: "K1", reason: `a blocked-by relation must link ${own} to another issue` });
        }
        const active = checkLive((await ports.linear.readConversation(conversation.issue.id)).issue, ports.agentUserId);
        if (!active.allowed) return denied(active);
        if (!ports.linear.recordBlockedBy) return { action, status: "failed", error: "this Sergeant cannot record a blocked-by relation" };
        const { recorded } = await ports.linear.recordBlockedBy({ blocked: action.blocked, blockedBy: action.blockedBy });
        return { action, status: "done", result: { recorded } };
      }
    }
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
        : a.kind === "record_blocked_by"
          ? `record_blocked_by ${a.blocked} blocked by ${a.blockedBy}`
          : a.kind;
  if (o.status === "done") return `${what}: done ${JSON.stringify(o.result)}`;
  if (o.status === "denied") return `${what}: denied by ${o.rule} (${o.reason})`;
  return `${what}: failed (${o.error})`;
}

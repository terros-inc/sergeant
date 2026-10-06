import type { CreateFollowup } from "./actions.ts";
import type { Conversation, RepoSlug, Sha } from "./conversation.ts";
import type { MergePolicy, PullRequestFacts } from "./github.ts";
import type { RunId, RunRecord } from "./runs.ts";

// The seams adapters implement. Adapters validate what they read with the schemas above before
// returning it; the core never trusts an unvalidated external payload.

/** A Linear user, as Sergeant names them in a comment. */
export type LinearPerson = { id: string; name: string };

/**
 * Whose model accounts may pay for a task (TECH-5179): the issue's human assignee, and only when
 * Linear's history shows that same person most recently delegated the issue to Sergeant. Anything
 * else is a refusal, with what Linear showed: `delegatedAt` is the latest delegation to Sergeant.
 */
export type TaskOwnerCheck =
  | { owner: LinearPerson; delegatedAt?: string }
  | {
      refused: "not_delegated" | "no_assignee" | "delegator_unknown" | "delegator_differs";
      assignee?: LinearPerson;
      delegator?: LinearPerson;
      delegatedAt?: string;
    };

export type HumanHandoffStep =
  | "read pull request"
  | "mark ready"
  | "re-read pull request"
  | "request reviewers"
  | "post review summary"
  | "complete handoff";

/** A human-merge handoff failed at a step a human can finish manually. */
export class HumanHandoffError extends Error {
  readonly step: HumanHandoffStep;

  constructor(step: HumanHandoffStep, message: string) {
    super(message);
    this.step = step;
    this.name = "HumanHandoffError";
  }
}

export interface LinearPort {
  /** The issue, every human-authored comment, and bounded explicit linked-issue background, live. */
  readConversation(issueId: string): Promise<Conversation>;
  /**
   * Who may pay for the issue's task, read live from the issue and its full history (TECH-5179).
   * Throws when Linear cannot be read; a caller then admits nothing.
   */
  readTaskOwner(issueId: string, agentUserId: string): Promise<TaskOwnerCheck>;
  /**
   * Posts a comment as Sergeant's agent, at most once per `key`: Linear's client-supplied comment id
   * is derived from it, so a retry after a lost response or a crash posts nothing new. With
   * `parentId`, it is a reply in that comment's thread.
   */
  postComment(req: { issueId: string; body: string; key: string; parentId?: string }): Promise<void>;
  /**
   * Resolves the thread a comment is in, only when Sergeant wrote its top comment (TECH-5052). A
   * thread already resolved, by anyone, is left as it is. Returns what it did, for a log.
   */
  resolveThread?(commentId: string): Promise<"resolved" | "already_resolved" | "not_sergeants">;
  /**
   * Adds the existing label named `name` (the workspace's, else the issue team's) to the issue; throws
   * when there is none. A label the issue already has is left as it is.
   */
  addLabel?(issueId: string, name: string): Promise<void>;
  /**
   * Creates an issue in the origin issue's team and project, in the team's first `backlog` state
   * (never Triage), related to it as `relation` says, with no delegate. It is assigned to the origin's
   * assignee unless that is Sergeant, else to the human who delegated the origin to Sergeant, else to
   * nobody. At most once per `key`, like `postComment`: a retry, even after a crash between creating
   * the issue and linking it, files no second issue.
   */
  createFollowupIssue(req: {
    originIssueId: string;
    title: string;
    description: string;
    relation: CreateFollowup["relation"];
    key: string;
  }): Promise<{ identifier: string; url: string }>;
  /**
   * The follow-up `createFollowupIssue` filed under `key`, if any, archived included (TECH-5049): a caller
   * can finish what a crash cut short after the filing without deciding again whether to file it.
   */
  findFollowupIssue?(key: string): Promise<{ identifier: string; url: string; title: string } | undefined>;
  /**
   * Records that issue `blocked` is blocked by issue `blockedBy`, both by identifier, as Linear's
   * relation "`blockedBy` blocks `blocked`" (TECH-5278). A relation already there, by anyone, is left as
   * it is (`recorded: false`); a retry after a crash creates no second one. Throws when either issue
   * is not found.
   */
  recordBlockedBy?(req: { blocked: string; blockedBy: string }): Promise<{ recorded: boolean }>;
  /**
   * Moves the issue to its team's first `started` state (lowest position) when its current state type
   * is `triage`, `backlog`, or `unstarted` — the visible "In Progress" when the first worker starts
   * (07 §5). A no-op for any other state type (already started, completed, or canceled) and when the
   * team has no `started` state, so it never moves an issue backward. Returns what it did, for a log.
   */
  moveIssueToStarted(issueId: string): Promise<{ moved: false } | { moved: true; from: string; to: string }>;
  /**
   * A handoff (TECH-5179): moves the issue back to its team's first `unstarted` state (Todo) only when
   * its current state type is `started`. Any other state, one a human chose included, is left as it is.
   */
  moveIssueToTodo?(issueId: string): Promise<{ moved: false } | { moved: true; from: string; to: string }>;
  /** Removes the issue's delegate. Idempotent. */
  undelegate?(issueId: string): Promise<void>;
  /**
   * TECH-5232: moves the issue to its team's first `completed` (`done`) or `canceled` state, unless it
   * is already completed or canceled, so a replay, or a state a human chose since, changes nothing.
   */
  closeIssue?(issueId: string, as: "done" | "canceled"): Promise<{ moved: false } | { moved: true; from: string; to: string }>;
}

export interface GitHubPort {
  readPullRequest(repo: RepoSlug, number: number): Promise<PullRequestFacts>;
  /**
   * Merges only if the head is still `expectedHeadSha` (GitHub's `sha` guard). A merge GitHub refuses
   * by repository policy (405: a required review Sergeant cannot give, say) resolves to `refused` with
   * GitHub's message; any other failure rejects, a temporary 405 (base moved, mergeability still
   * being computed) included. A squash merge's commit message is always Sergeant's own (TECH-5085):
   * the PR title and body, `Fixes <issueIdentifier>` when `closesIssue` (the worker's report, as Gate
   * M9 checks it) and otherwise `Part of` with no closing word for the issue, the plain `builtBy`
   * line, and only human co-authors, never an AI agent's identity from the branch commits.
   */
  mergePullRequest(req: {
    repo: RepoSlug;
    number: number;
    expectedHeadSha: Sha;
    squash: { issueIdentifier: string; closesIssue: boolean; builtBy: string };
  }): Promise<{ mergedSha: Sha } | { refused: string }>;
  /**
   * The repository's live `mergePolicy` (TECH-5244). Absent, as in a fake that never merges, every
   * repository is `human`. The adapter also refuses `mergePullRequest` itself, before any approval or
   * merge call, unless the policy it reads then is `sergeant`.
   */
  mergePolicy?(repo: RepoSlug): MergePolicy;
  /**
   * A `human` repository's gated head, handed to a human (TECH-5244), never approved or merged: the PR
   * marked ready for review if it is a draft; review requested from `reviewers` only when GitHub shows
   * nobody requested (no code owner, say) and the PR is not the reviewer's own; and `comment` posted on
   * it unless it already has it. Rejects when the head is no longer `expectedHeadSha`. Resolves with the
   * logins and `org/team`s whose review is now requested. Safe to repeat.
   */
  handToHuman?(req: { repo: RepoSlug; number: number; expectedHeadSha: Sha; reviewers: string[]; comment: string }): Promise<{ requested: string[] }>;
  /** Comments `comment` on an open PR, unless it already has that comment, then closes it: a canceled task's PR (TECH-4989). */
  closePullRequest(req: { repo: RepoSlug; number: number; comment: string }): Promise<void>;
  /**
   * Deletes a PR's head branch once the PR is closed without merging (TECH-5230), only if it is a
   * `sergeant/` branch in the PR's own repository (never a fork's), no other open PR is from or onto
   * it, and its tip is still the PR's head. Otherwise it is kept and says why. Optional, like the
   * Linear port's later methods, so a fake without it deletes nothing.
   */
  deletePullRequestBranch?(req: { repo: RepoSlug; number: number }): Promise<{ deleted: string } | { kept: string }>;
}

/**
 * Mints a run's only GitHub credential: a worker-App installation token scoped to exactly
 * `repositories`, able to push branches and open PRs (`write`, workers) or only read (`read`,
 * reviewers). Never a control-plane or personal credential.
 */
export type RunGitHubTokens = (req: { repositories: RepoSlug[]; access: "write" | "read" }) => Promise<string>;

export type RunSpec = {
  runId: RunId;
  /** The task source, verbatim; never only a summary. */
  conversation: Conversation;
  repositories: RepoSlug[];
  /** The task's owner (TECH-5179): the run uses only model accounts this person registered. */
  owner: LinearPerson;
} & (
  | {
      role: "worker";
      objective: string;
      /**
       * Where earlier work stands, copied by the core from the Situation Report so a successor's brief
       * always carries it: the task's PRs with their live required checks, and every earlier run with
       * its report (a worker's summary and known gaps, a reviewer's verdict and findings). Empty for
       * the first worker.
       */
      context: { pullRequests: PullRequestFacts[]; runs: RunRecord[] };
    }
  | {
      role: "reviewer";
      subject: { repo: RepoSlug; number: number; headSha: Sha }[];
      /**
       * The subject PRs, read live by the core as the reviewer starts, so the brief carries every human
       * review and comment on them for the reviewer to check was addressed (TECH-4990).
       */
      pullRequests: PullRequestFacts[];
      focus?: string;
    }
);

/**
 * The task owner has no model account a run may use (TECH-5179): none registered for a provider this
 * Sergeant runs, or every one spent, set aside after a failure, or otherwise unusable. Nothing started.
 */
export class NoModelAccount extends Error {
  readonly owner: LinearPerson;
  readonly kind: "none_registered" | "none_usable";
  /** The owner's accounts, by id, that were considered; part of what makes a refusal new. */
  readonly accountIds: string[];

  constructor(owner: LinearPerson, kind: NoModelAccount["kind"], accountIds: string[], detail: string) {
    super(detail);
    this.name = "NoModelAccount";
    this.owner = owner;
    this.kind = kind;
    this.accountIds = accountIds;
  }
}

export interface RunnerPort {
  /**
   * Starts a run with a fresh session. A reviewer never inherits a worker's session. Throws
   * `NoModelAccount`, having started nothing, when the task owner has no usable model account.
   */
  start(spec: RunSpec): Promise<void>;
  status(runId: RunId): Promise<RunRecord>;
  cancel(runId: RunId): Promise<void>;
  /** The raw Markdown report a run ended with, if it wrote one; parsed, it is the record's `report`. */
  report?(runId: RunId): Promise<string | undefined>;
  /** Steering text to a running worker, where the runner supports it. */
  send?(runId: RunId, message: string): Promise<void>;
}

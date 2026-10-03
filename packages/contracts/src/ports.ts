import type { CreateFollowup } from "./actions.ts";
import type { Conversation, RepoSlug, Sha } from "./conversation.ts";
import type { PullRequestFacts } from "./github.ts";
import type { RunId, RunRecord } from "./runs.ts";

// The seams adapters implement. Adapters validate what they read with the schemas above before
// returning it; the core never trusts an unvalidated external payload.

export interface LinearPort {
  /** The issue and every human-authored comment, live. */
  readConversation(issueId: string): Promise<Conversation>;
  /**
   * Posts a comment as Sergeant's agent, at most once per `key`: Linear's client-supplied comment id
   * is derived from it, so a retry after a lost response or a crash posts nothing new.
   */
  postComment(req: { issueId: string; body: string; key: string }): Promise<void>;
  /**
   * Creates an issue in the origin issue's team and project, related to it as `relation` says, with
   * no delegate or assignee. At most once per `key`, like `postComment`: a retry, even after a crash
   * between creating the issue and linking it, files no second issue.
   */
  createFollowupIssue(req: {
    originIssueId: string;
    title: string;
    description: string;
    relation: CreateFollowup["relation"];
    key: string;
  }): Promise<{ identifier: string; url: string }>;
  /**
   * Moves the issue to its team's first `started` state (lowest position) when its current state type
   * is `triage`, `backlog`, or `unstarted` — the visible "In Progress" when the first worker starts
   * (07 §5). A no-op for any other state type (already started, completed, or canceled) and when the
   * team has no `started` state, so it never moves an issue backward. Returns what it did, for a log.
   */
  moveIssueToStarted(issueId: string): Promise<{ moved: false } | { moved: true; from: string; to: string }>;
}

export interface GitHubPort {
  readPullRequest(repo: RepoSlug, number: number): Promise<PullRequestFacts>;
  /**
   * Merges only if the head is still `expectedHeadSha` (GitHub's `sha` guard). A merge GitHub refuses
   * by repository policy (405 or not mergeable: a required review Sergeant cannot give, say) resolves
   * to `refused` with GitHub's message; any other failure rejects.
   */
  mergePullRequest(req: { repo: RepoSlug; number: number; expectedHeadSha: Sha }): Promise<{ mergedSha: Sha } | { refused: string }>;
  /** Comments `comment` on an open PR, then closes it: a canceled task's PR (TECH-4989). */
  closePullRequest(req: { repo: RepoSlug; number: number; comment: string }): Promise<void>;
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
  | { role: "reviewer"; subject: { repo: RepoSlug; number: number; headSha: Sha }[]; focus?: string }
);

export interface RunnerPort {
  /** Starts a run with a fresh session. A reviewer never inherits a worker's session. */
  start(spec: RunSpec): Promise<void>;
  status(runId: RunId): Promise<RunRecord>;
  cancel(runId: RunId): Promise<void>;
  /** The raw Markdown report a run ended with, if it wrote one; parsed, it is the record's `report`. */
  report?(runId: RunId): Promise<string | undefined>;
  /** Steering text to a running worker, where the runner supports it. */
  send?(runId: RunId, message: string): Promise<void>;
}

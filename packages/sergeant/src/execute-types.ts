import type {
  FiledFollowup,
  GitHubPort,
  LinearPort,
  ProposedAction,
  PullRequestFacts,
  RefusedMerge,
  RunId,
  RunnerPort,
  RunRecord,
} from "@terros/sergeant-contracts";
import type { TaskOwner } from "./owner.ts";
import type { Progress } from "./progress.ts";

// The ports one proposed action is performed through, and what came of it (execute.ts).

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
  /** TECH-5227: the review round a question this turn asks also reports (progress.ts); marked folded once it does. */
  progress?: Progress;
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
      /** A question Linear did not accept: the loop asks it again every poll until it does. */
      unposted?: Extract<ProposedAction, { kind: "ask_human" }>;
    };

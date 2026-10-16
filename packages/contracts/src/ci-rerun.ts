import { z } from "zod";
import { RepoSlug, Sha } from "./conversation.ts";

// TECH-5839: a worker asks, in its report, for GitHub's "re-run failed jobs" on one workflow run of its
// task's PR; Sergeant checks the request and performs it with a separate GitHub App that only it holds.

/** At most this many reruns of one workflow run, by anyone: GitHub's `run_attempt` counts them too. */
export const MAX_CI_RERUNS = 2;

/** What a worker report's `rerunFailedCI` names: one failed workflow run on its PR's current head. */
export const CiRerunRequest = z.object({
  repo: RepoSlug,
  number: z.number().int().positive(),
  workflowRunId: z.number().int().positive(),
});
export type CiRerunRequest = z.infer<typeof CiRerunRequest>;

/** A workflow run as GitHub reports it, read with the rerun App just before a rerun. */
export type WorkflowRunFacts = {
  id: number;
  /** The repository the run is in, `owner/name`. */
  repo: string;
  headSha: string;
  /** The workflow file, such as `.github/workflows/ci.yml`: what the allowlist names. */
  path: string;
  status: string;
  conclusion: string | null;
  /** 1 for the first attempt; each rerun adds one. */
  attempt: number;
  url: string;
};

/**
 * One rerun request and what came of it, kept in the task's `state.json`, shown by `sgt task show`
 * and to reasoning: who asked (the worker run), the PR and workflow run, and the outcome.
 */
export const CiRerun = z.object({
  /** The worker run whose report asked for it. */
  requestedBy: z.string().min(1),
  repo: RepoSlug,
  number: z.number().int().positive(),
  workflowRunId: z.number().int().positive(),
  /** The PR head the request was checked against, when the PR was the task's. */
  headSha: Sha.optional(),
  /** The workflow file, once the run was read. */
  workflow: z.string().optional(),
  /** The attempt that failed and was rerun, once the run was read. */
  attempt: z.number().int().positive().optional(),
  /** `rerun`: GitHub accepted it; `rejected`: a check refused it; `failed`: a GitHub call failed. */
  outcome: z.enum(["rerun", "rejected", "failed"]),
  reason: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type CiRerun = z.infer<typeof CiRerun>;

/**
 * The one Actions operation Sergeant performs with its rerun App (TECH-5839). Its credential stays in
 * the control plane; each call mints a token for one repository with only `actions` permission.
 */
export interface CiRerunPort {
  /** The workflow files whose runs may be rerun in `repo` (its config's `ciRerunWorkflows`); none by default. */
  allowedWorkflows(repo: RepoSlug): string[];
  readWorkflowRun(repo: RepoSlug, workflowRunId: number): Promise<WorkflowRunFacts>;
  /** GitHub's `POST /repos/{repo}/actions/runs/{id}/rerun-failed-jobs`. */
  rerunFailedJobs(repo: RepoSlug, workflowRunId: number): Promise<void>;
}

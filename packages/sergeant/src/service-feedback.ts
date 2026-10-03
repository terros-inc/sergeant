import { sweepFeedbackEvery } from "./feedback.ts";
import type { ServiceDeps, ServiceOptions } from "./service-options.ts";

/** Post-merge feedback (feedback.ts), on its own slower cadence so it never holds up intake. */
export function startFeedbackLoop(
  opts: ServiceOptions,
  deps: ServiceDeps,
  log: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!deps.feedback) return Promise.resolve();
  return sweepFeedbackEvery(
    (opts.feedbackSweepMinutes ?? 10) * 60_000,
    {
      stateDir: opts.stateDir,
      enrolledRepositories: opts.enrolledRepositories,
      log,
      signal,
      ...(opts.feedbackLookbackDays !== undefined && { lookbackDays: opts.feedbackLookbackDays }),
    },
    {
      ...deps.feedback,
      openIssues: async () => (await deps.delegatedIssues()).map((issue) => issue.identifier),
      linear: deps.linear,
      github: deps.github,
      agentUserId: deps.agentUserId,
      workerLogin: deps.workerLogin,
    },
  );
}

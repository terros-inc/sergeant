import { withSource } from "./api-calls.ts";
import { sweepFeedbackEvery } from "./feedback.ts";
import type { ServiceDeps, ServiceOptions } from "./service-options.ts";

/** Post-merge feedback (feedback.ts), on its own slower cadence so it never holds up intake. */
export function startFeedbackLoop(
  opts: ServiceOptions,
  deps: ServiceDeps,
  log: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const feedback = deps.feedback;
  if (!feedback) return Promise.resolve();
  // TECH-5942: by default every twice the task loops' safety interval, whether or not webhooks deliver.
  const intervalMs = (opts.feedbackSweepMinutes ?? 2 * (opts.slowPollMinutes ?? 15)) * 60_000;
  return withSource("feedback sweep", () => sweepFeedbackEvery(
    intervalMs,
    {
      stateDir: opts.stateDir,
      enrolledRepositories: opts.enrolledRepositories,
      log,
      signal,
      ...(opts.feedbackLookbackDays !== undefined && { lookbackDays: opts.feedbackLookbackDays }),
    },
    {
      ...feedback,
      openIssues: async () => (await deps.delegatedIssues()).map((issue) => issue.identifier),
      linear: deps.linear,
      github: deps.github,
      agentUserId: deps.agentUserId,
      workerLogin: deps.workerLogin,
    },
  ));
}

import { withSource } from "./api-calls.ts";
import { sweepFeedbackEvery } from "./feedback.ts";
import type { ServiceDeps, ServiceOptions } from "./service-options.ts";

/** Post-merge feedback (feedback.ts), on its own slower cadence so it never holds up intake. */
export function startFeedbackLoop(
  opts: ServiceOptions,
  deps: ServiceDeps,
  log: (line: string) => void,
  signal: AbortSignal,
  webhooksDelivering: () => boolean,
): Promise<void> {
  const feedback = deps.feedback;
  if (!feedback) return Promise.resolve();
  const intervalMs = (opts.feedbackSweepMinutes ?? 10) * 60_000;
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
    // TECH-5942: while webhooks deliver, every twice the task loops' safety interval.
    { intervalMs: Math.max(intervalMs, 2 * (opts.slowPollMinutes ?? 15) * 60_000), when: webhooksDelivering },
  ));
}

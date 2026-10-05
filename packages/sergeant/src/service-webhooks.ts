import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceDeps, ServiceOptions } from "./service-options.ts";
import type { Wake } from "./wake.ts";
import { webhookHandler, type Nudge } from "./webhooks.ts";

/**
 * The service's webhook endpoints (webhooks.ts), waking the task loops and intake (service.ts) that
 * what an event names concerns.
 */
export function serviceWebhooks(
  opts: ServiceOptions,
  deps: ServiceDeps,
  log: (line: string) => void,
  input: { wakes: Map<string, Wake>; active: Map<string, Promise<void>>; delegated: () => string[]; intakeWake: Wake },
): (req: IncomingMessage, res: ServerResponse) => void {
  const { wakes, active, intakeWake } = input;
  // A webhook ends the wait of each loop watching what it names, and runs an intake for a task or a
  // delegated issue with no loop (one that ended idle, say) or a delegation change. Both coalesce: each wakes at
  // most once per `webhookGapSeconds`. An issue or PR no task knows is ignored; the polls cover it.
  const gapMs = (opts.webhookGapSeconds ?? 5) * 1000;
  const nudge = ({ keys, intake }: Nudge) => {
    const named = new Set(keys);
    let admit = intake;
    for (const [issueId, wake] of wakes) {
      if (!named.has(issueId) && !wake.watched.some((k) => named.has(k))) continue;
      if (active.has(issueId)) wake.nudge(gapMs);
      else admit = true;
    }
    if (input.delegated().some((id) => named.has(id) && !active.has(id))) admit = true;
    if (admit) intakeWake.nudge(gapMs);
  };
  return webhookHandler({
    secrets: opts.webhookSecrets ?? {},
    agentUserId: deps.agentUserId,
    enrolledRepositories: opts.enrolledRepositories,
    nudge,
    log,
  });
}

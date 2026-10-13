import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceDeps, ServiceOptions } from "./service-options.ts";
import type { Wake } from "./wake.ts";
import type { WebhookHealthTracker } from "./webhook-health.ts";
import { webhookHandler, type Nudge } from "./webhooks.ts";

/**
 * The service's webhook endpoints (webhooks.ts), waking the task loops and intake (service.ts) that
 * what an event names concerns.
 */
export function serviceWebhooks(
  opts: ServiceOptions,
  deps: ServiceDeps,
  log: (line: string) => void,
  input: { wakes: Map<string, Wake>; active: Map<string, Promise<void>>; delegated: () => string[]; intakeWake: Wake; health: WebhookHealthTracker },
): (req: IncomingMessage, res: ServerResponse) => void {
  const { wakes, active, intakeWake } = input;
  // A webhook ends the wait of each loop watching what it names, and runs an intake for a task or a
  // delegated issue with no loop (one that ended idle, say) or a delegation change. Both coalesce: each wakes at
  // most once per `webhookGapSeconds`. An issue or PR no task knows is ignored; the polls cover it.
  const gapMs = (opts.webhookGapSeconds ?? 5) * 1000;
  const nudge = ({ keys, intake, recheckOwner }: Nudge, source: "linear" | "github") => {
    const named = new Set(keys);
    let admit = intake;
    for (const [issueId, wake] of wakes) {
      if (!named.has(issueId) && !wake.watched.some((k) => named.has(k))) continue;
      // Its PRs are reread at its next pass, not only at the fallback interval (poll.ts `pullRequestPolls`).
      if (source === "github") wake.github = true;
      // Any Linear event naming it ends its rest (webhook-health.ts `resting`), so a human's comment is read
      // promptly. TECH-5974: only one that may have changed the delegation (not a plain comment) also rereads
      // the delegation history now; the recheck window otherwise catches a missed one, and a burst coalesces
      // into one reread because both are flags the next pass clears (loop.ts).
      if (source === "linear") wake.linear = true;
      if (source === "linear" && recheckOwner) wake.recheckOwner = true;
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
    health: input.health,
  });
}

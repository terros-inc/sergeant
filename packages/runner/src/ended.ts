import { AGENTS, type AgentResult } from "./agents.ts";
import { failingReset, type ModelAccount, type setAside } from "./accounts.ts";
import { estimateCodexCost, type CodexPrice } from "./codex-prices.ts";
import type { ReadQuota } from "./quota.ts";
import { recorded, type RunMeta } from "./run-files.ts";

// How an ended run's record reads its agent's result, the same for the local and the Fargate runner.

/** The record's fields from what the agent CLI said: status, who did the work, and its cost or tokens. */
export function agentFields(meta: RunMeta, agent: AgentResult, exitedOk: boolean, codexPrices: Record<string, CodexPrice>) {
  // TECH-5021: Codex reports only tokens; its model's list price makes them an estimated cost.
  const price = meta.adapter === "codex-local" ? codexPrices[meta.model] : undefined;
  const estimated = agent.costUsd === undefined && agent.tokens && price ? estimateCodexCost(agent.tokens, price) : undefined;
  return {
    runId: meta.runId,
    status: exitedOk && agent.ok ? "succeeded" : "failed",
    provider: AGENTS[meta.adapter].provider,
    model: agent.models.length ? agent.models.join(",") : meta.model,
    ...recorded(meta),
    ...(agent.costUsd !== undefined && { costUsd: agent.costUsd }),
    ...(estimated !== undefined && { costUsd: estimated, costBasis: "estimated" }),
    ...(agent.tokens && { tokens: agent.tokens }),
    ...(agent.failureReason && { failureReason: agent.failureReason }),
  } as const;
}

/**
 * The next launch takes the next account (TECH-5113): a run that failed on quota or authentication
 * sets its account aside, until the window it ran out of resets if within the hour.
 */
export async function setAsideOnFailure(
  meta: RunMeta,
  agent: AgentResult,
  asides: ReturnType<typeof setAside>,
  opts: { accounts: (ownerId: string) => Promise<ModelAccount[]>; quota?: ReadQuota | undefined },
) {
  if (!agent.failureReason || !meta.account) return;
  // The run's account's quota read again as it fails, past the launch cache, to see which window ran out.
  const account = opts.quota && meta.ownerId ? (await opts.accounts(meta.ownerId).catch(() => [])).find((a) => a.id === meta.account?.id) : undefined;
  const fresh = account && opts.quota ? await opts.quota(account, { fresh: true }).catch(() => undefined) : undefined;
  asides.add(meta.account.id, failingReset(fresh));
}

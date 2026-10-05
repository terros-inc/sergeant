import type { RunRecord } from "@terros/sergeant-contracts";

/** An agent as a person reads it, from a run record's provider (`anthropic/claude-code`, `openai/codex`). */
const agentName = (provider: string) =>
  /codex|openai/i.test(provider) ? "Codex" : /claude|anthropic/i.test(provider) ? "Claude" : provider;

/**
 * The plain transparency line every squash commit carries instead of agent co-author trailers
 * (TECH-5085), from the task's run records: `Built by Sergeant (worker: Claude, review: Codex)`. A
 * role no run has filled yet (a waived review, say) is left out; a run that never started is skipped.
 */
export function builtByLine(runs: readonly RunRecord[]): string {
  const roles = (["worker", "reviewer"] as const).flatMap((role) => {
    const agents = [...new Set(runs.filter((r) => r.role === role && r.provider !== "unknown").map((r) => agentName(r.provider)))];
    return agents.length > 0 ? [`${role === "worker" ? "worker" : "review"}: ${agents.join(" and ")}`] : [];
  });
  return roles.length > 0 ? `Built by Sergeant (${roles.join(", ")})` : "Built by Sergeant";
}

import { readFile } from "node:fs/promises";
import type { RunRecord } from "@terros/sergeant-contracts";

// TECH-5227: what a task has cost so far, in one line, from what is already recorded: each run's
// reported `costUsd`, provider, role and model account, the reasoning turns' cost in `turns.jsonl`, and
// the task's start. Costs are API-equivalent estimates (TECH-5021). A run with no cost (a Codex model
// with no configured price, a run still going, or one whose status could not be read) is counted as
// unknown, never as $0.

export type CostInput = {
  runs: RunRecord[];
  /** Runs whose status could not be read: their cost, role and account are unknown. */
  unknownRuns?: number;
  /** Sergeant's own reasoning turns over the whole task (`taskTurnCost`). */
  turnCostUsd: number;
  /** When the task started (`state.startedAt`); absent when it cannot be read. */
  startedAt?: string | undefined;
  /** When the line is written; defaults to now. */
  at?: string;
};

/**
 * What Sergeant's reasoning turns have cost over the whole task: every turn in `turns.jsonl` (loop.ts)
 * since the task started. Not `state.turnCostUsd`, which holds only the current budget window's: a
 * human's answer or review opens a fresh one at zero (budget.ts). The file outlives a stop or an
 * accept-as-is, so turns before `startedAt` are an earlier task's. A line that does not parse counts nothing.
 */
export async function taskTurnCost(file: string, startedAt: string): Promise<number> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const since = Date.parse(startedAt);
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const { at, turn } = JSON.parse(line) as { at?: string; turn?: { costUsd?: unknown } };
      if (at && Date.parse(at) >= since && typeof turn?.costUsd === "number") total += turn.costUsd;
    } catch {
      // A line torn by a crash mid-append.
    }
  }
  return total;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const providerName = (p: string) => (/codex|openai/i.test(p) ? "Codex" : /claude|anthropic/i.test(p) ? "Claude" : p);

/** The account's name as its holder registered it (`person:<user>:<name>`), never their email. */
const accountName = (a: NonNullable<RunRecord["account"]>) => (a.group === "registered" ? (/^person:[^:]+:(.+)$/.exec(a.id)?.[1] ?? a.holder) : a.holder);

function wall(input: CostInput): string | undefined {
  if (!input.startedAt) return undefined;
  const minutes = Math.max(0, Math.round((Date.parse(input.at ?? new Date().toISOString()) - Date.parse(input.startedAt)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function tally(input: CostInput) {
  const known = input.runs.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]));
  const unknown = input.runs.length - known.length + (input.unknownRuns ?? 0);
  const total = known.reduce((sum, c) => sum + c, 0) + input.turnCostUsd;
  const estimate =
    known.length === 0 && input.turnCostUsd === 0 && unknown > 0
      ? "unknown, no run reported one"
      : `~${usd(total)} estimated${unknown > 0 ? `, not counting ${plural(unknown, "run")} of unknown cost` : ""}`;
  const runs = plural(input.runs.length + (input.unknownRuns ?? 0), "run");
  const accounts = [...new Set(input.runs.flatMap((r) => (r.account ? [accountName(r.account)] : [])))];
  const workers = input.runs.filter((r) => r.role === "worker").length;
  const reviews = input.runs.length - workers;
  const roles = [...(workers ? [`${workers} worker`] : []), ...(reviews ? [`${reviews} review`] : []), ...(input.unknownRuns ? [`${input.unknownRuns} unreadable`] : [])];
  return {
    estimate,
    runs: `${runs}${roles.length > 0 ? ` (${roles.join(", ")})` : ""}`,
    accounts: accounts.length > 0 ? `accounts: ${accounts.join(", ")}` : undefined,
    wall: wall(input),
  };
}

/**
 * The progress comment's last line, every worker and review run and Sergeant's turns so far: "Cost so
 * far: ~$2.10 estimated · 3 runs (2 worker, 1 review) · 18 min · accounts: claudeWork, codexWork".
 */
export function costSoFar(input: CostInput): string {
  const t = tally(input);
  return [`Cost so far: ${t.estimate}`, t.runs, t.wall, t.accounts].filter(Boolean).join(" · ");
}

/**
 * The task's total for the comment that ends it (a merge's outcome, a stop): the estimate split by
 * provider, runs by role, wall time and accounts. "Cost: ~$3.40 estimated (Claude $2.90 · Codex $0.50)
 * · 5 runs (3 worker, 2 review) · 41 min · accounts: claudeWork, codexWork".
 */
export function costTotal(input: CostInput): string {
  const t = tally(input);
  const providers = new Map<string, { usd: number; unknown: number }>();
  for (const r of input.runs) {
    const p = providers.get(providerName(r.provider)) ?? { usd: 0, unknown: 0 };
    if (r.costUsd === undefined) p.unknown += 1;
    else p.usd += r.costUsd;
    providers.set(providerName(r.provider), p);
  }
  const split = [
    ...[...providers].map(([name, p]) => `${name} ${p.unknown > 0 && p.usd === 0 ? "unknown" : usd(p.usd)}${p.unknown > 0 && p.usd > 0 ? ` + ${p.unknown} unknown` : ""}`),
    ...(input.turnCostUsd > 0 ? [`Sergeant's turns ${usd(input.turnCostUsd)}`] : []),
  ];
  return [`Cost: ${t.estimate}${split.length > 0 ? ` (${split.join(" · ")})` : ""}`, t.runs, t.wall, t.accounts].filter(Boolean).join(" · ");
}

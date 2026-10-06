import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeOutcome, type ActionOutcome } from "./execute.ts";

// Natural-use evidence (TECH-5279, evidence.ts): searches Sergeant's own records in its state directory
// for a new path having run in production, so a live-check ticket can close citing it. The records:
// each task's `turns.jsonl` (every action Sergeant took and its outcome: merges with the PR facts they
// were allowed on, comments and questions posted, follow-ups filed, issues closed) and each run's
// `record.json` (provider, provider choice, account, report). A match is a candidate; the operator
// confirms it is the new path before citing it.

export type EvidenceHit = {
  /**
   * `supporting`: the matching action was done, or the run succeeded. `contrary`: it failed. `denied`: the
   * Gate stopped it, which is sometimes the path working (a human-merge repository's handoff is H1) and
   * sometimes not, so it is shown for the operator to judge and never decides the result. A canceled
   * run is left out.
   */
  kind: "supporting" | "contrary" | "denied";
  at: string;
  /** The task's issue, or the run's id. */
  subject: string;
  source: "turn outcome" | "run record";
  what: string;
};

export type EvidenceQuery = { match: RegExp; since?: string | undefined; issue?: string | undefined };

// Only a missing file reads as empty: one the caller may not read (not run as the sergeant user, say)
// must fail, never look like "no evidence".
const missing = <T>(empty: T) => (e: NodeJS.ErrnoException): T => {
  if (e.code === "ENOENT") return empty;
  throw e;
};
const lines = async (file: string) => (await readFile(file, "utf8").catch(missing(""))).split("\n").filter((l) => l.trim() !== "");
const dirs = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(missing([]))).filter((d) => d.isDirectory()).map((d) => d.name);
const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Every matching outcome and run record under `stateDir`, oldest first. A line that is not JSON is skipped. */
export async function searchEvidence(stateDir: string, query: EvidenceQuery): Promise<EvidenceHit[]> {
  const hits: EvidenceHit[] = [];
  const recent = (at: string) => query.since === undefined || at >= query.since;

  for (const issue of await dirs(join(stateDir, "tasks"))) {
    if (query.issue !== undefined && issue !== query.issue) continue;
    for (const line of await lines(join(stateDir, "tasks", issue, "turns.jsonl"))) {
      const turn = json(line) as { at?: string; outcomes?: ActionOutcome[] } | undefined;
      if (typeof turn?.at !== "string" || !recent(turn.at)) continue;
      for (const outcome of turn.outcomes ?? []) {
        const text = JSON.stringify(outcome);
        if (!query.match.test(text)) continue;
        hits.push({ kind: outcome.status === "done" ? "supporting" : outcome.status === "denied" ? "denied" : "contrary", at: turn.at, subject: issue, source: "turn outcome", what: describe(outcome, text) });
      }
    }
  }

  // A run's records do not name its issue; with `issue` set, only the turns that started it are searched.
  if (query.issue === undefined) {
    for (const runId of await dirs(join(stateDir, "runs"))) {
      const raw = await readFile(join(stateDir, "runs", runId, "record.json"), "utf8").catch(missing(undefined));
      const record = raw === undefined ? undefined : (json(raw) as { status?: string; provider?: string; role?: string } | undefined);
      if (!raw || !record || !query.match.test(raw)) continue;
      const meta = json(await readFile(join(stateDir, "runs", runId, "run.json"), "utf8").catch(() => "")) as { startedAt?: string } | undefined;
      const at = meta?.startedAt ?? "";
      if (!recent(at) || record.status === "running" || record.status === "canceled") continue;
      hits.push({
        kind: record.status === "succeeded" ? "supporting" : "contrary",
        at,
        subject: runId,
        source: "run record",
        what: `${record.role ?? "run"} ${record.status} on ${record.provider ?? "?"}: ${excerpt(raw, query.match)}`,
      });
    }
  }
  return hits.sort((a, b) => a.at.localeCompare(b.at));
}

function describe(outcome: ActionOutcome, text: string): string {
  try {
    return describeOutcome(outcome);
  } catch {
    // A record older than today's action shapes.
    return text.slice(0, 300);
  }
}

/** The match with some context either side, so the citation shows what matched. */
function excerpt(text: string, match: RegExp): string {
  const found = new RegExp(match.source, match.flags.replace("g", "")).exec(text);
  if (!found) return "";
  const start = Math.max(0, found.index - 80);
  return `…${text.slice(start, found.index + found[0].length + 80)}…`;
}

/**
 * The citation an operator pastes on the live-check ticket: what was searched, where, and each hit.
 * Exit code 0 with at least one supporting hit and no contrary one; otherwise 1.
 */
export function citation(hits: EvidenceHit[], context: { query: EvidenceQuery; version: string; host: string; searchedAt: string; limit?: number }): { text: string; exitCode: number } {
  const { query } = context;
  const supporting = hits.filter((h) => h.kind === "supporting");
  const contrary = hits.filter((h) => h.kind === "contrary");
  const limit = context.limit ?? 10;
  // Contrary hits first, all of them: they are what decides whether the ticket may close.
  const shown = [...contrary, ...hits.filter((h) => h.kind === "denied").slice(-limit), ...supporting.slice(-limit)];
  const scope = [`\`/${query.match.source}/${query.match.flags}\``, query.since && `since ${query.since}`, query.issue && `in ${query.issue}`].filter(Boolean).join(" ");
  const text = [
    `**Natural-use evidence** for ${scope}, from Sergeant's records on ${context.host} (Sergeant ${context.version}, searched ${context.searchedAt}):`,
    ...shown.map((h) => `- ${h.kind} · ${h.at || "unknown time"} · ${h.subject} · ${h.source}: \`${h.what.replaceAll("`", "'")}\``),
    `Result: ${supporting.length} supporting, ${contrary.length} contrary, ${hits.length - supporting.length - contrary.length} denied${hits.length > shown.length ? ` (the latest ${limit} supporting and denied shown)` : ""}.`,
  ].join("\n");
  return { text, exitCode: supporting.length > 0 && contrary.length === 0 ? 0 : 1 };
}

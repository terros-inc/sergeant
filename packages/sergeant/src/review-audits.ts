import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditCounts, type AuditGroup, type AuditRow, type GitHubPort, type ReviewAudits, type RunId, type RunnerPort, safeJson } from "@terros/sergeant-contracts";
import type { PrHead, ReviewFacts } from "./review-quality.ts";
import { classifyDeclarations, declarations } from "./review-readiness.ts";

// TECH-6619: `GET /v1/review-audits` (design 16 §6.3, §7.2). Every audit, a task's or a merged PR's
// outside a task, has a `trigger: audit` line in `<stateDir>/reviews.jsonl`; the last line per run id
// holds. The `--by sergeant` split classifies Sergeant's declarations on the audited heads by rereading
// GitHub, and a `Found: YES` gets its full findings from the run's own record. Nothing is stored.

type Audit = { line: ReviewFacts; head: PrHead & { found?: boolean } };

const headKey = (h: PrHead) => `${h.repo.toLowerCase()}#${h.number}@${h.headSha}`;

export async function reviewAudits(
  stateDir: string,
  deps: { github: Pick<GitHubPort, "readReadiness">; runner: Pick<RunnerPort, "status"> },
  filter: { since?: Date; repo?: string },
): Promise<ReviewAudits> {
  const wanted = (await auditLines(join(stateDir, "reviews.jsonl"))).filter(
    (a) => (!filter.repo || a.head.repo.toLowerCase() === filter.repo.toLowerCase()) && (!filter.since || Date.parse(a.line.at) >= filter.since.getTime()),
  );
  const groups = await sergeantGroups(join(stateDir, "tasks"), wanted, deps.github);
  const rows: AuditRow[] = [];
  for (const { line, head } of wanted) {
    const url = `https://github.com/${head.repo}/pull/${head.number}`;
    const row: AuditRow = { runId: line.runId, issue: line.issue, repo: head.repo, number: head.number, url, headSha: head.headSha, at: line.at, verdict: line.verdict, ...(head.found !== undefined && { found: head.found }), group: groups.get(headKey(head)) ?? "other" };
    // A public PR shows only filtered findings (§6.4); the full ones are in the run's record. One that
    // cannot be read fails the answer rather than leaving a Found: YES without its findings.
    if (line.verdict !== null && head.found === true) {
      const run = await deps.runner.status(line.runId as RunId).catch((e: Error) => {
        throw new Error(`could not read audit run ${line.runId} for ${head.repo}#${head.number}: ${e.message}`);
      });
      if (run.role !== "reviewer" || !run.report) throw new Error(`audit run ${line.runId} for ${head.repo}#${head.number} has no readable reviewer report`);
      Object.assign(row, { summary: run.report.summary, findings: run.report.findings });
    }
    rows.push(row);
  }
  const done = rows.filter((r) => r.verdict !== null);
  const repos = [...new Set(done.map((r) => r.repo))].sort();
  return {
    ...(filter.since && { since: filter.since.toISOString() }),
    ...(filter.repo && { repo: filter.repo }),
    ...counts(done),
    incomplete: rows.length - done.length,
    byRepo: repos.map((repo) => ({ repo, ...counts(done.filter((r) => r.repo === repo)) })),
    bySergeant: { agreed: counts(done.filter((r) => r.group === "agreed")), sergeant_merged: counts(done.filter((r) => r.group === "sergeant_merged")), other: counts(done.filter((r) => r.group === "other")) },
    audits: rows,
  };
}

function counts(done: AuditRow[]): AuditCounts {
  const found = done.filter((r) => r.found === true).length;
  const foundKnown = done.filter((r) => r.found !== undefined).length;
  return { completed: done.length, found, foundKnown, foundUnknown: done.length - foundKnown, fail: done.filter((r) => r.verdict !== "approve").length };
}

/**
 * Each audited head with a Sergeant declaration on it, by its class now: AGREED is a human's merge of
 * that head, and `not_human_merge` on a head Sergeant declared is Sergeant's own merge. A head with no
 * declaration, or any other class, is `other`. Only declarations on audited heads are reread.
 */
async function sergeantGroups(tasksDir: string, audits: Audit[], github: Pick<GitHubPort, "readReadiness">): Promise<Map<string, AuditGroup>> {
  const audited = new Set(audits.map((a) => headKey(a.head)));
  const declared = (await declarations(tasksDir)).filter((d) => audited.has(headKey(d)));
  const groups = new Map<string, AuditGroup>();
  if (declared.length === 0) return groups;
  const groupOf = (className: string, mergedBySergeant: boolean): AuditGroup => (className === "AGREED" ? "agreed" : mergedBySergeant ? "sergeant_merged" : "other");
  // A head declared more than once takes its strongest class: agreed, then sergeant_merged.
  const order: AuditGroup[] = ["other", "sergeant_merged", "agreed"];
  for (const { row, mergedBySergeant } of await classifyDeclarations(declared, github)) {
    const key = headKey(row);
    const group = groupOf(row.class, mergedBySergeant);
    if (order.indexOf(group) > order.indexOf(groups.get(key) ?? "other")) groups.set(key, group);
  }
  return groups;
}

/** The last line of each audit run, with the audited head and its `found`. A torn or headless line is skipped. */
async function auditLines(file: string): Promise<Audit[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  const last = new Map<string, ReviewFacts>();
  for (const text of raw.split("\n")) {
    const line = safeJson(text) as ReviewFacts | undefined;
    if (line?.trigger === "audit" && typeof line.runId === "string") last.set(line.runId, line);
  }
  const audits: Audit[] = [];
  for (const line of last.values()) {
    // The audited head is the merged one; its subject entry carries `found` (06 §8).
    const merged = line.merged ?? line.subject?.[0];
    if (!merged) continue;
    const on = line.subject?.find((s) => headKey(s) === headKey(merged));
    audits.push({ line, head: { repo: merged.repo, number: merged.number, headSha: merged.headSha, ...(on?.found !== undefined && { found: on.found }) } });
  }
  return audits.sort((a, b) => Date.parse(a.line.at) - Date.parse(b.line.at));
}

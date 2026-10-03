import type { RunDetail, RunSummary, TaskDetail, TaskSummary } from "@terros/sergeant-contracts";

// --- human output: one line per item, aligned; detail only in `show`

export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd()).join("\n");
}

const clip = (text: string | undefined, max = 80) => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const minute = (iso: string | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")}Z` : "-");
const usd = (n: number | undefined) => (n === undefined ? "-" : `$${n.toFixed(2)}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const taskRow = (t: TaskSummary) => [t.ref, t.status, plural(t.turns, "turn"), plural(t.runs, "run"), minute(t.lastTurnAt), clip(t.lastSummary, 60)];

export const runRow = (r: RunSummary) => [r.runId, r.task, r.role ?? "-", r.status, usd(r.costUsd), clip(r.summary ?? r.error, 60)];

export function showTask(d: TaskDetail): string {
  const { task, issue, budget } = d;
  const lines = [
    "error" in issue
      ? `${task.ref}  ${task.status}  (Linear unreadable: ${issue.error})`
      : `${task.ref}  ${task.status}  ${issue.title}\n${issue.state}, ${issue.delegatedToSergeant ? "delegated to Sergeant" : issue.delegate ? `delegated to ${issue.delegate}` : "not delegated"}  ${issue.url}`,
  ];
  if (task.statusDetail) lines.push(`last ended: ${task.statusDetail}`);
  lines.push(`started ${minute(task.startedAt)}, ${plural(task.turns, "turn")}, last ${minute(task.lastTurnAt)}`);
  if (budget) {
    const spent = `${usd(budget.spentUsd)} of ${usd(budget.costLimitUsd)}${budget.unknownCostRuns ? ` (+${plural(budget.unknownCostRuns, "run")} of unknown cost)` : ""}`;
    lines.push(`budget: ${spent}, wall time until ${minute(budget.wallDeadline)}${budget.exhausted ? `  EXHAUSTED: ${budget.exhausted}` : ""}`);
  }
  if (task.merged) lines.push(`merged: ${task.merged.repo}#${task.merged.number} as ${task.merged.mergedSha.slice(0, 12)} at ${minute(task.merged.at)}`);
  if (d.runs.length) lines.push("runs:", indent(table(d.runs.map((r) => runRow(r).filter((_, i) => i !== 1)))));
  if (d.recentTurns.length) {
    lines.push("recent turns:");
    for (const t of d.recentTurns) lines.push(`  ${minute(t.at)}  ${clip(t.summary, 100)}`, ...t.outcomes.map((o) => `    ${clip(o, 100)}`));
  }
  if (d.followups.length) lines.push("follow-ups:", ...d.followups.map((f) => `  ${f.identifier}  ${clip(f.title, 60)}  ${f.url}`));
  return lines.join("\n");
}

export function showRun({ task, run }: RunDetail): string {
  const cost = run.costUsd === undefined && run.tokens ? `cost unknown, ${run.tokens.input} input and ${run.tokens.output} output tokens` : usd(run.costUsd);
  const lines = [`${run.runId}  ${run.role}  ${run.status}  task ${task}, ${run.model}, ${cost}`];
  if (!run.report) {
    lines.push(run.reportError ? `no report: ${run.reportError}` : "no report yet");
  } else if (run.role === "worker") {
    const r = run.report;
    lines.push(`${r.outcome}: ${r.summary}`);
    for (const pr of r.pullRequests) {
      const review = pr.review.required ? "review required" : `review skipped: ${pr.review.reason}`;
      lines.push(`  ${pr.repo}#${pr.number} @${pr.headSha.slice(0, 12)} ${pr.closesIssue ? "closes the issue" : "part of it"}, ${review}`);
    }
    for (const gap of r.knownGaps) lines.push(`  gap: ${gap}`);
  } else {
    const r = run.report;
    lines.push(`${r.verdict}: ${r.summary}`);
    for (const pr of r.reviewed) lines.push(`  reviewed ${pr.repo}#${pr.number} @${pr.headSha.slice(0, 12)}`);
    for (const f of r.findings) lines.push(`  ${f.severity} ${f.id}: ${clip(f.description, 100)}${f.location ? ` (${f.location})` : ""}`);
  }
  lines.push(`full report: sgt run report ${run.runId}`);
  return lines.join("\n");
}

const indent = (text: string) => text.replace(/^/gm, "  ");

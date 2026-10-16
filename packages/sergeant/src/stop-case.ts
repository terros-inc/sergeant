import { outstandingChangeRequests, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { fixCycles, headVerdict, recommend, stepsLeft, type StopRecommendation, type WindowFacts } from "./stop-rubric.ts";

// TECH-6021: the case Sergeant makes when a budget window runs out, so a human can decide from the
// question alone: what happened in the window, how close the work is and what is left, and the stop
// rubric's recommendation with its rule and the estimated cost of what is left (07 §6). Built in
// Sergeant's own poll from the run records, PR facts and turn ledger it already has; no run is started
// and no model is asked to research it.

export type StopCase = { happened: string; standing: string[]; recommendation: StopRecommendation };

export function stopCase(w: WindowFacts): StopCase {
  return { happened: narrative(w), standing: standing(w), recommendation: recommend(w) };
}

/** "Worker finished (o/r#1); reviewer requested changes (2 blocking); fix worker was canceled. 4 Sergeant turns." */
export function narrative(w: WindowFacts): string {
  const retries = new Set(Object.values(w.retries).flatMap((r) => (r.retryRunId ? [r.retryRunId] : [])));
  let requested = false;
  const steps = w.runs.map((r) => {
    const fix = r.role === "worker" && requested;
    if (r.role === "reviewer" && r.report) requested = r.report.verdict === "changes_requested";
    else if (fix) requested = false;
    const who = `${retries.has(r.runId) ? "restarted " : ""}${fix ? "fix " : ""}${r.role}`;
    const steered = w.steers[r.runId] ? `, steered ${times(w.steers[r.runId] ?? 0)}` : "";
    return `${who} ${outcome(r)}${steered}`;
  });
  const reviews = w.situation.pullRequests.flatMap((p) => p.humanFeedback).filter((f) => f.kind === "review" && Date.parse(f.createdAt) >= Date.parse(w.situation.budget.windowStart));
  const human = reviews.length ? [`${reviews.length} human review${reviews.length === 1 ? "" : "s"} (${reviews.map((f) => `${f.author} ${f.state?.toLowerCase().replace("_", " ")}`).join(", ")})`] : [];
  const cycles = fixCycles(w.runs);
  const story = [...steps, ...human].join("; ");
  const tail = `${w.turns} Sergeant turn${w.turns === 1 ? "" : "s"}${cycles ? `, ${cycles} fix cycle${cycles === 1 ? "" : "s"}` : ""}.`;
  return story ? `${capital(story)}. ${tail}` : `No run started in this window. ${tail}`;
}

function outcome(r: RunRecord): string {
  if (r.status === "running" || r.status === "canceled") return "was canceled at the deadline";
  if (r.status === "failed") return r.report ? "failed" : "failed with no report";
  if (r.role === "worker") {
    const prs = r.report?.pullRequests.map((p) => `${p.repo}#${p.number}`) ?? [];
    return r.report ? `finished${prs.length ? ` (${prs.join(", ")})` : ""}` : "ended with no usable report";
  }
  if (!r.report) return "ended with no usable report";
  const blocking = r.report.findings.filter((f) => f.severity === "blocking").length;
  if (r.report.verdict === "approve") return "approved";
  if (r.report.verdict === "needs_human") return "asked for a human's call";
  return `requested changes (${blocking} blocking)`;
}

/**
 * Each open PR, linked once as `[owner/name#n](url)` (TECH-6225: a bare URL before its colon showed as
 * the link twice), its CI, review verdict and mergeability, its open blocking findings, and the steps left.
 */
export function standing(w: WindowFacts): string[] {
  const open = w.situation.pullRequests.filter((p) => p.state === "open");
  if (open.length === 0) {
    const merged = w.situation.pullRequests.filter((p) => p.state === "merged").map((p) => `${p.repo}#${p.number}`);
    return [`No open PR${merged.length ? ` (merged: ${merged.join(", ")})` : ""}. Left: a worker to finish the change and open its PR, a review and a merge.`];
  }
  return open.flatMap((pr) => {
    const review = headVerdict(w.situation.runs, pr);
    const findings = review?.verdict === "changes_requested" ? review.findings.filter((f) => f.severity === "blocking") : [];
    const humans = outstandingChangeRequests(pr.humanFeedback);
    const verdict = !review ? "none at this head" : review.verdict === "approve" ? "approved at this head" : review.verdict === "needs_human" ? "reviewer asked for a human" : `changes requested (${findings.length} blocking)`;
    const lines = [`[${pr.repo}#${pr.number}](${pr.url}): ${pr.draft ? "draft, " : ""}CI ${ci(pr)}; review: ${verdict}${humans.length ? `; changes requested by ${humans.join(", ")}` : ""}; mergeable: ${pr.mergeableState}.`];
    if (findings.length) lines.push(`Open blocking findings: ${findings.slice(0, 3).map((f) => `${f.location ? `${f.location}: ` : ""}${clip(f.description)}`).join("; ")}${findings.length > 3 ? `; and ${findings.length - 3} more` : ""}.`);
    lines.push(`Left: ${stepsLeft(w, pr).map((step) => step.label).join(", then ")}.`);
    return lines;
  });
}

const ci = (pr: PullRequestFacts) => {
  const required = pr.checks.required;
  if (required.length === 0) return "no required checks";
  const counts = (["passed", "failed", "pending", "missing"] as const).flatMap((s) => {
    const n = required.filter((c) => c.state === s).length;
    return n ? [`${n} ${s}`] : [];
  });
  return counts.join(", ");
};

/** The recommendation as the question says it: "Sergeant recommends extend (rubric rule 2: …)". */
export function recommendationLine(r: StopRecommendation): string {
  const call = r.call === "ask" ? "Sergeant makes no recommendation" : r.rule === "1" && r.reason.startsWith("the work cannot finish") ? "Sergeant recommends stop, or answer this" : `Sergeant recommends ${r.call}`;
  return `**${call}** (rubric rule ${r.rule}: ${r.reason}).${r.estimate ? ` Remaining: ${r.estimate}.` : ""}`;
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);

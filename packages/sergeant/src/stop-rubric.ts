import { commentIdFor, outstandingChangeRequests, type MergePolicy, type PullRequestFacts, type RepoSlug, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { expiredChecksKey } from "./expired-checks.ts";

// TECH-6021: the stop rubric of docs/findings/tech-5922-wall-time-windows.md §6, applied in order to
// an exhausted window, the first rule that matches deciding. Rule 0 (only waiting on a human: park,
// post nothing) is the loop's existing human wait (pr-wait.ts, TECH-5218, TECH-5913), which uses none of
// the window (TECH-6165), and the open question hold, so a window that reaches this asks. Rule 2's automatic extension is not built: its
// cases still ask, "Sergeant recommends extend". Everything is read from the window's run records, PR
// facts and turn ledger; nothing here launches a run or reads anything new.

export type StopCall = "extend" | "stop" | "ask";
export type StopRecommendation = { call: StopCall; rule: "1" | "2" | "3"; reason: string; estimate: string };
export type RemainingStep = { label: string; kind: "worker" | "mechanical" | "reviewer" | "ci" | "merge" };

/** One window of the task as the ledger has it: its runs in start order, and the steers each got. */
export type WindowFacts = {
  situation: SituationReport;
  /** This window's runs, oldest first (`state.runIds` less `budget.priorRuns`). */
  runs: RunRecord[];
  /** Steers (`send_run` done) per run in this window. */
  steers: Record<string, number>;
  /** TECH-5259 report recoveries: a run that ended with no usable report, and the retry started for it. */
  retries: Record<string, { retryRunId?: string | undefined }>;
  /** Sergeant's turns in this window, and their reported cost. */
  turns: number;
  turnCostUsd: number;
  mergePolicy: (repo: RepoSlug) => MergePolicy | undefined;
};

// Rough step lengths for the estimate, from the TECH-5922 measurement (§3): reviewer p90 5.1 min,
// worker median 6.1 and p90 16.5 min. CI and a merge turn are rounded guesses; CI was not measurable.
const MIN = { review: 5, worker: 17, mechanical: 6, ci: 5, merge: 2 } as const;

/** The rubric's recommendation for this window, with the rule that decided it. */
export function recommend(w: WindowFacts): StopRecommendation {
  const stop = ruleOne(w);
  if (stop) return { call: "stop", rule: "1", reason: stop, estimate: remainingEstimate(w) };
  const capShare = w.situation.budget.spentUsd / w.situation.budget.costLimitUsd;
  const obvious = capShare < 0.8 ? ruleTwo(w) : undefined;
  if (obvious) return { call: "extend", rule: "2", ...obvious };
  const fallback = ruleThree(w);
  return { rule: "3", ...fallback, estimate: fallback.estimate ?? remainingEstimate(w) };
}

/** Rule 1: the clauses that recommend stopping, or undefined when none holds. */
function ruleOne(w: WindowFacts): string | undefined {
  const { budget, pullRequests } = w.situation;
  const cycles = fixCycles(w.runs);
  if (cycles >= 3) return `${cycles} fix cycles in this window`;
  const recurring = cycles >= 2 ? recurringFinding(w.runs) : undefined;
  if (recurring) return `the same blocking finding (${recurring}) came back after two fix cycles`;
  const churn = churnWithoutReport(w);
  if (churn) return churn;
  const ready = pullRequests.some((p) => p.state === "open" && !p.draft);
  if (budget.spentUsd >= 0.8 * budget.costLimitUsd && !ready) return `spend is at ${Math.round((100 * budget.spentUsd) / budget.costLimitUsd)}% of the window's cost cap with no PR ready for review`;
  const missing = missingInput(w.runs);
  if (missing) return `the work cannot finish without ${missing}`;
  return undefined;
}

/** Rule 2: the remaining work is exactly one small, bounded, mechanical step. */
function ruleTwo(w: WindowFacts): { reason: string; estimate: string } | undefined {
  const open = w.situation.pullRequests.filter((p) => p.state === "open");
  if (open.length !== 1) return undefined;
  const [pr] = open as [PullRequestFacts];
  const verdict = headVerdict(w.situation.runs, pr);
  const green = pr.checks.required.every((c) => c.state === "passed");
  const humanBlock = outstandingChangeRequests(pr.humanFeedback).length > 0;
  if (verdict?.verdict === "approve" && green && !humanBlock && ["clean", "unstable", "has_hooks"].includes(pr.mergeableState) && w.mergePolicy(pr.repo) === "sergeant") {
    return { reason: "only a merge Sergeant may do is left (review approved, required CI green, mergePolicy sergeant)", estimate: estimate(w, "a merge", MIN.merge, { turns: 1 }) };
  }
  if (verdict?.verdict === "approve" && !humanBlock && pr.mergeableState === "behind" && !pr.checks.required.some((c) => c.state === "failed")) {
    return { reason: "only a conflict-free rebase of an approved PR is left", estimate: estimate(w, "a rebase, a re-review and merge", MIN.mechanical + MIN.review + MIN.ci + MIN.merge, { worker: 1, reviewer: 1, turns: 3 }) };
  }
  const worker = w.runs.filter((r) => r.role === "worker").at(-1);
  const finished = worker?.status === "succeeded" && worker.report?.pullRequests.some((p) => p.repo === pr.repo && p.number === pr.number && p.headSha === pr.headSha);
  const reviewed = w.situation.runs.some(
    (r) => r.role === "reviewer" && r.report?.reviewed.some((s) => s.repo === pr.repo && s.number === pr.number && s.headSha === pr.headSha),
  );
  if (finished && !reviewed && !humanBlock) {
    return { reason: "the worker finished and only a first review of its PR is next", estimate: estimate(w, "a first review", MIN.review, { reviewer: 1, turns: 1 }) };
  }
  return undefined;
}

/** Rule 3: ask with the case made, recommending extend in the rubric's typical cases. */
function ruleThree(w: WindowFacts): { call: StopCall; reason: string; estimate?: string } {
  const cycles = fixCycles(w.runs);
  const lastReview = w.runs.filter((r) => r.role === "reviewer" && r.report).at(-1);
  const fixedSince = lastReview && w.runs.slice(w.runs.indexOf(lastReview) + 1).some((r) => r.role === "worker" && r.status === "succeeded");
  if (lastReview?.role === "reviewer" && lastReview.report?.verdict === "changes_requested" && !fixedSince && cycles <= 1) {
    return { call: "extend", reason: "a first fix cycle after a reviewer's change request", estimate: estimate(w, "one fix, a re-review and merge", MIN.worker + MIN.review + MIN.ci + MIN.merge, { worker: 1, reviewer: 1, turns: 3 }) };
  }
  const canceled = w.runs.findIndex((r) => r.status === "canceled");
  const cut = w.runs[canceled];
  if (cut && canceled > 0 && !w.runs.slice(0, canceled).some((r) => r.status === "canceled" && r.role === cut.role)) {
    const minutes = cut.role === "worker" ? MIN.worker + MIN.review + MIN.ci + MIN.merge : MIN.review + MIN.ci + MIN.merge;
    return { call: "extend", reason: `a ${cut.role} canceled in flight that started late in the window, on its first attempt`, estimate: estimate(w, `the ${cut.role} again, then what follows it`, minutes, cut.role === "worker" ? { worker: 1, reviewer: 1, turns: 3 } : { reviewer: 1, turns: 2 }) };
  }
  const [pr] = w.situation.pullRequests.filter((p) => p.state === "open");
  const pending = pr && pr.checks.required.some((c) => c.state === "pending") && !pr.checks.required.some((c) => c.state === "failed");
  if (pr && pending && headVerdict(w.situation.runs, pr)?.verdict === "approve" && w.mergePolicy(pr.repo) === "sergeant") {
    return { call: "extend", reason: "an approved PR waits only on CI before Sergeant merges it", estimate: estimate(w, "one CI check and merge", MIN.ci + MIN.merge, { turns: 1 }) };
  }
  return { call: "ask", reason: "no rubric rule settles it; the case above is for you to judge" };
}

/** The concrete remaining steps shared by the standing text and fallback cost estimates. */
export function stepsLeft(w: WindowFacts, pr: PullRequestFacts): RemainingStep[] {
  const review = headVerdict(w.situation.runs, pr);
  const findings = review?.verdict === "changes_requested" ? review.findings.filter((f) => f.severity === "blocking") : [];
  const humans = outstandingChangeRequests(pr.humanFeedback);
  const failed = pr.checks.required.filter((c) => c.state === "failed").map((c) => c.name);
  const steps: RemainingStep[] = [];
  if (findings.length) steps.push({ label: `fix ${findings.length} blocking finding${findings.length === 1 ? "" : "s"}`, kind: "worker" });
  if (humans.length) steps.push({ label: `address ${humans.join(", ")}'s requested changes`, kind: "worker" });
  if (failed.length) steps.push({ label: `fix failing checks (${failed.join(", ")})`, kind: "worker" });
  if (pr.mergeableState === "dirty") steps.push({ label: "resolve merge conflicts", kind: "mechanical" });
  else if (pr.mergeableState === "behind") steps.push({ label: "rebase onto the base branch", kind: "mechanical" });
  if (pr.draft) steps.push({ label: "mark the PR ready for review", kind: "mechanical" });
  if (!review || steps.length) steps.push({ label: review ? "a re-review" : "a review", kind: "reviewer" });
  const awaited = pr.checks.required.some((c) => c.state === "missing") && w.situation.conversation.agentComments.some((c) => c.id === commentIdFor(expiredChecksKey(w.situation.conversation.issue.id, pr)));
  // TECH-6489: a missing check Sergeant's own re-trigger did not bring back waits on a human, not on CI.
  if (awaited) steps.push({ label: "a human to re-trigger the missing required checks", kind: "ci" });
  else if (pr.checks.required.some((c) => c.state === "pending" || c.state === "missing")) steps.push({ label: "CI to finish", kind: "ci" });
  steps.push({ label: w.mergePolicy(pr.repo) === "sergeant" ? "Sergeant's merge" : "a human's merge (mergePolicy human)", kind: "merge" });
  return steps;
}

function remainingEstimate(w: WindowFacts): string {
  const open = w.situation.pullRequests.filter((p) => p.state === "open");
  const steps = open.length
    ? open.flatMap((pr) => stepsLeft(w, pr))
    : [
        { label: "a worker to finish the change and open its PR", kind: "worker" as const },
        { label: "a review", kind: "reviewer" as const },
        { label: "a merge", kind: "merge" as const },
      ];
  const counts = (kind: RemainingStep["kind"]) => steps.filter((s) => s.kind === kind).length;
  const minutes = counts("worker") * MIN.worker + counts("mechanical") * MIN.mechanical + counts("reviewer") * MIN.review + counts("ci") * MIN.ci + counts("merge") * MIN.merge;
  return estimate(w, steps.map((s) => s.label).join(", then "), minutes, { worker: counts("worker"), reviewer: counts("reviewer"), turns: counts("merge") });
}

/** Worker runs in the window that followed a review requesting changes: one fix cycle each. */
export function fixCycles(runs: RunRecord[]): number {
  let requested = false;
  let cycles = 0;
  for (const r of runs) {
    if (r.role === "reviewer" && r.report) requested = r.report.verdict === "changes_requested";
    else if (r.role === "worker" && requested) {
      cycles += 1;
      requested = false;
    }
  }
  return cycles;
}

/**
 * A blocking finding of the window's latest review whose location an earlier review in the window also
 * flagged as blocking. Matching on the location alone is a deliberate, cheap stand-in for "the same
 * finding": two reviews never share finding ids, and their wording differs.
 */
function recurringFinding(runs: RunRecord[]): string | undefined {
  const reviews = runs.flatMap((r) => (r.role === "reviewer" && r.report ? [r.report] : []));
  const latest = reviews.at(-1);
  if (latest?.verdict !== "changes_requested") return undefined;
  const earlier = new Set(reviews.slice(0, -1).flatMap((r) => r.findings.filter((f) => f.severity === "blocking" && f.location).map((f) => f.location)));
  return latest.findings.find((f) => f.severity === "blocking" && f.location && earlier.has(f.location))?.location;
}

/** Two or more restarts or steers of the same run, and none of its attempts left a report. */
function churnWithoutReport(w: WindowFacts): string | undefined {
  const byId = new Map(w.runs.map((r) => [r.runId, r]));
  const retried = new Set(Object.values(w.retries).flatMap((r) => (r.retryRunId ? [r.retryRunId] : [])));
  for (const root of w.runs.filter((r) => !retried.has(r.runId))) {
    const chain: RunRecord[] = [root];
    for (let next = w.retries[root.runId]?.retryRunId; next && byId.has(next); next = w.retries[next]?.retryRunId) chain.push(byId.get(next) as RunRecord);
    const restarts = chain.length - 1;
    const steers = chain.reduce((n, r) => n + (w.steers[r.runId] ?? 0), 0);
    if (restarts + steers >= 2 && chain.every((r) => r.status !== "running" && r.report === null)) {
      return `the ${root.role} ${root.runId} was restarted ${restarts} and steered ${steers} time${restarts + steers === 1 ? "" : "s"} without producing a report`;
    }
  }
  return undefined;
}

/** What a run of the window said it cannot get: unreadable inputs, a decision, or a human's review. */
function missingInput(runs: RunRecord[]): string | undefined {
  const last = runs.filter((r) => r.report).at(-1);
  if (!last?.report) return undefined;
  const inputs = last.report.unreadableInputs ?? [];
  if (inputs.length > 0) return `inputs it could not read: ${inputs.map((i) => `${i.input} (${i.reason})`).join(", ")}`;
  if (last.role === "reviewer" && last.report.verdict === "needs_human") return `a human's call the reviewer asked for: ${clip(last.report.summary)}`;
  if (last.role === "worker" && (last.report.outcome === "needs_decision" || last.report.outcome === "blocked")) return `what the worker reported it needs (${last.report.outcome}): ${clip(last.report.summary)}`;
  return undefined;
}

/** The latest Sergeant review of this exact head, if any. */
export function headVerdict(runs: RunRecord[], pr: PullRequestFacts) {
  return runs
    .flatMap((r) => (r.role === "reviewer" && r.report?.reviewed.some((s) => s.repo === pr.repo && s.number === pr.number && s.headSha === pr.headSha) ? [r.report] : []))
    .at(-1);
}

/**
 * "about 20 min and $4": the steps' length, and their cost from this task's own finished runs of each
 * role and the window's turns. Each role is priced from its own runs (TECH-6225): only a role with no
 * run that reported a cost is left unknown, and named, so a known role's runs always give an estimate.
 */
function estimate(w: WindowFacts, what: string, minutes: number, steps: { worker?: number; reviewer?: number; turns: number }): string {
  const average = (role: RunRecord["role"]) => {
    const costs = w.situation.runs.filter((r) => r.role === role && r.costUsd !== undefined).map((r) => r.costUsd as number);
    return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined;
  };
  const turn = w.turns > 0 ? w.turnCostUsd / w.turns : 0;
  const roles = (["worker", "reviewer"] as const).filter((role) => steps[role]).map((role) => ({ role, each: average(role), count: steps[role] ?? 0 }));
  const unknown = roles.filter((r) => r.each === undefined).map((r) => r.role);
  const usd = Math.max(1, Math.round(roles.reduce((sum, r) => sum + (r.each ?? 0) * r.count, steps.turns * turn)));
  const why = `no ${unknown.join(" or ")} run of this task has reported a cost yet`;
  const money = unknown.length === 0 ? `$${usd}` : unknown.length < roles.length ? `$${usd} plus the ${unknown.join(" and ")}'s cost, not yet known (${why})` : `a cost not yet known (${why})`;
  return `${what}, about ${minutes} min and ${money}`;
}

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

import type { SituationReport } from "@terros/sergeant-contracts";
import type { Reasoner, TurnResult } from "@terros/sergeant-reasoning";
import { execute, type ActionOutcome, type Ports } from "./execute.ts";

export { describeOutcome, execute, type ActionOutcome, type Ports } from "./execute.ts";

/**
 * One turn: fresh reasoning over the snapshot, then each proposal through the Gate, in order. A run
 * started earlier in the turn is visible to the Gate for later proposals (R1, R2), and a follow-up
 * filed earlier is visible too, so a repeated key files no second issue. A turn that asks a human does
 * nothing else, before or after the question and whether or not it posts (Q1). The turn's own reported
 * cost counts against the budget before any proposal runs (B1). Once a start reaches the runner, no
 * other start runs in the turn, whether it succeeded or failed: a start whose response was lost may be
 * running, and the next poll reconciles its id before another start (R4).
 */
export async function takeTurn(
  situation: SituationReport,
  deps: Ports & { reasoner: Reasoner },
): Promise<{ turn: TurnResult; outcomes: ActionOutcome[] }> {
  const turn = await deps.reasoner.turn(situation);
  const outcomes: ActionOutcome[] = [];
  let current = { ...situation, budget: { ...situation.budget, spentUsd: situation.budget.spentUsd + (turn.costUsd ?? 0) } };
  let startAttempted = false;
  // A run's id is recorded immediately before the runner is asked to start it (UNF-728).
  const ports: Ports = {
    ...deps,
    async recordRun(runId) {
      startAttempted = true;
      await deps.recordRun?.(runId);
    },
  };
  // Q1: nothing else happens on the task until a human answers the question (UNF-727).
  const ask = turn.output.actions.find((a) => a.kind === "ask_human");
  // Q2: a turn that ends the task on the human's word does nothing else either (TECH-5118).
  const accept = ask ? undefined : turn.output.actions.find((a) => a.kind === "accept_as_is");
  let merged = false;
  for (const action of turn.output.actions) {
    if (ask && action !== ask) {
      outcomes.push({ action, status: "denied", rule: "Q1", reason: "this turn asks a human, so it does nothing else" });
      continue;
    }
    if (accept && action !== accept) {
      outcomes.push({ action, status: "denied", rule: "Q2", reason: "this turn accepts the work as it is, so it does nothing else" });
      continue;
    }
    // M11: a merge ends its turn, so nothing later in it runs (UNF-733).
    if (merged) {
      outcomes.push({ action, status: "denied", rule: "M11", reason: "this turn merged, so it does nothing after the merge" });
      continue;
    }
    if (startAttempted && (action.kind === "start_worker" || action.kind === "start_reviewer")) {
      outcomes.push({ action, status: "denied", rule: "R4", reason: "this turn already asked the runner to start a run" });
      continue;
    }
    const outcome = await execute(action, current, ports);
    outcomes.push(outcome);
    if (outcome.status === "done" && outcome.merged) merged = true;
    if (outcome.status === "done" && outcome.started) current = { ...current, runs: [...current.runs, outcome.started] };
    const filed = outcome.status === "done" ? outcome.followup : undefined;
    if (filed && !current.followups.some((f) => f.key === filed.key)) current = { ...current, followups: [...current.followups, filed] };
  }
  return { turn, outcomes };
}

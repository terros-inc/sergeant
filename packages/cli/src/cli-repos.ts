import { RepositoryBudgetChange, RepositoryChange, RepositoryList } from "@terros/sergeant-contracts";
import { type Command, callAnswer, print, Usage } from "./cli-call.ts";
import { table } from "./format.ts";

// `sgt repo list`, any signed-in user's, and an approver's `sgt admin repo add`, `remove`, and `budget` (TECH-6606).

export const repoCommands: Record<string, Command> = {
  "repo list": {
    args: 0,
    run: async (ctx) => {
      const { value: { repositories }, answer } = await callAnswer(ctx, "GET", "/v1/repositories", RepositoryList);
      print(ctx, answer, () => (repositories.length ? table(repositories.map((r) => [r.repo, r.mergeMethod, `merged by ${r.mergePolicy}`, budgetText(r)])) : "no enrolled repositories"));
    },
  },
  "admin repo add": {
    args: 1,
    flags: ["merge-method", "merge-policy"],
    run: async (ctx, [repo]) => {
      const body = { repo, mergeMethod: ctx.flags["merge-method"], mergePolicy: ctx.flags["merge-policy"] };
      const { value: res, answer } = await callAnswer(ctx, "POST", "/v1/repositories/add", RepositoryChange, body);
      print(ctx, answer, () => `${res.changed ? "enrolled" : "already enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ")}`);
    },
  },
  "admin repo budget": {
    args: 1,
    usage: "admin repo budget <owner/name> [--wall-minutes N|default] [--cost-usd N|default]",
    flags: ["wall-minutes", "cost-usd"],
    run: async (ctx, [repo]) => {
      const wallMinutes = budgetFlag(ctx.flags["wall-minutes"], "--wall-minutes");
      const costUsd = budgetFlag(ctx.flags["cost-usd"], "--cost-usd");
      if (wallMinutes === undefined && costUsd === undefined) throw new Usage("admin repo budget takes --wall-minutes, --cost-usd, or both");
      const { value: res, answer } = await callAnswer(ctx, "POST", "/v1/repositories/budget", RepositoryBudgetChange, { repo, wallMinutes, costUsd });
      print(ctx, answer, () =>
        [
          `${res.changed ? "set" : "already set:"} ${res.repo}'s budget window: ${budgetText(res)}`,
          "serve uses it now, no restart needed. Only budget windows that open from now on get it: a task's current window keeps the budget it opened with until its next fresh one.",
        ].join("\n"),
      );
    },
  },
  "admin repo remove": {
    args: 1,
    run: async (ctx, [repo]) => {
      const { value: res, answer } = await callAnswer(ctx, "POST", "/v1/repositories/remove", RepositoryChange, { repo });
      print(ctx, answer, () => `${res.changed ? "removed" : "not enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ") || "none"}`);
    },
  },
};

/**
 * A budget flag as the request's field: a positive number sets it, `default` clears it, absent leaves
 * it. A run of digits too long for a double is Infinity, which JSON sends as null: refused here, and
 * by serve too.
 */
function budgetFlag(value: string | undefined, flag: string): number | "default" | undefined {
  if (value === undefined || value === "default") return value;
  const n = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(n) || !(n > 0)) throw new Usage(`${flag} must be a positive number, or default`);
  return n;
}

/** `60 min (own), $25`: the window a task working there gets, each field the repository's own marked. Empty from a serve older than TECH-6606. */
function budgetText({ budget, ownBudget }: { budget?: { wallMinutes: number; costUsd: number } | undefined; ownBudget?: { wallMinutes?: number | undefined; costUsd?: number | undefined } | undefined }): string {
  if (!budget) return "";
  const own = (field: "wallMinutes" | "costUsd") => (ownBudget?.[field] === undefined ? "" : " (own)");
  return `${budget.wallMinutes} min${own("wallMinutes")}, $${budget.costUsd}${own("costUsd")}`;
}

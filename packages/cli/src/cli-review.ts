import { type ReadinessRow, ReviewReadiness } from "@terros/sergeant-contracts";
import { type Command, callAnswer, print, Usage } from "./cli-call.ts";
import { table } from "./format.ts";

// `sgt review readiness` (TECH-6613, design 16 §7.1): how often a human merged exactly the head Sergeant
// declared ready, as the fraction with every count beside it. UNKNOWN is reported, never in the rate.

export const reviewCommands: Record<string, Command> = {
  "review readiness": {
    args: 0,
    flags: ["since", "repo", "list"],
    run: async (ctx) => {
      const { since, repo } = ctx.flags;
      if (since !== undefined && !/^[1-9]\d{0,4}d$/.test(since)) throw new Usage("--since must be a number of days, like 90d");
      const query = new URLSearchParams({ ...(since && { since }), ...(repo && { repo }) }).toString();
      const { value, answer } = await callAnswer(ctx, "GET", `/v1/review-readiness${query ? `?${query}` : ""}`, ReviewReadiness);
      print(ctx, answer, () => {
        const scope = `${value.repo ?? "all repositories"}, ${since ? `last ${since.slice(0, -1)} days` : "all time"}`;
        const lines = [`Sergeant readiness, ${scope}`, `  ${rate(value)}`, `  ${unknown(value)}`, `  Mergers: ${value.mergers.map((m) => `${m.login} ${m.count}`).join(", ") || "none"}`];
        if (ctx.flags.list && value.declarations.length) lines.push("", table(value.declarations.map(row)));
        return lines.join("\n");
      });
    },
  },
};

/** Always the fraction; the percentage only when something was evaluated. */
function rate(r: ReviewReadiness): string {
  const pct = r.evaluated ? ` = ${((100 * r.agreed) / r.evaluated).toFixed(1)}%` : "";
  return `AGREED ${r.agreed} / evaluated ${r.evaluated}${pct}   (DIFFERENT_HEAD ${r.differentHead}, REJECTED ${r.rejected})`;
}

function unknown(r: ReviewReadiness): string {
  const reasons = Object.entries(r.unknown).filter(([, n]) => n > 0);
  const total = reasons.reduce((sum, [, n]) => sum + n, 0);
  return `UNKNOWN ${total}${reasons.length ? `: ${reasons.map(([reason, n]) => `${reason} ${n}`).join(", ")}` : ""}`;
}

const row = (d: ReadinessRow) => [d.url, d.headSha, d.class === "UNKNOWN" ? `UNKNOWN (${d.reason})` : d.class, d.declarationReason ?? "-"];

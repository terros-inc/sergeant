import { type AuditCounts, type AuditRow, type ReadinessRow, ReviewAudits, ReviewReadiness } from "@terros/sergeant-contracts";
import { type Command, callAnswer, print, Usage } from "./cli-call.ts";
import { table } from "./format.ts";

// `sgt review readiness` (TECH-6613, design 16 §7.1): how often a human merged exactly the head Sergeant
// declared ready, as the fraction with every count beside it. UNKNOWN is reported, never in the rate.
// `sgt review audits` (TECH-6619, design 16 §7.2): post-merge audit yield and FAIL rate, the same way.

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
  "review audits": {
    args: 0,
    flags: ["since", "repo", "found", "by"],
    run: async (ctx) => {
      const { since, repo, by } = ctx.flags;
      if (since !== undefined && !/^[1-9]\d{0,4}d$/.test(since)) throw new Usage("--since must be a number of days, like 30d");
      if (by !== undefined && by !== "repo" && by !== "sergeant") throw new Usage("--by must be repo or sergeant");
      const query = new URLSearchParams({ ...(since && { since }), ...(repo && { repo }) }).toString();
      const { value, answer } = await callAnswer(ctx, "GET", `/v1/review-audits${query ? `?${query}` : ""}`, ReviewAudits);
      print(ctx, answer, () => {
        const scope = `${value.repo ?? "all repositories"}, ${since ? `last ${since.slice(0, -1)} days` : "all time"}`;
        const lines = [`Post-merge audits, ${scope}`, `  ${auditYield(value)}`, `  ${failRate(value)}`];
        if (value.incomplete) lines.push(`  Not completed ${value.incomplete}`);
        lines.push(`  Accounts: ${accounts(value.audits)}`);
        const split =
          by === "repo"
            ? value.byRepo.map((r) => [r.repo, r] as const)
            : by === "sergeant"
              ? ([["AGREED heads", value.bySergeant.agreed], ["Sergeant-merged", value.bySergeant.sergeant_merged], ["Other PRs", value.bySergeant.other]] as const)
              : [];
        if (split.length) lines.push("", table(split.map(([label, c]) => [`  ${label}`, foundYes(c), `(Found unknown ${c.foundUnknown})`, failRate(c)])));
        if (ctx.flags.found) for (const a of value.audits.filter((r) => r.found === true)) lines.push("", ...foundRows(a));
        return lines.join("\n");
      });
    },
  },
};

/** Always the fraction; the percentage only of something. */
const fraction = (n: number, of: number, denominator: string) => `${n} / ${denominator} ${of}${of ? ` = ${((100 * n) / of).toFixed(1)}%` : ""}`;
/** Yield over audits with a known Found; unknown is shown beside it, never in it. */
const foundYes = (c: AuditCounts) => `Found YES ${fraction(c.found, c.foundKnown, "known")}`;
const auditYield = (c: AuditCounts) => `${foundYes(c)}   (Found unknown ${c.foundUnknown})`;
const failRate = (c: AuditCounts) => `FAIL ${fraction(c.fail, c.completed, "completed")}`;

/** TECH-6625: whose accounts ran the audits listed, with how many each; the audit owner standing in for a PR's person apart. */
function accounts(audits: AuditRow[]): string {
  const counts = new Map<string, number>();
  for (const a of audits) {
    const who = a.accountsOf ? payer(a.accountsOf) : "not recorded";
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts].map(([who, n]) => `${who} ${n}`).join(", ") || "none";
}

const payer = (p: NonNullable<AuditRow["accountsOf"]>) => `${p.name}${p.fallback ? " (audit owner fallback)" : ""}`;

/** One Found: YES: the PR, head, verdict and run, then the reviewer's summary and every finding in full. */
function foundRows(a: AuditRow): string[] {
  const indent = (text: string) => text.trim().replace(/\r?\n/g, "\n    ");
  const verdict = a.verdict === "approve" ? "PASS" : "FAIL";
  const head = `${a.url}  ${a.headSha}  ${verdict}  ${a.issue}  ${a.runId}${a.accountsOf ? `  on ${payer(a.accountsOf)}'s accounts` : ""}`;
  if (a.findings === undefined) return [head, "  findings unavailable"];
  const findings = (a.findings ?? []).map((f) => `  - [${f.severity}${f.category ? `, ${f.category}` : ""}] ${f.location ? `${f.location}: ` : ""}${indent(f.description)}`);
  return [head, ...(a.summary?.trim() ? [`  ${indent(a.summary)}`] : []), ...(findings.length ? findings : ["  (no findings in the run's record)"])];
}

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

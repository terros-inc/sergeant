import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Conversation, isRateLimited, type LinearPerson, NoModelAccount, type PullRequestFeedback, RepoSlug, RunId, safeJson, Sha } from "@terros/sergeant-contracts";
import { z } from "zod";
import { type AuditPayer, auditOwnerPerson, payerOf, prOwner } from "./audit-payer.ts";
import type { Ports } from "./execute-types.ts";
import { harvestAudits } from "./merged-audit-harvest.ts";
import { auditDrawn, auditRunId, type PrHead } from "./review-quality.ts";
import { isTaskStateFile, landings, readTaskState } from "./task-state.ts";
import { pause } from "./wake.ts";

// TECH-6617: the merged-PR audit (06 §8). Once a day, in each enrolled repository whose
// `mergedAuditSampleRate` is above 0, the PRs merged into its default branch in the last 72 hours are
// drawn on a stable hash salted apart from the skipped-review draw, and each drawn PR gets a nonblocking
// reviewer of its pre-merge head, judged as of the merge. The run id is `auditRunId` of the PR and head,
// so a restart or a re-scan of the overlapping window starts nothing new (the runner's start is
// idempotent on it), and a head a task's own audit already took keeps that audit's id. These audits run
// outside any task, on the registered accounts of the person the PR belongs to, else `review.auditOwner`'s
// (TECH-6625, audit-payer.ts), within one daily cap whoever pays, and are finished by `harvestAudits`
// (TECH-6618). The only state is `merged-audits.json`: when the last pass ran and the audits it started,
// with what was recorded of each, so the cap holds across a restart; losing it means one more pass now, a
// cap that forgets the last day, and, for an audit whose PR has left the window, no record (`reviews.jsonl` keeps any audit already recorded from being recorded twice).

const WINDOW_MS = 72 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** The daily cap when the config sets none. */
export const DEFAULT_QUALITY_BUDGET_USD_PER_DAY = 25;
/**
 * What an audit whose cost is not known yet (still running, or a model with no price) counts against
 * the cap: the runner's default cost limit for a reviewer (`DEFAULT_LIMITS`), so unknown is never $0.
 */
const UNKNOWN_AUDIT_USD = 5;

const Ledger = z.object({
  lastPassAt: z.iso.datetime().optional(),
  started: z
    .array(
      z.object({
        runId: RunId,
        at: z.iso.datetime(),
        /** TECH-6618: the merged PR it audits, so it is harvested even after the PR leaves the 72-hour window. */
        subject: z.object({ repo: RepoSlug, number: z.number().int(), headSha: Sha, mergedSha: Sha, issue: z.string().optional() }).optional(),
        /** Its `ReviewFacts` line is written, the last step, after its comment settled. */
        recorded: z.boolean().optional(),
        /** Its PR comment, once posted. */
        auditCommentId: z.number().int().optional(),
        /** TECH-6625: whose registered accounts run it. */
        accountsOf: z.object({ id: z.string(), name: z.string(), fallback: z.literal(true).optional() }).optional(),
        /**
         * Set when the run could not be read just after it started, so whose accounts it is on is not known
         * yet: the harvest reads it back at its next read of the run, with the PR's own person, if any, to
         * tell them from the fallback. Never recorded as no one's for want of a read.
         */
        payerPending: z.object({ prOwner: z.object({ id: z.string(), name: z.string() }).optional() }).optional(),
      }),
    )
    .default([]),
});
export type Ledger = z.infer<typeof Ledger>;

export type MergedAuditOptions = {
  stateDir: string;
  /** Read at each pass: enrollment.ts changes it in place. */
  enrolledRepositories: readonly RepoSlug[];
  /** The repository's live `mergedAuditSampleRate`, 0 when absent. */
  rateOf: (repo: RepoSlug) => number;
  /** `review.auditOwner`: who pays when the PR's own person cannot. Absent, a PR with no one of its own to pay is not audited. */
  auditOwner?: string | undefined;
  budgetUsdPerDay?: number | undefined;
  log: (line: string) => void;
  signal?: AbortSignal;
  now?: () => Date;
};
export type MergedAuditDeps = Pick<Ports, "github" | "linear" | "runner" | "workerLogin" | "linearProfileForGitHubLogin">;

/** Checks hourly whether a pass is due, so a restart neither skips a day nor runs one twice. */
export async function mergedAuditsEvery(opts: MergedAuditOptions, deps: MergedAuditDeps): Promise<void> {
  while (!opts.signal?.aborted) {
    await mergedAuditPass(opts, deps).catch((e: Error) => opts.log(`merged-PR audits: pass failed, retrying within the hour: ${e.message}`));
    await pause(3_600_000, opts.signal);
  }
}

/** Harvests the audits that finished, then draws, if a day has gone by since the last draw. */
export async function mergedAuditPass(opts: MergedAuditOptions, deps: MergedAuditDeps): Promise<void> {
  const now = opts.now?.() ?? new Date();
  const file = join(opts.stateDir, "merged-audits.json");
  const ledger = await readLedger(file);
  const save = async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger, null, 2));
    await rename(tmp, file);
  };
  await harvestAudits(ledger, opts, deps, save);
  const repos = opts.enrolledRepositories.filter((r) => opts.rateOf(r) > 0);
  if (repos.length === 0) return;
  if (ledger.lastPassAt && now.getTime() - Date.parse(ledger.lastPassAt) < DAY_MS) return;
  // An audit not recorded yet is kept however long its run takes; a recorded one only while a re-scan
  // could still meet its PR, so the draw knows it.
  ledger.started = ledger.started.filter((s) => (s.subject && !s.recorded) || now.getTime() - Date.parse(s.at) < WINDOW_MS + DAY_MS);
  const taskAudit = await taskAudits(opts.stateDir);
  const known = new Set([...ledger.started.map((s) => s.runId), ...taskAudit.values()]);
  const cap = opts.budgetUsdPerDay ?? DEFAULT_QUALITY_BUDGET_USD_PER_DAY;
  let spent = await spentToday(ledger, now, deps);
  const since = new Date(now.getTime() - WINDOW_MS);
  scan: for (const repo of repos) {
    const merged = (await deps.github.mergedPullRequests?.(repo, since)) ?? [];
    for (const m of merged) {
      if (opts.signal?.aborted) return;
      const head: PrHead = { repo, number: m.number, headSha: m.headSha };
      if (!auditDrawn(opts.rateOf(repo), head, "merged-audit")) continue;
      // A head a task's audit already took is audited once, under the id that task recorded.
      const runId = taskAudit.get(headKey(head)) ?? auditRunId(repo, m.number, m.headSha);
      if (known.has(runId)) {
        // An entry written before TECH-6618 has no PR head, so the harvest skips it: the re-scan gives it one.
        const legacy = ledger.started.find((s) => s.runId === runId && !s.subject);
        if (!legacy) continue;
        const read = await deps.github.readPullRequest(repo, m.number).then(
          (pr) => ({ issue: referencedIssue(m.title, pr.body) }),
          (e: Error) => {
            if (isRateLimited(e)) throw e;
            opts.log(`merged-PR audit ${runId} of ${repo}#${m.number}: PR unreadable, retrying next pass: ${e.message}`);
            return undefined;
          },
        );
        if (!read) continue;
        legacy.subject = { repo, number: m.number, headSha: m.headSha, mergedSha: m.mergedSha, ...(read.issue && { issue: read.issue }) };
        await save();
        continue;
      }
      // The audit starts only if its own reservation fits too, so the cap is never overshot.
      if (spent + UNKNOWN_AUDIT_USD > cap) {
        opts.log(`merged-PR audits: another audit would exceed the daily cap of $${cap.toFixed(2)} ($${spent.toFixed(2)} spent); ${repo}#${m.number} and the rest wait for the next day's pass`);
        break scan;
      }
      const started = await startAudit(runId, { ...m, repo }, opts, deps).catch((e: Error) => {
        if (isRateLimited(e)) throw e;
        opts.log(`merged-PR audit ${runId} of ${repo}#${m.number} not started, retrying next pass: ${e.message}`);
        return undefined;
      });
      if (!started) continue;
      const { issue, accountsOf, payerPending } = started;
      const on = accountsOf
        ? `${accountsOf.name}'s accounts${accountsOf.fallback ? " (review.auditOwner, the fallback)" : ""}`
        : payerPending
          ? "accounts not read yet (its run was unreadable; read back at the next check)"
          : "accounts its run does not name";
      opts.log(`merged-PR audit ${runId} started for ${repo}#${m.number} as of its merge (nonblocking), on ${on}`);
      known.add(runId);
      const subject = { repo, number: m.number, headSha: m.headSha, mergedSha: m.mergedSha, ...(issue && { issue }) };
      ledger.started.push({ runId, at: now.toISOString(), subject, ...(accountsOf && { accountsOf }), ...(payerPending && { payerPending }) });
      spent += UNKNOWN_AUDIT_USD;
      await save();
    }
  }
  ledger.lastPassAt = now.toISOString();
  await save();
}

type MergedPr = PrHead & { title: string; mergedSha: Sha; mergedAt: string };

/**
 * Starts the audit of the PR's pre-merge head, with the brief as of its merge, on the accounts of the
 * PR's person, else of `review.auditOwner`; resolves the Linear issue the PR names, and whose accounts the
 * run is on, absent when the run does not say, or pending when the run could not be read back. Throws, having started nothing, when neither has a usable
 * account, saying why.
 */
async function startAudit(runId: RunId, m: MergedPr, opts: MergedAuditOptions, deps: MergedAuditDeps): Promise<{ issue: string | undefined; accountsOf?: AuditPayer; payerPending?: Ledger["started"][number]["payerPending"] }> {
  // A review's edit time comes only from its own read, and the brief needs it to withhold a review
  // edited after the merge: without it, start nothing (retried next pass) rather than show hindsight.
  if (!deps.github.reviewEdits) throw new Error("GitHub cannot say when its reviews were last edited");
  const [read, edits] = await Promise.all([deps.github.readPullRequest(m.repo, m.number), deps.github.reviewEdits(m.repo, m.number)]);
  const edited = (f: PullRequestFeedback): PullRequestFeedback => (edits[f.id] ? { ...f, updatedAt: edits[f.id]! } : f);
  const pr = { ...read, humanFeedback: read.humanFeedback.map(edited), ...(read.botFeedback && { botFeedback: read.botFeedback.map(edited) }) };
  const baseSha = await deps.github.firstParent?.(m.repo, m.mergedSha);
  const issue = referencedIssue(m.title, pr.body);
  // An unreadable reference leaves the PR's own text as the requirements, as with none.
  const conversation: Conversation | undefined = issue ? await deps.linear.readConversation(issue).catch(() => undefined) : undefined;
  const spec = (owner: LinearPerson) => ({
    runId,
    // The runner picks among this person's registered accounts.
    owner,
    role: "reviewer" as const,
    ...(conversation && { conversation }),
    repositories: [m.repo],
    subject: [{ repo: m.repo, number: m.number, headSha: m.headSha, ...(baseSha && { baseSha }) }],
    pullRequests: [pr],
    feedbackCutoff: m.mergedAt,
    focus: `Audit review as of merge (nonblocking). This PR merged as ${m.mergedSha} at ${m.mergedAt}. Sergeant audits a
random sample of the PRs merged in this repository, whoever wrote them and however they were reviewed, to
measure how often a merged change had an actionable issue nobody raised before its merge. Review this head as
you would have just before the merge. Nothing you find blocks, reverts, or reopens anything.`,
  });
  // Why nobody's accounts could run it, if so. The runner refuses with `NoModelAccount` having started nothing.
  const why: string[] = [];
  const start = async (owner: LinearPerson): Promise<boolean> => {
    try {
      await deps.runner.start(spec(owner));
      return true;
    } catch (e) {
      if (!(e instanceof NoModelAccount)) throw e;
      why.push(`${owner.name} has no usable model account (${e.message})`);
      return false;
    }
  };
  const own = await prOwner(read, issue, opts.stateDir, deps);
  // The runner's start is idempotent on the run id: when a lost ledger let this pass start an audit
  // already running, it returns that run as it is, on whoever's accounts it was started. So the payer is
  // read back from the run, never assumed to be the person just asked; a run that does not say is not named,
  // and one that cannot be read now is read back by the harvest rather than recorded as no one's.
  const ranOn = async () => {
    const person = "none" in own ? undefined : own;
    const run = await deps.runner.status(runId).catch(() => undefined);
    if (!run) return { issue, payerPending: { ...(person && { prOwner: { id: person.id, name: person.name } }) } };
    const accountsOf = await payerOf(run, person, opts.auditOwner, deps);
    return { issue, ...(accountsOf && { accountsOf }) };
  };
  if ("none" in own) why.push(`the PR belongs to no one with accounts here: ${own.none}`);
  else if (await start(own)) return ranOn();
  if (!opts.auditOwner) why.push("review.auditOwner, the fallback, is not set");
  else if ("none" in own || own.id !== opts.auditOwner) {
    if (await start(await auditOwnerPerson(opts.auditOwner, deps))) return ranOn();
  }
  throw new Error(`no one's accounts can run it: ${why.join("; ")}`);
}

/**
 * The Linear issue a PR names: a closing reference in its body (`Fixes TECH-1`, `Part of TECH-1`), else
 * an identifier leading its title (`TECH-1: …`, Sergeant's own PRs).
 */
export function referencedIssue(title: string, body: string): string | undefined {
  const closing = /\b(?:[Cc]lose[sd]?|[Ff]ix(?:e[sd])?|[Rr]esolve[sd]?|[Pp]art of)\b[:\s]+(?:\S*\/)?([A-Z][A-Z0-9]*-\d+)\b/.exec(body);
  return closing?.[1] ?? /^\[?([A-Z][A-Z0-9]*-\d+)\b/.exec(title)?.[1];
}

const headKey = (h: PrHead) => JSON.stringify([h.repo.toLowerCase(), h.number, h.headSha]);

/** Every audit a task recorded for a merged head, in any of its state files, by head. */
async function taskAudits(stateDir: string): Promise<Map<string, RunId>> {
  const audits = new Map<string, RunId>();
  const tasks = join(stateDir, "tasks");
  for (const id of await readdir(tasks).catch(() => [])) {
    for (const name of (await readdir(join(tasks, id)).catch(() => [])).filter(isTaskStateFile)) {
      const state = await readTaskState(join(tasks, id, name)).catch(() => undefined);
      for (const m of state ? landings(state) : []) if (m.audit) audits.set(headKey(m), m.audit.runId);
    }
  }
  return audits;
}

/** What the audits this loop started in the last 24 hours cost, each one not known yet counted at `UNKNOWN_AUDIT_USD`. */
async function spentToday(ledger: Ledger, now: Date, deps: MergedAuditDeps): Promise<number> {
  const today = ledger.started.filter((s) => now.getTime() - Date.parse(s.at) < DAY_MS);
  const costs = await Promise.all(today.map((s) => deps.runner.status(s.runId).then((r) => r.costUsd, () => undefined)));
  return costs.reduce<number>((sum, c) => sum + (c ?? UNKNOWN_AUDIT_USD), 0);
}

async function readLedger(file: string): Promise<Ledger> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return { started: [] };
  // A torn or unreadable file is a forgotten day, not a stopped loop.
  const parsed = Ledger.safeParse(safeJson(raw));
  return parsed.success ? parsed.data : { started: [] };
}

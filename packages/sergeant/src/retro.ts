import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RetroAnswer, type RetroCase, type RetroFiledIssue } from "@terros/sergeant-contracts";
import { RETRO_TITLE, type RetroLinear } from "@terros/sergeant-linear";
import type { Retro } from "@terros/sergeant-reasoning";
import { z } from "zod";
import type { Wake } from "./wake.ts";

// The Sergeant retro (TECH-5187): sees across tasks what a single worker can't. It runs on the control
// plane with Sergeant's own reasoning (never a worker or a model account of a person), when about ten
// tasks got a Sergeant feedback comment since the last retro, at most two weeks after the last one, or
// when a human asks (`sgt retro`). Nothing else schedules it: a healthy system leaves less feedback, so
// retros get rarer by themselves. It reads two inputs: the Sergeant feedback comments (TECH-5186) since
// the last retro, and what became of the issues Sergeant filed in that time. Reasoning checks the last
// retro's recommendations, finds themes, and rarely proposes an issue; Sergeant files each in Backlog in
// the Sergeant project, for a human to promote, and posts the retro as one document there.
//
// Linear is the store: the project's newest retro document says where the last window ended and what it
// filed. `retro.json` only keeps the answer of a retro whose filing or posting failed, so the retry
// finishes it without paying for a second answer. Its issues and document have ids derived from the
// window's start and the issue's key, so a retry posts one document and files each issue once. Losing
// the file mid-retro only means asking again, which may file a differently keyed issue: accepted.

/** About this many tasks with new Sergeant feedback make a retro due. */
export const RETRO_FEEDBACK_TASKS = 10;
/** A retro is due this long after the last one, at most, when there is anything new to read. */
export const RETRO_MAX_DAYS = 14;
const DAY_MS = 86_400_000;

export type RetroDeps = {
  linear: Pick<RetroLinear, "lastRetro" | "feedbackTasks" | "filedIssues" | "issues" | "fileIssue" | "postDocument">;
  reasoning: Retro;
  /** Sergeant's agent: the issues it created are the ones Sergeant filed. */
  agentUserId: string;
  /** The Sergeant project, where the retro is posted and its issues go, and the team they are filed in. */
  projectId: string;
  teamId: string;
};

export type RetroOptions = {
  stateDir: string;
  log: (line: string) => void;
  signal?: AbortSignal;
  now?: () => Date;
};

const Pending = z.object({ since: z.string(), until: z.string(), answer: RetroAnswer });

/**
 * Checks every `intervalMs`, and at once when `wake` is requested (a human's `sgt retro`). A failure is
 * logged and retried a day later, or sooner when a human asks again, so a retro that keeps failing after
 * a paid answer costs at most one answer a day.
 */
export async function retroEvery(intervalMs: number, wake: Wake, opts: RetroOptions, deps: RetroDeps): Promise<void> {
  while (!opts.signal?.aborted) {
    const manual = wake.pending;
    wake.pending = false;
    const failed = await runRetro(opts, deps, { manual }).then(
      () => false,
      (e: Error) => (opts.log(`retro failed, retrying in a day or at \`sgt retro\`: ${e.message}`), true),
    );
    if (failed && manual) wake.pending = true;
    await wake.sleep(failed ? DAY_MS : intervalMs, opts.signal);
  }
}

/** One check: runs the retro when it is due or asked for. Returns the document's URL when it posted one. */
export async function runRetro(opts: RetroOptions, deps: RetroDeps, { manual }: { manual: boolean }): Promise<string | undefined> {
  const now = opts.now?.() ?? new Date();
  const file = join(opts.stateDir, "retro.json");
  const last = await deps.linear.lastRetro(deps.projectId);
  // A saved answer is for the window since the newest retro; once a newer one is posted, it was posted.
  const lastUntil = last && (windowEnd(last.content) ?? last.createdAt);
  const saved = await readPending(file);
  let pending = saved && (lastUntil ? saved.since === lastUntil : true) ? saved : undefined;
  const since = pending?.since ?? lastUntil ?? new Date(now.getTime() - RETRO_MAX_DAYS * DAY_MS).toISOString();
  const feedbackTasks = await deps.linear.feedbackTasks(since);
  const filedIssues = (await deps.linear.filedIssues(deps.agentUserId, since)).sort(byCreated);
  if (!pending) {
    const overdue = !!last && now.getTime() - Date.parse(last.createdAt) >= RETRO_MAX_DAYS * DAY_MS && feedbackTasks.length + filedIssues.length > 0;
    if (!manual && feedbackTasks.length < RETRO_FEEDBACK_TASKS && !overdue) return undefined;
    const until = now.toISOString();
    const previous = last && { ...last, filed: (await deps.linear.issues(filedIn(last.content))).sort(byCreated) };
    const input: RetroCase = { since, until, previous: previous ?? null, feedbackTasks, filedIssues };
    const why = manual ? "asked for by a human" : overdue ? `${RETRO_MAX_DAYS} days since the last` : `${feedbackTasks.length} tasks with new feedback`;
    opts.log(`retro: ${why}; reading ${feedbackTasks.length} tasks with feedback and ${filedIssues.length} issues Sergeant filed since ${since}`);
    const { answer, costUsd } = await deps.reasoning.retro(input);
    pending = { since, until, answer };
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(pending, null, 2));
    await rename(tmp, file);
    opts.log(`retro: answered with ${answer.themes.length} themes and ${answer.issues.length} issues${costUsd === undefined ? "" : ` ($${costUsd.toFixed(2)})`}`);
  }

  const title = `${RETRO_TITLE} ${pending.until.slice(0, 10)}`;
  const filed = [];
  for (const issue of pending.answer.issues) {
    const ref = await deps.linear.fileIssue({
      teamId: deps.teamId,
      projectId: deps.projectId,
      title: issue.title,
      description: `${issue.description}\n\n---\n\n**Evidence:** ${issue.evidence.join(", ")}\n\nFiled in Backlog by ${title}. A human promotes it to Todo if they agree.`,
      key: `retro:${pending.since}:${issue.key}`,
    });
    filed.push({ ...ref, title: issue.title, kind: issue.kind });
  }
  const content = retroDocument(pending, feedbackTasks.length, filedIssues.length, filed);
  const { url } = await deps.linear.postDocument({ projectId: deps.projectId, title, content, key: `retro:${pending.since}` });
  await rm(file, { force: true });
  opts.log(`retro: posted ${url}${filed.length ? `, filed ${filed.map((f) => f.identifier).join(", ")} in Backlog` : ""}`);
  return url;
}

/** The retro document: short, with the section the next retro reads its filed issues from. */
export function retroDocument(
  { since, until, answer }: z.infer<typeof Pending>,
  feedbackTasks: number,
  filedIssues: number,
  filed: { identifier: string; url: string; title: string; kind: string }[],
): string {
  const themes = answer.themes.length
    ? answer.themes.map((t) => `### ${t.title}\n\n**Evidence:** ${t.evidence.join(", ")}\n\n**Recommendation:** ${t.recommendation}`).join("\n\n")
    : "No recurring themes.";
  return [
    `From ${since} to ${until}: ${feedbackTasks} tasks with Sergeant feedback, ${filedIssues} issues Sergeant filed.`,
    `## Last time\n\n${answer.lastTime}`,
    `## Themes\n\n${themes}`,
    `${FILED_HEADING}\n\n${filed.length ? filed.map((f) => `- [${f.identifier}](${f.url}) ${f.title} (${f.kind.replace(/_/g, " ")}), in Backlog`).join("\n") : "None."}`,
  ].join("\n\n");
}

const FILED_HEADING = "## Issues filed";

/** Where a retro document's window ended, from its first line, so the next window starts there. */
export function windowEnd(content: string): string | undefined {
  const until = /^From \S+ to (\S+):/.exec(content.trimStart())?.[1];
  return until && !Number.isNaN(Date.parse(until)) ? until : undefined;
}

/** The identifiers linked by a retro document's "Issues filed" list items, not those in their titles: what the previous retro filed. */
export function filedIn(content: string): string[] {
  const start = content.indexOf(FILED_HEADING);
  if (start < 0) return [];
  const section = content.slice(start + FILED_HEADING.length).split(/\n##? /)[0] ?? "";
  return [...new Set([...section.matchAll(/^- \[([A-Z][A-Z0-9]*-\d+)\]\(/gm)].map((m) => m[1] ?? ""))];
}

const byCreated = (a: RetroFiledIssue, b: RetroFiledIssue) => a.createdAt.localeCompare(b.createdAt);

/** The saved answer, if any; an unreadable file is as good as none (the retro is asked again). */
async function readPending(file: string): Promise<z.infer<typeof Pending> | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return Pending.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

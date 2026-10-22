import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyReadiness, type GitHubPort, type ReadinessRow, type ReviewReadiness } from "@terros/sergeant-contracts";
import { isTaskStateFile, readTaskState } from "./task-state.ts";

// TECH-6613: `GET /v1/review-readiness` (design 16 §7.1). Sergeant's declarations are the `refusedMerges`
// and `merged` records that carry a `readinessCommentId` (TECH-6610), in every task's `state.json` and
// every episode set aside after it: completed, accepted or stopped (task-state.ts `isTaskStateFile`).
// Each is classified on every call by rereading GitHub (contracts' classifyReadiness), so there is no
// index, cache or stored judgment: lose nothing, and a corrected rule reclassifies history.

export type Declared = { task: string; repo: string; number: number; headSha: string; commentId: number; at: string };
export type ClassifiedDeclaration = { row: ReadinessRow; mergedBySergeant: boolean };

/** At most this many declared PRs are reread at once, so a long history does not burst the rate limit. */
const CONCURRENT_READS = 4;

export async function reviewReadiness(
  tasksDir: string,
  github: Pick<GitHubPort, "readReadiness">,
  filter: { since?: Date; repo?: string },
): Promise<ReviewReadiness> {
  const wanted = (await declarations(tasksDir)).filter(
    (d) => (!filter.repo || d.repo.toLowerCase() === filter.repo.toLowerCase()) && (!filter.since || Date.parse(d.at) >= filter.since.getTime()),
  );
  const classified = await classifyDeclarations(wanted, github);
  const rows = classified.map((result) => result.row);
  const count = (c: ReadinessRow["class"]) => rows.filter((r) => r.class === c).length;
  const [agreed, differentHead, rejected] = [count("AGREED"), count("DIFFERENT_HEAD"), count("REJECTED")];
  const unknown = { pending: 0, closed_unmerged: 0, not_human_merge: 0, uninterpretable: 0 };
  for (const r of rows) if (r.class === "UNKNOWN") unknown[r.reason as keyof typeof unknown] += 1;
  const mergers = new Map<string, number>();
  for (const r of rows) if (r.merger) mergers.set(r.merger, (mergers.get(r.merger) ?? 0) + 1);
  return {
    ...(filter.since && { since: filter.since.toISOString() }),
    ...(filter.repo && { repo: filter.repo }),
    agreed,
    differentHead,
    rejected,
    evaluated: agreed + differentHead + rejected,
    unknown,
    mergers: [...mergers].map(([login, n]) => ({ login, count: n })).sort((a, b) => b.count - a.count || a.login.localeCompare(b.login)),
    declarations: rows,
  };
}

/** Each declaration classified from what GitHub says now (TECH-6611), in the order given. Also `sgt review audits --by sergeant`'s split. */
export async function classifyDeclarations(wanted: Declared[], github: Pick<GitHubPort, "readReadiness">): Promise<ClassifiedDeclaration[]> {
  const read = github.readReadiness;
  if (!read) throw new Error("this Sergeant's GitHub adapter cannot reread readiness declarations");
  const rows: ClassifiedDeclaration[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < wanted.length; i = next++) {
      const d = wanted[i] as Declared;
      // A PR that cannot be read fails the whole answer rather than vanishing from the denominator.
      const { declaration, facts } = await read({ repo: d.repo, number: d.number, commentId: d.commentId }).catch((e: Error) => {
        throw new Error(`could not reread ${d.repo}#${d.number} from GitHub (narrow with --repo to skip it): ${e.message}`);
      });
      const result = declaration ? classifyReadiness(declaration, facts) : { class: "UNKNOWN" as const, reason: "uninterpretable" as const };
      const url = `https://github.com/${d.repo}/pull/${d.number}`;
      const declarationReason = declaration?.body.split(/\r?\n/).find((line) => line.startsWith("Reason:"))?.slice("Reason:".length).trim();
      // A merge queue's own bot is never the merger: the human who queued it is (design 16 §5.2).
      const merger = facts.mergedBy?.type === "User" ? facts.mergedBy.login : facts.addedToMergeQueueActor?.login;
      const merged = result.class === "AGREED" || result.class === "DIFFERENT_HEAD";
      // The authenticated declaration establishes Sergeant's App login. A non-human merge belongs
      // to Sergeant only when GitHub attributes the merge to that same bot, not merely to any bot.
      const mergedBySergeant =
        result.reason === "not_human_merge" &&
        declaration !== null &&
        facts.mergedBy?.type === "Bot" &&
        facts.mergedBy.login.toLowerCase() === declaration.author.login.toLowerCase();
      const row: ReadinessRow = { task: d.task, repo: d.repo, number: d.number, url, commentUrl: `${url}#issuecomment-${d.commentId}`, headSha: d.headSha, at: d.at, class: result.class, reason: result.reason, ...(declarationReason && { declarationReason }), ...(merged && merger && { merger }) };
      rows[i] = { row, mergedBySergeant };
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_READS }, worker));
  return rows;
}

/**
 * Every declaration in the task records, oldest first. A merge after a refused merge of the same head
 * carries the same comment id, so each comment is counted once. A record that cannot be read is left out.
 */
export async function declarations(tasksDir: string): Promise<Declared[]> {
  const found = new Map<string, Declared>();
  for (const task of (await readdir(tasksDir).catch(() => [])).sort()) {
    const files = (await readdir(join(tasksDir, task)).catch(() => [])).filter(isTaskStateFile);
    for (const file of files) {
      const state = await readTaskState(join(tasksDir, task, file)).catch(() => undefined);
      if (!state) continue;
      for (const r of [...state.refusedMerges, ...(state.merged ? [state.merged] : [])]) {
        if (!r.readinessCommentId) continue;
        const key = `${r.repo.toLowerCase()}#${r.readinessCommentId}`;
        if (!found.has(key)) found.set(key, { task, repo: r.repo, number: r.number, headSha: r.headSha, commentId: r.readinessCommentId, at: r.at });
      }
    }
  }
  return [...found.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Finding, GitHubPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { issueComment, readAll } from "./pr-feedback.ts";

// TECH-6618: the post-merge audit's PR comment (06 §8, proposal 16 §6.4). Nothing a reviewer wrote
// reaches a public PR except through `auditComment`'s filter: the reviewer has no GitHub write access.

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Post = NonNullable<GitHubPort["postAuditComment"]>;
type Audit = Parameters<Post>[0];
/** The canonical public-data check's answer on one text: `fail` is a finding, `error` a usage, config or spawn error. */
export type PublicDataCheck = (text: string) => "pass" | "fail" | "error";

const LINE = /^Post-merge audit \(nonblocking\): (?:PASS|FAIL) \| Found: (?:YES|NO) \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_DESCRIPTION = 500;
// A scheme, `www.`, or a host name ending in one of a few web TLDs (`example.com`, `sub.example.io/path`).
// The TLD list is deliberately short so file names and member access (`audit-comment.ts`, `obj.method`)
// pass; dropping a finding is the safe direction, so `obj.co` going too is fine. The lookahead keeps
// `foo.app.ts` and `x.com_y` out, and lets a sentence-ending `example.com.` match.
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|[a-z0-9-]\.(?:com|net|org|io|dev|app|ai|co|us|gov|edu)(?![\w-]|\.\w)/i;

/** The fixed first line, from report fields only, never reviewer prose. */
export const auditVerdictLine = (a: Pick<Audit, "verdict" | "found" | "headSha">) =>
  `Post-merge audit (nonblocking): ${a.verdict === "approve" ? "PASS" : "FAIL"} | Found: ${a.found ? "YES" : "NO"} | SHA: ${a.headSha}`;

/** `<path>` or `<path>:<line>`, the path one of the PR's changed files. */
function codeLocation(location: string | undefined, changedFiles: ReadonlySet<string>): string | undefined {
  const m = /^(.*?)(?::([1-9]\d*))?$/.exec(location ?? "");
  return m?.[1] && changedFiles.has(m[1]) ? location : undefined;
}

/**
 * The comment's body. On a private repository: the verdict line, the reviewer's summary and every
 * finding. Otherwise only findings structurally about code (not `acceptance`, a changed-file location,
 * a one-line description of at most 500 characters with no URL), each passing `check`, and then the
 * whole comment passing it too. Dropped findings are counted, never quoted. No check (no denylist), a
 * check error, or a whole comment it rejects leaves the verdict line alone, with no count or other text.
 */
export function auditComment(a: Audit, visibility: { public: boolean; changedFiles: readonly string[]; check: PublicDataCheck | undefined }): string {
  const line = auditVerdictLine(a);
  const item = (f: Finding) => `- ${f.location ? `${f.location}: ` : ""}${f.description}`;
  if (!visibility.public) {
    const details = a.findings.map((f) => `- [${f.severity}${f.category ? `, ${f.category}` : ""}] ${f.location ? `${f.location}: ` : ""}${f.description}`);
    return [line, ...(a.summary.trim() ? ["", a.summary.trim()] : []), ...(details.length ? ["", ...details] : [])].join("\n");
  }
  const kept = (shown: Finding[]) => {
    const dropped = a.findings.length - shown.length;
    const note = dropped === 0 ? [] : ["", `${dropped} ${dropped === 1 ? "finding is" : "findings are"} kept in Sergeant's records (\`sgt review audits\`), not on this public PR.`];
    return [line, ...(shown.length ? ["", ...shown.map(item)] : []), ...note].join("\n");
  };
  const check = visibility.check;
  if (!check) return line;
  const files = new Set(visibility.changedFiles);
  const shown: Finding[] = [];
  for (const f of a.findings) {
    if (f.category === "acceptance" || !codeLocation(f.location, files)) continue;
    if (/[\r\n]/.test(f.description) || f.description.length > MAX_DESCRIPTION || URL_LIKE.test(f.description)) continue;
    const verdict = check(item(f));
    if (verdict === "error") return line;
    if (verdict === "pass") shown.push(f);
  }
  const body = kept(shown);
  return check(body) === "pass" ? body : line;
}

/** `check-public-data.mjs text` with the installation's denylist, the same check that guards pushes (TECH-5914). */
export const publicDataCheck =
  (denylist: string | undefined, label: string, log: (line: string) => void = () => {}): PublicDataCheck | undefined =>
  denylist
    ? (text) => {
        const script = join(import.meta.dirname, "../../runner/container/check-public-data.mjs");
        const run = spawnSync(process.execPath, [script, "text", label], { input: text, env: { ...process.env, PUBLIC_DATA_DENYLIST: denylist } });
        if (run.status === 0) return "pass";
        if (run.status === 1) {
          log(`public-data check rejected ${label}`);
          return "fail";
        }
        log(`public-data check could not run for ${label}: ${run.error?.message ?? (run.signal ? `terminated by ${run.signal}` : `exit ${run.status ?? "unknown"}`)}`);
        return "error";
      }
    : undefined;

/**
 * Posts the audit's comment once per PR head: a comment this App already posted for the head is
 * returned, so a retry after a lost answer posts no second one. Visibility is read now; unreadable
 * counts as public, and so do changed files that cannot be read (no finding then qualifies).
 */
export async function postAuditComment(
  request: Request,
  a: Audit,
  context: { appId?: number; publicDataDenylist?: string; changedFiles: () => Promise<string[]>; log: (line: string) => void },
): ReturnType<Post> {
  const path = `/repos/${a.repo}/issues/${a.number}/comments`;
  const own = (c: z.infer<typeof issueComment>) => context.appId !== undefined && c.user?.type === "Bot" && c.performed_via_github_app?.id === context.appId;
  const existing = (await readAll((p) => request(p), path, issueComment)).find((c) => own(c) && LINE.exec(c.body?.split("\n", 1)[0] ?? "")?.[1] === a.headSha);
  if (existing) return { id: existing.id };
  const visibility = z.object({ visibility: z.enum(["public", "private", "internal"]) }).safeParse(await request(`/repos/${a.repo}`).catch(() => undefined));
  const isPublic = !visibility.success || visibility.data.visibility === "public";
  const changedFiles = isPublic ? await context.changedFiles().catch(() => []) : [];
  if (isPublic && !context.publicDataDenylist) context.log(`${a.repo}#${a.number}: public-data denylist is not configured; posting the fixed audit verdict only`);
  const body = auditComment(a, { public: isPublic, changedFiles, check: publicDataCheck(context.publicDataDenylist, "audit comment", context.log) });
  const created = issueComment.parse(await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }));
  return { id: created.id };
}

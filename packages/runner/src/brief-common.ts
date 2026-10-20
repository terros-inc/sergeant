import type { Conversation, HumanPullRequestFeedback, PullRequestFacts, PullRequestFeedback, ReviewReport } from "@terros/sergeant-contracts";
import { conversationRevision } from "@terros/sergeant-contracts";

// What the worker and reviewer briefs share (brief.ts): the Task section, humans' and bots' PR feedback,
// and an earlier review.

export function renderTask(c: Conversation): string {
  const comments = c.humanComments.length
    ? c.humanComments.map((m) => `### ${m.author.name} — ${m.createdAt}${m.updatedAt !== m.createdAt ? ` (edited ${m.updatedAt})` : ""}\n\n${m.body}`).join("\n\n")
    : "(no human comments)";
  return `${c.issue.identifier} — ${c.issue.title}
${c.issue.url}
State: ${c.issue.state} · conversation revision: ${conversationRevision(c)}

### Description

${c.issue.description}

### Human comments, oldest first

${comments}`;
}

/** One human review or comment on a PR, for a successor or reviewer that must check it (TECH-4987). */
export function renderHumanFeedback(f: HumanPullRequestFeedback): string {
  return renderFeedback(f);
}

/**
 * One bot review or comment on a PR (TECH-6166), led by its id so a reply in its thread, which names
 * the comment it answers, can be matched to it.
 */
export function renderBotFeedback(f: PullRequestFeedback): string {
  return renderFeedback(f).replace(/^ {4}- /, `    - [${f.id}] `);
}

function renderFeedback(f: PullRequestFeedback): string {
  const what =
    f.kind === "review"
      ? `review, ${f.state}${f.commitId ? ` at \`${f.commitId.slice(0, 12)}\`` : ""}`
      : f.kind === "review_comment"
        ? `inline comment on \`${f.path}${f.line !== null ? `:${f.line}` : ""}\``
        : "comment";
  const body = f.body.trim() ? `\n${f.body.trim().replace(/^/gm, "      > ")}` : "";
  const reply = f.inReplyTo ? ` — reply to ${f.inReplyTo}` : "";
  return `    - ${f.author} — ${what}${reply} — ${f.updatedAt} — ${f.url}${body}`;
}

/** How many characters of human PR feedback a brief carries inline, all its PRs together (05 §2). */
export const HUMAN_FEEDBACK_BOUND = 48 * 1024;
/** How many characters of bot PR feedback a brief carries inline, all its PRs together (TECH-6166). */
export const BOT_FEEDBACK_BOUND = 24 * 1024;
/** How much of a cut item's first line stays inline. */
const EXCERPT = 120;

type Rendering = { items: (p: PullRequestFacts) => PullRequestFeedback[]; render: (f: PullRequestFeedback) => string; bound: number };
const human: Rendering = { items: (p) => p.humanFeedback, render: renderHumanFeedback, bound: HUMAN_FEEDBACK_BOUND };
const bots: Rendering = { items: (p) => p.botFeedback ?? [], render: renderBotFeedback, bound: BOT_FEEDBACK_BOUND };

/**
 * Each PR's human feedback as brief lines, oldest first ("" for a PR with none), within
 * `HUMAN_FEEDBACK_BOUND` characters across all the PRs (TECH-5022). Under the bound every item renders
 * whole. Over it, the newest items stay whole, the next older one keeps as much of its body as fits,
 * and every older one keeps its header and the start of its first line. A cut item says so and links
 * to its full text. Headers are never dropped, so hundreds of items can still exceed the bound.
 */
export function renderBoundedHumanFeedback(pullRequests: PullRequestFacts[]): string[] {
  return renderBounded(pullRequests, human);
}

/** Each PR's bot feedback the same way, within `BOT_FEEDBACK_BOUND` (TECH-6166). */
export function renderBoundedBotFeedback(pullRequests: PullRequestFacts[]): string[] {
  return renderBounded(pullRequests, bots);
}

function renderBounded(pullRequests: PullRequestFacts[], how: Rendering): string[] {
  const { items, render, bound } = how;
  const whole = pullRequests.map((p) => items(p).map(render));
  const size = (rows: string[][]) => rows.flat().reduce((n, item) => n + item.length + 1, 0);
  if (size(whole) <= bound) return whole.map((rows) => rows.join("\n"));
  const rendered = pullRequests.map((p) => items(p).map((f) => renderCut(f, excerptLength(f), how)));
  const newestFirst = pullRequests
    .flatMap((p, i) => items(p).map((f, j) => ({ f, i, j })))
    .sort((a, b) => b.f.createdAt.localeCompare(a.f.createdAt));
  let left = bound - size(rendered);
  for (const { f, i, j } of newestFirst) {
    const short = rendered[i]![j]!;
    const grow = whole[i]![j]!.length - short.length;
    if (grow <= left) {
      rendered[i]![j] = whole[i]![j]!;
      left -= grow;
      continue;
    }
    // Keep as much of this body as fits; quoting makes the rendered text longer than the body kept.
    const fits = short.length + left;
    let keep = excerptLength(f) + left;
    while (keep > excerptLength(f) && renderCut(f, keep, how).length > fits) keep -= renderCut(f, keep, how).length - fits;
    if (keep > excerptLength(f)) rendered[i]![j] = renderCut(f, keep, how);
    break;
  }
  return rendered.map((rows) => rows.join("\n"));
}

function excerptLength(f: PullRequestFeedback): number {
  const body = f.body.trim();
  const firstLine = body.indexOf("\n");
  return Math.min(firstLine < 0 ? body.length : firstLine, EXCERPT);
}

/** `f` with only the first `keep` characters of its body, and a note of the cut; whole if nothing is cut. */
function renderCut(f: PullRequestFeedback, keep: number, { render, bound }: Rendering): string {
  const body = f.body.trim();
  const kept = body.slice(0, keep).trimEnd();
  if (kept.length === body.length) return render(f);
  const note = `[… ${body.length - kept.length} more characters cut to keep this brief's PR feedback within ${bound / 1024} KB; the full text is at ${f.url}]`;
  return render({ ...f, body: kept ? `${kept}\n${note}` : note });
}

/** A review's verdict and findings, for any later run that must act on them or recheck them. */
export function renderReview(report: ReviewReport): string {
  const heads = report.reviewed.map((h) => `${h.repo}#${h.number} at \`${h.headSha}\``).join(", ");
  const findings = report.findings.map(
    (f) => `- [${f.severity}${f.category ? `, ${f.category}` : ""}] ${f.id}${f.location ? ` (${f.location})` : ""}: ${f.description}`,
  );
  return `Verdict **${report.verdict}** on ${heads}. ${report.summary}\n\nFindings:\n${findings.join("\n") || "- (none)"}`;
}

/**
 * TECH-6194: how a run reads the enrolled repositories beyond its own checkout, with the read-only
 * token it gets as `GH_READ_TOKEN`, so it can follow an issue's reference to another repository or PR.
 */
export function renderReadAccess(enrolled: readonly string[]): string {
  return `- **Reading other repositories and PRs:** \`GH_READ_TOKEN\` is a read-only token (contents, pull
  requests, metadata) for every repository enrolled with Sergeant, valid for about an hour from the
  start of this run:
${enrolled.length ? enrolled.map((r) => `  - ${r}`).join("\n") : "  - (none)"}
  Use it to read a file in another of them or another PR, in any of them including your own, for example
  \`GH_TOKEN="$GH_READ_TOKEN" gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<name>/contents/<path>?ref=<ref>"\`,
  \`GH_TOKEN="$GH_READ_TOKEN" gh pr view <number> -R <owner>/<name> --comments\` (or \`gh pr diff\`), or
  \`GH_TOKEN="$GH_READ_TOKEN" git clone https://github.com/<owner>/<name>.git /tmp/<name>\`. It cannot
  write anything, and GitHub refuses it for any repository not listed here.
  Nothing else is checked out in this workspace, so code, a file, a PR, a branch, or the current
  default-branch source of a listed repository that the issue, a PR, or a claim refers to is never
  "not provided": read it with this token. When a read still fails, its reason says what would fix it:
  a repository not listed here is not enrolled with Sergeant (a human can enroll it); a 401 means the
  token was refused or has expired; a 404 for a listed repository means that path, ref, or PR does not
  exist.`;
}

import type { Conversation, HumanPullRequestFeedback, PullRequestFacts, ReviewReport } from "@terros/sergeant-contracts";
import { conversationRevision } from "@terros/sergeant-contracts";

// What the worker and reviewer briefs share (brief.ts): the Task section, a human's PR feedback, and an
// earlier review.

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
  const what =
    f.kind === "review"
      ? `review, ${f.state}${f.commitId ? ` at \`${f.commitId.slice(0, 12)}\`` : ""}`
      : f.kind === "review_comment"
        ? `inline comment on \`${f.path}${f.line !== null ? `:${f.line}` : ""}\``
        : "comment";
  const body = f.body.trim() ? `\n${f.body.trim().replace(/^/gm, "      > ")}` : "";
  return `    - ${f.author} — ${what} — ${f.updatedAt} — ${f.url}${body}`;
}

/** How many characters of human PR feedback a brief carries inline, all its PRs together (05 §2). */
export const HUMAN_FEEDBACK_BOUND = 48 * 1024;
/** How much of a cut item's first line stays inline. */
const EXCERPT = 120;

/**
 * Each PR's human feedback as brief lines, oldest first ("" for a PR with none), within
 * `HUMAN_FEEDBACK_BOUND` characters across all the PRs (TECH-5022). Under the bound every item renders
 * whole. Over it, the newest items stay whole, the next older one keeps as much of its body as fits,
 * and every older one keeps its header and the start of its first line. A cut item says so and links
 * to its full text. Headers are never dropped, so hundreds of items can still exceed the bound.
 */
export function renderBoundedHumanFeedback(pullRequests: PullRequestFacts[]): string[] {
  const whole = pullRequests.map((p) => p.humanFeedback.map(renderHumanFeedback));
  const size = (items: string[][]) => items.flat().reduce((n, item) => n + item.length + 1, 0);
  if (size(whole) <= HUMAN_FEEDBACK_BOUND) return whole.map((items) => items.join("\n"));
  const rendered = pullRequests.map((p) => p.humanFeedback.map((f) => renderCut(f, excerptLength(f))));
  const newestFirst = pullRequests
    .flatMap((p, i) => p.humanFeedback.map((f, j) => ({ f, i, j })))
    .sort((a, b) => b.f.createdAt.localeCompare(a.f.createdAt));
  let left = HUMAN_FEEDBACK_BOUND - size(rendered);
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
    while (keep > excerptLength(f) && renderCut(f, keep).length > fits) keep -= renderCut(f, keep).length - fits;
    if (keep > excerptLength(f)) rendered[i]![j] = renderCut(f, keep);
    break;
  }
  return rendered.map((items) => items.join("\n"));
}

function excerptLength(f: HumanPullRequestFeedback): number {
  const body = f.body.trim();
  const firstLine = body.indexOf("\n");
  return Math.min(firstLine < 0 ? body.length : firstLine, EXCERPT);
}

/** `f` with only the first `keep` characters of its body, and a note of the cut; whole if nothing is cut. */
function renderCut(f: HumanPullRequestFeedback, keep: number): string {
  const body = f.body.trim();
  const kept = body.slice(0, keep).trimEnd();
  if (kept.length === body.length) return renderHumanFeedback(f);
  const note = `[… ${body.length - kept.length} more characters cut to keep this brief's PR feedback within ${HUMAN_FEEDBACK_BOUND / 1024} KB; the full text is at ${f.url}]`;
  return renderHumanFeedback({ ...f, body: kept ? `${kept}\n${note}` : note });
}

/** A review's verdict and findings, for any later run that must act on them or recheck them. */
export function renderReview(report: ReviewReport): string {
  const heads = report.reviewed.map((h) => `${h.repo}#${h.number} at \`${h.headSha}\``).join(", ");
  const findings = report.findings.map(
    (f) => `- [${f.severity}${f.category ? `, ${f.category}` : ""}] ${f.id}${f.location ? ` (${f.location})` : ""}: ${f.description}`,
  );
  return `Verdict **${report.verdict}** on ${heads}. ${report.summary}\n\nFindings:\n${findings.join("\n") || "- (none)"}`;
}

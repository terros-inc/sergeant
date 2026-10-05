import type { Conversation, HumanPullRequestFeedback, ReviewReport } from "@terros/sergeant-contracts";
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

/** A review's verdict and findings, for any later run that must act on them or recheck them. */
export function renderReview(report: ReviewReport): string {
  const heads = report.reviewed.map((h) => `${h.repo}#${h.number} at \`${h.headSha}\``).join(", ");
  const findings = report.findings.map(
    (f) => `- [${f.severity}${f.category ? `, ${f.category}` : ""}] ${f.id}${f.location ? ` (${f.location})` : ""}: ${f.description}`,
  );
  return `Verdict **${report.verdict}** on ${heads}. ${report.summary}\n\nFindings:\n${findings.join("\n") || "- (none)"}`;
}

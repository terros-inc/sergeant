import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { GitHubPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { issueComment, readAll } from "./pr-feedback.ts";
import { graphqlErrors, pullRequestReviewers } from "./schemas.ts";

type Request = (path: string, init?: RequestInit, options?: { allowStatuses?: number[] }) => Promise<unknown>;
type Declare = NonNullable<GitHubPort["declareReadiness"]>;
const MINIMIZE = "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }";
const lineFor = (sha: string) => `READY TO MERGE | SHA: ${sha}`;
const summaryHead = (body: string) => body.match(/^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$/m)?.[1];
const legacySummary = (body: string) => body.startsWith("**Ready for a human to merge**");
const FALLBACK_REASON = "Reason recorded in Sergeant's task record";

function redactModelText(body: string): string {
  const reasonStart = body.indexOf("Reason: ");
  const evidenceMarker = "\n\nEvidence on this head:";
  const evidenceStart = reasonStart < 0 ? -1 : body.indexOf(evidenceMarker, reasonStart);
  const redacted = reasonStart < 0 || evidenceStart < 0
    ? body
    : `${body.slice(0, reasonStart)}Reason: ${FALLBACK_REASON}${body.slice(evidenceStart)}`;
  return redacted.split("\n").filter((line) => !line.startsWith("Suggested, not acted on:")).join("\n");
}

export async function declareReadiness(
  request: Request,
  req: Parameters<Declare>[0],
  context: { appId?: number; publicDataDenylist?: string; log: (line: string) => void },
): ReturnType<Declare> {
  const path = `/repos/${req.repo}/pulls/${req.number}`;
  const live = pullRequestReviewers.parse(await request(path));
  if (live.state !== "open") throw new Error(`${req.repo}#${req.number} is not open`);
  if (live.head.sha !== req.expectedHeadSha) throw new Error(`head moved: expected ${req.expectedHeadSha}, live ${live.head.sha}`);
  const comments = await readAll((p) => request(p), `/repos/${req.repo}/issues/${req.number}/comments`, issueComment);
  const own = comments.filter((comment) => context.appId !== undefined && comment.user?.type === "Bot" && comment.performed_via_github_app?.id === context.appId);
  const existing = own.find((comment) => comment.body?.split("\n", 1)[0] === lineFor(req.expectedHeadSha));
  if (existing) return { id: existing.id, url: existing.html_url };

  let body = req.comment;
  const visibility = z.object({ visibility: z.enum(["public", "private", "internal"]) }).safeParse(await request(`/repos/${req.repo}`));
  if (!visibility.success || visibility.data.visibility === "public") {
    const script = join(import.meta.dirname, "../../runner/container/check-public-data.mjs");
    const checked = context.publicDataDenylist
      ? spawnSync(process.execPath, [script, "text", "readiness text"], { input: req.modelText, env: { ...process.env, PUBLIC_DATA_DENYLIST: context.publicDataDenylist } })
      : undefined;
    if (!checked || checked.status !== 0) body = redactModelText(body);
  }
  const created = issueComment.parse(await request(`/repos/${req.repo}/issues/${req.number}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }));
  const confirmed = context.appId !== undefined && created.user?.type === "Bot" && created.performed_via_github_app?.id === context.appId;
  if (confirmed) {
    for (const comment of own.filter((candidate) => candidate.node_id && candidate.id !== created.id && (legacySummary(candidate.body ?? "") || (summaryHead(candidate.body ?? "") !== undefined && summaryHead(candidate.body ?? "") !== req.expectedHeadSha)))) {
      try {
        const answer = graphqlErrors.parse(await request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: MINIMIZE, variables: { id: comment.node_id } }) }));
        if (answer.errors?.length) throw new Error(answer.errors.map((error) => error.message).join("; "));
      } catch (error) {
        context.log(`${req.repo}#${req.number}: could not minimize outdated comment ${comment.html_url}: ${(error as Error).message}`);
      }
    }
  }
  return { id: created.id, url: created.html_url };
}

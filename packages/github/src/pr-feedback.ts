import { PullRequestFeedback } from "@terros/sergeant-contracts";
import { z } from "zod";

/** One authenticated GitHub GET, parsed as JSON. */
type Get = (path: string) => Promise<unknown>;

const user = z.object({ login: z.string().min(1), type: z.string() }).nullable();
const review = z.object({
  id: z.number().int(),
  user,
  state: z.string(),
  body: z.string().nullable(),
  commit_id: z.string().nullable(),
  submitted_at: z.string().nullish(),
  html_url: z.url(),
  author_association: z.string().optional(),
});
const reviewComment = z.object({
  id: z.number().int(),
  user,
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  in_reply_to_id: z.number().int().optional(),
  commit_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.url(),
  author_association: z.string().optional(),
});
export const issueComment = z.object({
  id: z.number().int(), user, body: z.string().nullable(), created_at: z.string(), updated_at: z.string(), html_url: z.url(),
  author_association: z.string().optional(),
  node_id: z.string().optional(),
  /** The GitHub App whose token posted the comment; null for one a person or Actions posted directly. */
  performed_via_github_app: z.object({ id: z.number().int() }).nullish(),
});
/** Pages of feedback read per list; more than this fails the read rather than hiding a review. */
const MAX_FEEDBACK_PAGES = 10;
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
/** A deleted account (`user: null`) shows as GitHub's `ghost`, a human; only an App's or bot account's is a bot. */
const authorOf = (u: z.infer<typeof user>) => (u === null ? { login: "ghost", bot: false } : { login: u.login, bot: u.type === "Bot" });
const iso = (at: string) => new Date(at).toISOString();
/** How much of one bot comment's body is kept: review bots can post pages per finding (TECH-6166). */
export const BOT_BODY_CHARS = 4_000;
const botBody = (body: string, url: string) =>
  body.length <= BOT_BODY_CHARS ? body : `${body.slice(0, BOT_BODY_CHARS)}\n[… ${body.length - BOT_BODY_CHARS} more characters; the full text is at ${url}]`;

/** Every page of a list endpoint, oldest first as GitHub lists them, up to `MAX_FEEDBACK_PAGES`. */
export async function readAll<T>(request: Get, path: string, item: z.ZodType<T>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_FEEDBACK_PAGES; page++) {
    const batch = z.array(item).parse(await request(`${path}?per_page=100&page=${page}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`more than ${MAX_FEEDBACK_PAGES * 100} items at ${path}`);
}

// Reviews, inline review comments, and conversation comments, split by who wrote them: a human's
// (TECH-4987) is direction; a bot's, Sergeant's own approval and the worker's replies included, is never
// human input, only findings and context (TECH-6166). A pending (unsubmitted) review is not feedback yet.
export async function readFeedback(request: Get, repo: string, number: number): Promise<{ human: PullRequestFeedback[]; bot: PullRequestFeedback[] }> {
  const [reviews, reviewComments, comments] = await Promise.all([
    readAll(request, `/repos/${repo}/pulls/${number}/reviews`, review),
    readAll(request, `/repos/${repo}/pulls/${number}/comments`, reviewComment),
    readAll(request, `/repos/${repo}/issues/${number}/comments`, issueComment),
  ]);
  const human: PullRequestFeedback[] = [];
  const bot: PullRequestFeedback[] = [];
  const add = (u: z.infer<typeof user>, f: Omit<PullRequestFeedback, "author">) => {
    const { login, bot: isBot } = authorOf(u);
    if (isBot) bot.push(PullRequestFeedback.parse({ ...f, author: login, body: botBody(f.body, f.url) }));
    else human.push(PullRequestFeedback.parse({ ...f, author: login }));
  };
  for (const r of reviews) {
    if (!r.submitted_at || !REVIEW_STATES.has(r.state)) continue;
    const at = iso(r.submitted_at);
    add(r.user, {
      id: `review:${r.id}`, kind: "review", state: r.state as PullRequestFeedback["state"], body: r.body ?? "", path: null, line: null,
      commitId: r.commit_id, createdAt: at, updatedAt: at, url: r.html_url, association: r.author_association,
    });
  }
  for (const c of reviewComments) {
    add(c.user, {
      id: `review_comment:${c.id}`, kind: "review_comment", state: null, body: c.body, path: c.path,
      line: c.line ?? c.original_line ?? null, commitId: c.commit_id, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), url: c.html_url, association: c.author_association,
      ...(c.in_reply_to_id !== undefined && { inReplyTo: `review_comment:${c.in_reply_to_id}` }),
    });
  }
  for (const c of comments) {
    add(c.user, {
      id: `comment:${c.id}`, kind: "comment", state: null, body: c.body ?? "", path: null, line: null,
      commitId: null, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), url: c.html_url, association: c.author_association,
    });
  }
  const byTime = (a: PullRequestFeedback, b: PullRequestFeedback) => a.createdAt.localeCompare(b.createdAt);
  return { human: human.sort(byTime), bot: bot.sort(byTime) };
}

/** Whether the PR's conversation already has a comment with exactly `body`, by anyone. */
export async function hasComment(request: Get, repo: string, number: number, body: string): Promise<boolean> {
  return (await readAll(request, `/repos/${repo}/issues/${number}/comments`, issueComment)).some((c) => c.body === body);
}

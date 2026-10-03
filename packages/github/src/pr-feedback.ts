import { HumanPullRequestFeedback } from "@terros/sergeant-contracts";
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
  commit_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.url(),
  author_association: z.string().optional(),
});
const issueComment = z.object({
  id: z.number().int(), user, body: z.string().nullable(), created_at: z.string(), updated_at: z.string(), html_url: z.url(),
  author_association: z.string().optional(),
});
/** Pages of feedback read per list; more than this fails the read rather than hiding a review. */
const MAX_FEEDBACK_PAGES = 10;
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
/** A deleted account (`user: null`) shows as GitHub's `ghost`; only an App's or bot account's is not human. */
const humanAuthor = (u: z.infer<typeof user>) => (u === null ? "ghost" : u.type === "Bot" ? null : u.login);
const iso = (at: string) => new Date(at).toISOString();

/** Every page of a list endpoint, oldest first as GitHub lists them, up to `MAX_FEEDBACK_PAGES`. */
async function readAll<T>(request: Get, path: string, item: z.ZodType<T>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_FEEDBACK_PAGES; page++) {
    const batch = z.array(item).parse(await request(`${path}?per_page=100&page=${page}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`more than ${MAX_FEEDBACK_PAGES * 100} items at ${path}`);
}

// Human reviews, inline review comments, and conversation comments (TECH-4987). A bot's, Sergeant's
// own approval included, is never human input. A pending (unsubmitted) review is not feedback yet.
export async function readHumanFeedback(request: Get, repo: string, number: number): Promise<HumanPullRequestFeedback[]> {
  const [reviews, reviewComments, comments] = await Promise.all([
    readAll(request, `/repos/${repo}/pulls/${number}/reviews`, review),
    readAll(request, `/repos/${repo}/pulls/${number}/comments`, reviewComment),
    readAll(request, `/repos/${repo}/issues/${number}/comments`, issueComment),
  ]);
  const feedback: HumanPullRequestFeedback[] = [];
  for (const r of reviews) {
    const author = humanAuthor(r.user);
    if (!author || !r.submitted_at || !REVIEW_STATES.has(r.state)) continue;
    const at = iso(r.submitted_at);
    feedback.push(HumanPullRequestFeedback.parse({
      id: `review:${r.id}`, kind: "review", author, state: r.state, body: r.body ?? "", path: null, line: null,
      commitId: r.commit_id, createdAt: at, updatedAt: at, url: r.html_url, association: r.author_association,
    }));
  }
  for (const c of reviewComments) {
    const author = humanAuthor(c.user);
    if (!author) continue;
    feedback.push(HumanPullRequestFeedback.parse({
      id: `review_comment:${c.id}`, kind: "review_comment", author, state: null, body: c.body, path: c.path,
      line: c.line ?? c.original_line ?? null, commitId: c.commit_id, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), url: c.html_url, association: c.author_association,
    }));
  }
  for (const c of comments) {
    const author = humanAuthor(c.user);
    if (!author) continue;
    feedback.push(HumanPullRequestFeedback.parse({
      id: `comment:${c.id}`, kind: "comment", author, state: null, body: c.body ?? "", path: null, line: null,
      commitId: null, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), url: c.html_url, association: c.author_association,
    }));
  }
  return feedback.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

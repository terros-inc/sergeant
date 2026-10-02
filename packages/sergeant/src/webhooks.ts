import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

// Linear and GitHub webhooks (TECH-4937, 11 §3): latency only. A verified event names the issue or
// PR it is about, and serve ends the wait of the task loop watching it, or runs an intake now; the
// loop then rereads Linear, GitHub, and its runs as it does every poll and takes a turn only if they
// changed. Nothing here reads a comment, decides anything, or touches Linear or GitHub, and nothing is
// recorded: a dropped, duplicated, or replayed delivery costs at most one extra reread, and the polls
// still find every change. The body is read only up to `MAX_BODY` and parsed only once its signature
// verifies; a Linear delivery whose signed `webhookTimestamp` is over `LINEAR_REPLAY_MS` from now is
// refused as a replay, as Linear advises. GitHub signs no timestamp, so a replay of one is bounded by
// the wake's rate cap (`Wake.nudge`) instead.

export const WEBHOOK_PATHS = { linear: "/webhooks/linear", github: "/webhooks/github" } as const;
const MAX_BODY = 1024 * 1024;
const LINEAR_REPLAY_MS = 60_000;

export type Nudge = {
  /** What a verified event names: Linear issue ids and identifiers, PRs, and heads, as `watchKey` spells them. */
  keys: string[];
  /** It may change which issues are delegated to the V2 agent. */
  intake: boolean;
};

/** How a task loop names what it watches, and an event what it is about; case-insensitive repos. */
export const watchKey = {
  pullRequest: (repo: string, number: number) => `${repo.toLowerCase()}#${number}`,
  head: (repo: string, sha: string) => `${repo.toLowerCase()}@${sha}`,
};

export type WebhookOptions = {
  /** Signing secrets; a source without one has no endpoint. */
  secrets: { linear?: string; github?: string };
  agentUserId: string;
  enrolledRepositories: string[];
  nudge: (nudge: Nudge) => void;
  log: (line: string) => void;
};

/** Handles `POST /webhooks/linear` and `POST /webhooks/github`. */
export function webhookHandler(opts: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const enrolled = new Set(opts.enrolledRepositories.map((r) => r.toLowerCase()));
  const handle = async (req: IncomingMessage): Promise<number> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const source = path === WEBHOOK_PATHS.linear ? "linear" : "github";
    const secret = opts.secrets[source];
    if (!secret) return 404;
    if (req.method !== "POST") return 405;
    const body = await readBody(req);
    if (!body) return 413;
    const signature = source === "linear" ? header(req, "linear-signature") : header(req, "x-hub-signature-256")?.replace(/^sha256=/, "");
    if (!verifySignature(secret, body, signature)) {
      opts.log(`${source} webhook refused: bad signature`);
      return 401;
    }
    const payload: unknown = JSON.parse(body.toString("utf8"));
    if (source === "linear" && !fresh(payload)) {
      opts.log("linear webhook refused: missing or stale webhookTimestamp");
      return 401;
    }
    const nudge = source === "linear" ? linearNudge(payload, opts.agentUserId) : githubNudge(header(req, "x-github-event") ?? "", payload, enrolled);
    if (nudge) opts.nudge(nudge);
    // Linear counts anything but 200 as a failed delivery, and retries it.
    return 200;
  };
  return (req, res) => {
    handle(req).then(
      (status) => res.writeHead(status).end(),
      () => res.writeHead(400).end(),
    );
  };
}

/** HMAC-SHA256 of the raw body, hex, compared in constant time. */
export function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Whether a Linear payload's `webhookTimestamp` (epoch ms) is within `LINEAR_REPLAY_MS` of now. */
const fresh = (payload: unknown) => {
  const at = (payload as { webhookTimestamp?: unknown } | null)?.webhookTimestamp;
  return typeof at === "number" && Math.abs(Date.now() - at) <= LINEAR_REPLAY_MS;
};

/** The body, or undefined once it passes `MAX_BODY`. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const issueRef = z.object({ id: z.string().optional(), identifier: z.string().optional() });
const LinearEvent = z.object({
  type: z.string(),
  action: z.string().optional(),
  data: z
    .object({
      id: z.string().optional(),
      identifier: z.string().optional(),
      issueId: z.string().optional(),
      relatedIssueId: z.string().optional(),
      issue: issueRef.optional(),
      delegateId: z.string().nullish(),
    })
    .optional(),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
  agentSession: z.object({ issueId: z.string().optional(), issue: issueRef.optional() }).optional(),
});

/** Issue fields whose change can matter to a task; an update to only others (priority, sort order) is dropped. */
const ISSUE_FIELDS = ["delegateId", "stateId", "title", "description", "labelIds", "archivedAt"];

/**
 * The issue a Linear event is about, by id and identifier, for an issue change Sergeant could act on,
 * a comment, an attachment (a linked PR), a relation, or the V2 agent's session; anything else is
 * dropped. A change to delegation (to or from the V2 agent, or a new agent session) also runs an intake.
 */
export function linearNudge(payload: unknown, agentUserId: string): Nudge | undefined {
  const parsed = LinearEvent.safeParse(payload);
  if (!parsed.success) return undefined;
  const { type, data, updatedFrom, agentSession } = parsed.data;
  const ids = (...refs: (string | null | undefined)[]) => refs.filter((r): r is string => !!r);
  switch (type) {
    case "Issue": {
      if (!data) return undefined;
      const changed = updatedFrom ? ISSUE_FIELDS.filter((f) => f in updatedFrom) : ISSUE_FIELDS;
      if (changed.length === 0) return undefined;
      const delegation = changed.includes("delegateId") && (data.delegateId === agentUserId || updatedFrom?.delegateId === agentUserId);
      return { keys: ids(data.id, data.identifier), intake: delegation };
    }
    case "Comment":
    case "Attachment":
    case "IssueRelation":
      return data ? { keys: ids(data.issueId, data.issue?.id, data.issue?.identifier, data.relatedIssueId), intake: false } : undefined;
    case "AgentSessionEvent":
      return { keys: ids(agentSession?.issueId, agentSession?.issue?.id, agentSession?.issue?.identifier), intake: true };
    default:
      return undefined;
  }
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const prNumbers = z.array(z.object({ number: z.number().int() })).default([]);
const GitHubEvent = z.object({
  repository: z.object({ full_name: z.string() }),
  number: z.number().int().optional(),
  pull_request: z.object({ number: z.number().int(), head: z.object({ sha }).optional() }).optional(),
  check_run: z.object({ head_sha: sha, pull_requests: prNumbers }).optional(),
  check_suite: z.object({ head_sha: sha, pull_requests: prNumbers }).optional(),
  sha: sha.optional(),
  before: sha.optional(),
  after: sha.optional(),
});
const GITHUB_EVENTS = new Set(["pull_request", "pull_request_review", "check_run", "check_suite", "status", "push"]);

/**
 * The PRs and heads a GitHub event in an enrolled repository is about. A push names the head it moved
 * from, which is what the owning loop last read. Other events and other repositories are dropped.
 */
export function githubNudge(event: string, payload: unknown, enrolled: Set<string>): Nudge | undefined {
  if (!GITHUB_EVENTS.has(event)) return undefined;
  const parsed = GitHubEvent.safeParse(payload);
  if (!parsed.success) return undefined;
  const e = parsed.data;
  const repo = e.repository.full_name;
  if (!enrolled.has(repo.toLowerCase())) return undefined;
  const check = e.check_run ?? e.check_suite;
  const numbers = [e.number, e.pull_request?.number, ...(check?.pull_requests.map((p) => p.number) ?? [])];
  const heads = [e.pull_request?.head?.sha, check?.head_sha, e.sha, e.before, e.after];
  return {
    keys: [
      ...new Set([
        ...numbers.flatMap((n) => (n === undefined ? [] : [watchKey.pullRequest(repo, n)])),
        ...heads.flatMap((s) => (s === undefined ? [] : [watchKey.head(repo, s)])),
      ]),
    ],
    intake: false,
  };
}

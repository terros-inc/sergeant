import { hasClosingReference } from "@terros/sergeant-contracts";
import type { z } from "zod";
import { pullRequestCommits, pullRequestText } from "./schemas.ts";

// Sergeant writes every squash commit message itself (TECH-5085), in every enrolled repository its
// own included: GitHub's default copies each branch commit's message, so an agent's `Co-authored-by`
// trailer, from a `--no-verify` or an API commit that no hook saw, would make the agent a contributor.

/**
 * Commit addresses AI agents write as: Claude Code, Codex, Cursor's agent, Aider. An agent is told
 * by its identity, never its name, so a human called Claude or Devin stays a co-author.
 */
const AGENT_EMAILS = new Set(["noreply@anthropic.com", "codex@openai.com", "noreply@openai.com", "cursoragent@cursor.com", "noreply@aider.chat"]);
/** GitHub accounts that are agents without a `[bot]` suffix: the Copilot coding agent. */
const AGENT_LOGINS = new Set(["copilot"]);
/** `<id>+<login>@users.noreply.github.com`, GitHub's address for an account, an App's bot included. */
const GITHUB_NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;
const CO_AUTHOR = /^\s*co-authored-by:\s*(.+?)\s*$/i;

const emailOf = (coAuthor: string) => /<([^>]*)>/.exec(coAuthor)?.[1]?.trim().toLowerCase();
const isAgentLogin = (login: string) => login.toLowerCase().endsWith("[bot]") || AGENT_LOGINS.has(login.toLowerCase());

/**
 * Whether an identity is an AI agent or a bot: a known agent address, a GitHub App's `[bot]` account
 * (the worker App included), or a known agent account. Sergeant's runners commit as the
 * installation's human `gitIdentity`, which stays a co-author.
 */
export function isAgentIdentity(who: { email?: string; login?: string }): boolean {
  if (who.login !== undefined && isAgentLogin(who.login)) return true;
  const email = who.email?.toLowerCase();
  if (email === undefined) return false;
  const noreplyLogin = GITHUB_NOREPLY.exec(email)?.[1];
  return AGENT_EMAILS.has(email) || (noreplyLogin !== undefined && isAgentLogin(noreplyLogin));
}

/** One branch commit as the squash message needs it: its message, and its author unless that is the PR's author. */
export type SquashCommit = { message: string; author?: { name: string; email: string; login?: string } };

export type SquashMessageInput = {
  number: number;
  title: string;
  body: string;
  /** The Linear issue the PR belongs to, `TECH-5085`. */
  issueIdentifier: string;
  /** Whether merging this PR completes the issue, as the worker reported it (the one Gate M9 checks). */
  closesIssue: boolean;
  /** The plain transparency line, `Built by Sergeant (worker: Claude, review: Codex)`. */
  builtBy: string;
  commits: SquashCommit[];
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites a closing magic word (GitHub's or Linear's) aimed at the issue into `Part of`, so a PR
 * that does not complete the issue cannot close it from its title or body: `Fixes TECH-9`,
 * `closes: [TECH-9](url)`, `Resolved **TECH-9**`, `fixes <linear URL>`, `Fixes TECH-8, TECH-9`.
 */
export function neutralizeClosing(text: string, issueIdentifier: string): string {
  const id = escape(issueIdentifier);
  const word = /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|complet(?:e[sd]?|ing))\b/.source;
  const target = `(?=[\\s:*_\\[(<]*(?:[A-Za-z]+-\\d+[\\]),\\s*_]+(?:and\\s+)?[\\[(<]*)*(?:\\S*/)?${id}\\b)`;
  return text.replace(new RegExp(word + target, "gi"), (found) => (found[0] === found[0]?.toUpperCase() ? "Part of" : "part of"));
}

/**
 * The squash commit's title and message: the PR title, its body, `Fixes <issue>` for a PR that
 * completes the issue or `Part of <issue>` for one that does not (never a closing word then), the
 * transparency line, and a trailer block with the body's human co-authors and, as GitHub's default
 * would, each human who authored or co-authored a branch commit. Nothing else from the branch
 * commits is copied, so no agent trailer they carry can reach the message.
 */
export function squashMessage(input: SquashMessageInput): { commit_title: string; commit_message: string } {
  const id = input.issueIdentifier;
  const relate = (text: string) => (input.closesIssue ? text : neutralizeClosing(text, id));
  const lines = input.body.replace(/\r\n/g, "\n").split("\n");
  const body = relate(lines.filter((line) => !CO_AUTHOR.test(line)).join("\n")).trim();
  const coAuthors: string[] = [];
  const seen = new Set<string>();
  const add = (who: string, login?: string) => {
    const email = emailOf(who);
    if (isAgentIdentity({ ...(email !== undefined && { email }), ...(login !== undefined && { login }) })) return;
    const key = email ?? who.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    coAuthors.push(`Co-authored-by: ${who}`);
  };
  // The body's human co-author lines move, as written, into the trailer block, where GitHub reads them.
  for (const line of lines) {
    const who = CO_AUTHOR.exec(line)?.[1];
    if (who !== undefined) add(who);
  }
  for (const commit of input.commits) {
    if (commit.author) add(`${commit.author.name} <${commit.author.email}>`, commit.author.login);
    for (const line of commit.message.split("\n")) {
      const who = CO_AUTHOR.exec(line)?.[1];
      if (who !== undefined) add(who);
    }
  }
  const relation = input.closesIssue
    ? hasClosingReference(body, id) ? "" : `Fixes ${id}`
    : new RegExp(`\\bpart of\\b[\\s:*_\\[(<]*(?:\\S*/)?${escape(id)}\\b`, "i").test(body) ? "" : `Part of ${id}`;
  const paragraphs = [body, relation, input.builtBy, coAuthors.join("\n")];
  return {
    commit_title: `${relate(input.title.trim())} (#${input.number})`,
    commit_message: `${paragraphs.filter((p) => p !== "").join("\n\n")}\n`,
  };
}

/** Reads the PR's title, body, author and commits (GitHub lists at most 250), and writes its squash message. */
export async function readSquashMessage(
  request: (path: string) => Promise<unknown>,
  repo: string,
  number: number,
  squash: Pick<SquashMessageInput, "issueIdentifier" | "closesIssue" | "builtBy">,
) {
  const live = pullRequestText.parse(await request(`/repos/${repo}/pulls/${number}`));
  const commits: z.infer<typeof pullRequestCommits> = [];
  for (let page = 1; page <= 3; page++) {
    const batch = pullRequestCommits.parse(await request(`/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`));
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return squashMessage({
    number,
    title: live.title,
    body: live.body ?? "",
    ...squash,
    // The squash commit is the PR author's, so only another author is a co-author, as in GitHub's default.
    commits: commits.map((c) => ({
      message: c.commit.message,
      ...(c.author?.login !== live.user.login && c.commit.author && { author: { ...c.commit.author, ...(c.author && { login: c.author.login }) } }),
    })),
  });
}

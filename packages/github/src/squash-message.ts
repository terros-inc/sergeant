// Sergeant writes every squash commit message itself (TECH-5085), in every enrolled repository its
// own included: GitHub's default copies each branch commit's message, so an agent's `Co-authored-by`
// trailer, from a `--no-verify` or an API commit that no hook saw, would make the agent a contributor.

/** An AI agent named in a co-author line: Codex, Claude, or a similar coding agent or its vendor. */
const AGENT = /\b(codex|claude|anthropic|openai|chatgpt|copilot|gemini|cursor|devin)\b/i;
const CO_AUTHOR = /^\s*co-authored-by:\s*(.+?)\s*$/i;

/** One branch commit as the squash message needs it: its message, and its author unless that is the PR's author. */
export type SquashCommit = { message: string; author?: { name: string; email: string } };

export type SquashMessageInput = {
  number: number;
  title: string;
  body: string;
  /** The Linear issue the PR closes, `TECH-5085`. */
  issueIdentifier: string;
  /** The plain transparency line, `Built by Sergeant (worker: Claude, review: Codex)`. */
  builtBy: string;
  commits: SquashCommit[];
};

/** Drops every `Co-authored-by:` line that names an AI agent; a human's stays as written. */
export function stripAgentCoAuthors(text: string): string {
  return text
    .split("\n")
    .filter((line) => !(CO_AUTHOR.test(line) && AGENT.test(line)))
    .join("\n");
}

const emailOf = (coAuthor: string) => /<([^>]+)>/.exec(coAuthor)?.[1]?.toLowerCase() ?? coAuthor.toLowerCase();

/**
 * The squash commit's title and message: the PR title, its body, `Fixes <issue>` unless the body
 * already says how it relates to the issue, the transparency line, and, as GitHub's default would,
 * a `Co-authored-by` trailer for each human who authored or co-authored a branch commit. Nothing
 * else from the branch commits is copied, so no agent trailer they carry can reach the message.
 */
export function squashMessage(input: SquashMessageInput): { commit_title: string; commit_message: string } {
  const body = stripAgentCoAuthors(input.body.replace(/\r\n/g, "\n")).trim();
  const id = input.issueIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const relates = new RegExp(`^\\s*(fix(es|ed)?|close[sd]?|resolve[sd]?|part of)\\s+${id}\\b`, "im").test(body);
  const seen = new Set(
    body
      .split("\n")
      .map((line) => CO_AUTHOR.exec(line)?.[1])
      .filter((who): who is string => who !== undefined)
      .map(emailOf),
  );
  const coAuthors: string[] = [];
  for (const commit of input.commits) {
    const named = commit.message.split("\n").flatMap((line) => CO_AUTHOR.exec(line)?.[1] ?? []);
    for (const who of [...(commit.author ? [`${commit.author.name} <${commit.author.email}>`] : []), ...named]) {
      if (AGENT.test(who) || seen.has(emailOf(who))) continue;
      seen.add(emailOf(who));
      coAuthors.push(`Co-authored-by: ${who}`);
    }
  }
  const paragraphs = [body, relates ? "" : `Fixes ${input.issueIdentifier}`, input.builtBy, coAuthors.join("\n")];
  return {
    commit_title: `${input.title.trim()} (#${input.number})`,
    commit_message: `${paragraphs.filter((p) => p !== "").join("\n\n")}\n`,
  };
}

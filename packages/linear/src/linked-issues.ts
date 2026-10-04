import type { Conversation, LinkedIssueBackground } from "@terros/sergeant-contracts";

export const MAX_LINKED_ISSUES = 10;

type LinkedIssue = {
  identifier: string;
  url: string;
  title: string;
  state: { name: string };
};

type ExplicitLink = { identifier: string; url: string };

/** Only links literally present in the task source, in first-seen order and in the same workspace. */
export function explicitLinkedIssues(conversation: Pick<Conversation, "issue" | "humanComments">): ExplicitLink[] {
  const own = new URL(conversation.issue.url);
  const ownWorkspace = own.pathname.split("/").filter(Boolean)[0];
  if (!ownWorkspace) return [];
  const links: ExplicitLink[] = [];
  const seen = new Set<string>([conversation.issue.identifier.toUpperCase()]);
  const texts = [conversation.issue.description, ...conversation.humanComments.map((comment) => comment.body)];
  const candidates = /https:\/\/linear\.app\/[^\s<>()[\]"'`]+/gi;

  for (const text of texts) {
    for (const match of text.matchAll(candidates)) {
      let url: URL;
      const matchedUrl = match[0].replace(/[.,;:!?]+$/, "");
      try {
        url = new URL(matchedUrl);
      } catch {
        continue;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const identifier = parts[1] === "issue" && /^[a-z][a-z0-9]*-\d+$/i.test(parts[2] ?? "") ? parts[2]!.toUpperCase() : undefined;
      if (!identifier || parts[0] !== ownWorkspace || seen.has(identifier)) continue;
      seen.add(identifier);
      links.push({ identifier, url: matchedUrl });
      if (links.length === MAX_LINKED_ISSUES) return links;
    }
  }
  return links;
}

/** Fetch the bounded explicit set. Descriptions are never read, so no link inside one is followed. */
export async function readLinkedIssueBackground(
  conversation: Pick<Conversation, "issue" | "humanComments">,
  read: (identifier: string) => Promise<LinkedIssue>,
  log: (line: string) => void,
): Promise<LinkedIssueBackground[]> {
  const workspace = new URL(conversation.issue.url).pathname.split("/").filter(Boolean)[0];
  return Promise.all(
    explicitLinkedIssues(conversation).map(async (link): Promise<LinkedIssueBackground> => {
      try {
        const issue = await read(link.identifier);
        const issueWorkspace = new URL(issue.url).pathname.split("/").filter(Boolean)[0];
        if (issue.identifier.toUpperCase() !== link.identifier || issueWorkspace !== workspace) throw new Error("linked issue did not match the explicit same-workspace link");
        return { status: "read", identifier: issue.identifier, url: issue.url, title: issue.title, state: issue.state.name };
      } catch (error) {
        log(`could not read linked Linear issue ${link.identifier}: ${error instanceof Error ? error.message : String(error)}`);
        return {
          status: "unreadable",
          identifier: link.identifier,
          url: link.url,
          reason: "Linear could not read this linked issue; it may be unavailable, deleted, or outside the token's permissions.",
        };
      }
    }),
  );
}

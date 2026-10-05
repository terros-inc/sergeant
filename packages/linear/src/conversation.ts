import { Conversation, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { FollowupDeps } from "./followup.ts";
import { readLinkedIssueBackground } from "./linked-issues.ts";
import { issuePage, issueQuery, linkedIssue, linkedIssueQuery } from "./queries.ts";

const pullRequestUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

/**
 * The PRs Linear's GitHub integration attached to the issue: only `github`-sourced attachments, which
 * the integration creates for a real PR, never a plain link anyone could add. A missed attachment only
 * refuses a review or merge (G3, M2), so this fails closed.
 */
function linkedPullRequests(attachments: { url: string; sourceType: string | null }[]) {
  return attachments.flatMap(({ url, sourceType }) => {
    const match = sourceType === "github" ? pullRequestUrl.exec(url) : null;
    return match ? [{ repo: match[1], number: Number(match[2]) }] : [];
  });
}

/** The adapter's `readConversation`, split by author into human input and agent context. */
export function conversationReader({ request, sergeantUsers, log }: Omit<FollowupDeps, "createOnce">): LinearPort["readConversation"] {
  const readPage = async (issueId: string, after: string | null) => {
    const { issue } = await request(issueQuery, { id: issueId, after }, z.object({ issue: issuePage.nullable() }));
    if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
    return issue;
  };

  return async (issueId) => {
    let page = await readPage(issueId, null);
    const first = page;
    const comments = [...page.comments.nodes];
    while (page.comments.pageInfo.hasNextPage) {
      const cursor = page.comments.pageInfo.endCursor;
      if (!cursor) throw new Error("Linear returned hasNextPage without an endCursor");
      page = await readPage(issueId, cursor);
      comments.push(...page.comments.nodes);
    }

    // Bots, integrations, and Sergeant's own agents are context (`agentComments`), never human input.
    const humanAuthor = (item: (typeof comments)[number]) => {
      const author = item.botActor ? null : (item.user ?? item.externalUser);
      return author && !sergeantUsers.has(author.id) ? author : null;
    };
    const byTime = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    const humanComments = comments.flatMap((item) => {
      const author = humanAuthor(item);
      return author ? [{ id: item.id, author, createdAt: item.createdAt, updatedAt: item.updatedAt, body: item.body }] : [];
    });
    const agentComments = comments
      .filter((item) => !humanAuthor(item))
      .map(({ id, createdAt, body, parentId }) => ({ id, createdAt, body, ...(parentId && { parentId }) }));

    const conversation = Conversation.parse({
      issue: {
        id: first.id,
        identifier: first.identifier,
        url: first.url,
        title: first.title,
        description: first.description ?? "",
        state: first.state.name,
        stateType: first.state.type,
        delegate: first.delegate,
        assignee: first.assignee,
        linkedPullRequests: linkedPullRequests(first.attachments.nodes),
        // Only a human's: Sergeant's own, and an integration's with no creator, are not human input.
        attachments: first.attachments.nodes
          .filter((a) => a.creator && !sergeantUsers.has(a.creator.id))
          .map(({ id, title, sourceType, url, updatedAt }) => ({ id, title, source: sourceType, url, updatedAt })),
      },
      humanComments: humanComments.sort(byTime),
      agentComments: agentComments.sort(byTime),
    });
    const linkedIssueBackground = await readLinkedIssueBackground(
      conversation,
      async (id) => {
        const { issue } = await request(linkedIssueQuery, { id }, z.object({ issue: linkedIssue.nullable() }));
        if (!issue) throw new Error("issue not found");
        return issue;
      },
      log,
    );
    return Conversation.parse({ ...conversation, linkedIssueBackground });
  };
}

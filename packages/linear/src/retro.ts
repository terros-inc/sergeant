import { commentIdFor, FEEDBACK_LABEL, FEEDBACK_MARKER, type RetroFeedbackTask, type RetroFiledIssue } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { FollowupDeps } from "./followup.ts";
import { workflowState } from "./queries.ts";

// The retro's Linear reads and writes (TECH-5187). Linear is its only store: the latest retro document
// in the Sergeant project is when the last retro ran and what it recommended.

/** Starts the title of every retro document; the newest one in the project is the last retro. */
export const RETRO_TITLE = "Sergeant retro";
/** A retro document's whole title, `Sergeant retro YYYY-MM-DD`; a human's document that only starts the same is not one. */
const retroTitle = new RegExp(`^${RETRO_TITLE} \\d{4}-\\d{2}-\\d{2}$`);

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const instant = z.iso.datetime({ offset: true });
export const filedIssue = z.object({ identifier: z.string(), title: z.string(), url: z.url(), createdAt: instant, state: z.object({ name: z.string(), type: z.string() }) });
const filedFields = "identifier title url createdAt state { name type }";

const retroDocuments = `
  query SergeantRetroDocuments($project: ID!, $title: String!, $after: String) {
    documents(first: 50, after: $after, filter: { project: { id: { eq: $project } }, title: { startsWith: $title } }) {
      nodes { id title content createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const retroDocumentsPage = z.object({
  documents: z.object({ nodes: z.array(z.object({ id: z.string(), title: z.string(), content: z.string().nullable(), createdAt: instant })), pageInfo }),
});
// The nested comments multiply the cost (queries.ts, TECH-5066): a comment costs about 2.3 points, so an issue
// with 50 comments about 118 and a page of 20 about 2,400 of the 10,000 points a query may cost. 50 issues
// with 100 comments each would have cost about 11,600, which Linear rejects.
const feedbackIssues = `
  query SergeantRetroFeedback($label: String!, $since: DateTimeOrDuration!, $after: String) {
    issues(first: 20, after: $after, filter: { labels: { some: { name: { eqIgnoreCase: $label } } }, updatedAt: { gt: $since } }) {
      nodes { identifier title url comments(first: 50, filter: { createdAt: { gt: $since } }) { nodes { body createdAt user { id } } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const feedbackPage = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        identifier: z.string(),
        title: z.string(),
        url: z.url(),
        comments: z.object({ nodes: z.array(z.object({ body: z.string(), createdAt: instant, user: z.object({ id: z.string() }).nullable() })) }),
      }),
    ),
    pageInfo,
  }),
});
const createdIssues = `
  query SergeantRetroFiled($creator: ID!, $since: DateTimeOrDuration!, $after: String) {
    issues(first: 100, after: $after, filter: { creator: { id: { eq: $creator } }, createdAt: { gt: $since } }) {
      nodes { ${filedFields} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const createdPage = z.object({ issues: z.object({ nodes: z.array(filedIssue), pageInfo }) });
export const oneIssue = `query SergeantRetroIssue($id: String!) { issue(id: $id) { ${filedFields} } }`;
export const teamStates = `query SergeantRetroTeam($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }`;
const createIssue = `
  mutation SergeantRetroIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { identifier url } }
  }
`;
const issueRef = z.object({ identifier: z.string().min(1), url: z.url() });
const createDocument = `
  mutation SergeantRetroDocument($input: DocumentCreateInput!) {
    documentCreate(input: $input) { success document { url } }
  }
`;
export const documentById = `query SergeantRetroDocumentById($id: String!) { document(id: $id) { url } }`;

export type RetroLinear = ReturnType<typeof retroLinear>;

/** The adapter's retro surface; `sergeantUsers` tells Sergeant's feedback comments from a human's quote of one. */
export function retroLinear({ request, createOnce, sergeantUsers }: Pick<FollowupDeps, "request" | "createOnce" | "sergeantUsers">) {
  /** Every node of a paged read. */
  async function paged<N>(page: (after: string | null) => Promise<{ nodes: N[]; pageInfo: z.infer<typeof pageInfo> }>): Promise<N[]> {
    const all: N[] = [];
    let after: string | null = null;
    do {
      const { nodes, pageInfo: info } = await page(after);
      all.push(...nodes);
      after = info.hasNextPage ? info.endCursor : null;
    } while (after);
    return all;
  }

  return {
    /** The project's newest retro document, or null before the first retro. */
    async lastRetro(projectId: string): Promise<{ title: string; content: string; createdAt: string } | null> {
      const docs = await paged(async (after) => (await request(retroDocuments, { project: projectId, title: RETRO_TITLE, after }, retroDocumentsPage)).documents);
      const last = docs.filter((d) => retroTitle.test(d.title)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return last ? { title: last.title, content: last.content ?? "", createdAt: last.createdAt } : null;
    },

    /** Tasks labelled `sergeant-feedback` with a Sergeant feedback comment posted after `since`. */
    async feedbackTasks(since: string): Promise<RetroFeedbackTask[]> {
      const issues = await paged(async (after) => (await request(feedbackIssues, { label: FEEDBACK_LABEL, since, after }, feedbackPage)).issues);
      return issues.flatMap((issue) => {
        const feedback = issue.comments.nodes
          .filter((c) => c.user && sergeantUsers.has(c.user.id) && c.body.startsWith(FEEDBACK_MARKER))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((c) => c.body);
        return feedback.length > 0 ? [{ identifier: issue.identifier, title: issue.title, url: issue.url, feedback }] : [];
      });
    },

    /** Issues `creatorId` (Sergeant's agent) created after `since`, with their state now. */
    async filedIssues(creatorId: string, since: string): Promise<RetroFiledIssue[]> {
      return paged(async (after) => (await request(createdIssues, { creator: creatorId, since, after }, createdPage)).issues);
    },

    /** These issues as they stand now; one Linear no longer has is left out. */
    async issues(identifiers: readonly string[]): Promise<RetroFiledIssue[]> {
      const found = await Promise.all(identifiers.map(async (id) => (await request(oneIssue, { id }, z.object({ issue: filedIssue.nullable() }))).issue));
      return found.filter((i) => i !== null);
    },

    /** Files a retro issue in the team's first Backlog state and the project, unassigned and not delegated, once per key. */
    async fileIssue(input: { teamId: string; projectId: string; title: string; description: string; key: string }): Promise<{ identifier: string; url: string }> {
      const { team } = await request(teamStates, { id: input.teamId }, z.object({ team: z.object({ states: z.object({ nodes: z.array(workflowState) }) }).nullable() }));
      const backlog = team?.states.nodes.filter((s) => s.type === "backlog").sort((a, b) => a.position - b.position)[0];
      if (!backlog) throw new Error(`Linear team ${input.teamId} has no backlog state for a retro issue`);
      const id = commentIdFor(input.key);
      return createOnce(
        async () => {
          const issue = { id, teamId: input.teamId, projectId: input.projectId, stateId: backlog.id, title: input.title, description: input.description };
          const { issueCreate } = await request(createIssue, { input: issue }, z.object({ issueCreate: z.object({ success: z.boolean(), issue: issueRef.nullable() }) }));
          if (!issueCreate.success || !issueCreate.issue) throw new Error("Linear issueCreate did not succeed");
          return issueCreate.issue;
        },
        async () => (await request(oneIssue, { id }, z.object({ issue: issueRef.nullable() }))).issue,
      );
    },

    /** Posts the retro as one document in the project, once per key. */
    async postDocument(input: { projectId: string; title: string; content: string; key: string }): Promise<{ url: string }> {
      const id = commentIdFor(input.key);
      const document = z.object({ url: z.url() });
      return createOnce(
        async () => {
          const { documentCreate } = await request(
            createDocument,
            { input: { id, projectId: input.projectId, title: input.title, content: input.content } },
            z.object({ documentCreate: z.object({ success: z.boolean(), document: document.nullable() }) }),
          );
          if (!documentCreate.success || !documentCreate.document) throw new Error("Linear documentCreate did not succeed");
          return documentCreate.document;
        },
        async () => (await request(documentById, { id }, z.object({ document: document.nullable() }))).document,
      );
    },
  };
}

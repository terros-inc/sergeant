import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";
import { MAX_LINKED_ISSUES } from "./linked-issues.ts";

const at = "2026-10-02T06:00:00.000Z";
const url = (identifier: string, workspace = "acme") => `https://linear.app/${workspace}/issue/${identifier}/title`;
const linked = (identifier: string) => ({ identifier, url: url(identifier), title: `Title ${identifier}`, state: { name: "Todo" } });
const root = (description: string, commentBodies: string[] = []) => ({
  data: {
    issue: {
      id: "issue-1",
      identifier: "TECH-1",
      url: url("TECH-1"),
      title: "Task",
      description,
      state: { name: "In Progress", type: "started" },
      delegate: null,
      assignee: null,
      attachments: { nodes: [] },
      comments: {
        nodes: commentBodies.map((body, index) => ({
          id: `comment-${index}`,
          body,
          createdAt: at,
          updatedAt: at,
          parentId: null,
          user: { id: "human", name: "Human" },
          externalUser: null,
          botActor: null,
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
});

test("reads only explicit same-workspace links from the task source, by identifier, title, state, and URL", async () => {
  const requested: string[] = [];
  const issues = new Map([
    ["TECH-2", linked("TECH-2")],
    ["TECH-4", linked("TECH-4")],
  ]);
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
    if (!request.query.includes("SergeantLinkedIssue")) {
      return Response.json(root(`Read ${url("TECH-2")}; ignore ${url("TECH-8", "other")}.`, [`Also ${url("TECH-4")}.`]));
    }
    requested.push(request.variables.id);
    return Response.json({ data: { issue: issues.get(request.variables.id) ?? null } });
  };

  const conversation = await createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch }).readConversation("TECH-1");

  expect(requested).toEqual(["TECH-2", "TECH-4"]);
  expect(conversation.linkedIssueBackground).toEqual([
    {
      status: "read",
      identifier: "TECH-2",
      url: url("TECH-2"),
      title: "Title TECH-2",
      state: "Todo",
    },
    {
      status: "read",
      identifier: "TECH-4",
      url: url("TECH-4"),
      title: "Title TECH-4",
      state: "Todo",
    },
  ]);
});

test("caps linked issue count, and retains an unreadable link without failing the conversation", async () => {
  const identifiers = Array.from({ length: MAX_LINKED_ISSUES + 1 }, (_, index) => `TECH-${index + 2}`);
  const requested: string[] = [];
  const logs: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
    if (!request.query.includes("SergeantLinkedIssue")) return Response.json(root(identifiers.map((id) => url(id)).join("\n")));
    requested.push(request.variables.id);
    if (request.variables.id === "TECH-3") return Response.json({ errors: [{ message: "forbidden" }] });
    return Response.json({ data: { issue: linked(request.variables.id) } });
  };

  const conversation = await createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch, log: (line) => logs.push(line) }).readConversation("TECH-1");

  expect(requested).toEqual(identifiers.slice(0, MAX_LINKED_ISSUES));
  expect(conversation.linkedIssueBackground).toHaveLength(MAX_LINKED_ISSUES);
  expect(conversation.linkedIssueBackground?.[1]).toMatchObject({ status: "unreadable", identifier: "TECH-3", reason: expect.stringContaining("could not read") });
  expect(logs).toEqual([expect.stringContaining("could not read linked Linear issue TECH-3")]);
});

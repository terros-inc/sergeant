import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

const at = (minute: number) => `2026-10-02T06:${String(minute).padStart(2, "0")}:00.000Z`;
const attachment = (id: string, url: string, sourceType: string | null) => ({
  id,
  title: id,
  url,
  sourceType,
  updatedAt: at(0),
  creator: { id: "human", name: "Human" },
});
const issue = (comments: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  data: {
    issue: {
      id: "issue-1",
      identifier: "UNF-1",
      url: "https://linear.app/unforgotten/issue/UNF-1",
      title: "Canary",
      description: null,
      state: { name: "Todo", type: "unstarted" },
      delegate: { id: "sergeant-user", name: "Sergeant" },
      assignee: { id: "user-ann", name: "Ann" },
      attachments: {
        nodes: [
          { ...attachment("a1", "https://github.com/o/canary/pull/7", "github"), creator: null },
          // Not the GitHub integration's PR link: a plain link anyone could add, and a linked issue.
          attachment("a2", "https://github.com/o/canary/pull/9", null),
          attachment("a3", "https://github.com/o/canary/issues/3", "github"),
          // Sergeant's own attachment is not human input (TECH-4994).
          { ...attachment("a4", "https://uploads.linear.app/o/x/own.png", "upload"), creator: { id: "sergeant-user", name: "Sergeant" } },
        ],
      },
      comments: { nodes: comments, pageInfo: { hasNextPage, endCursor } },
    },
  },
});
const authored = (id: string, createdAt: string, author: Record<string, unknown>) => ({
  id,
  body: id,
  createdAt,
  updatedAt: createdAt,
  user: null,
  externalUser: null,
  parentId: null,
  botActor: null,
  ...author,
});

// Missing a page or mistaking a bot for a human would make M10 hash the wrong conversation and
// could let a merge overtake human input. This exercises both boundaries in one request sequence,
// and that only the GitHub integration's PR attachments link a PR to the task (M2).
test("reads every page, separates human-authored comments from the rest, and links only integration PRs", async () => {
  const pages = [
    issue(
      [
        authored("human-2", at(2), { user: { id: "human", name: "Human" } }),
        authored("bot", at(1), { botActor: { id: "bot-1", type: "app", name: "Integration" } }),
      ],
      true,
      "cursor-1",
    ),
    issue(
      [
        authored("sergeant", at(3), { user: { id: "sergeant-user", name: "Sergeant" } }),
        authored("external-1", at(1), { externalUser: { id: "external", name: "Guest" } }),
      ],
      false,
      null,
    ),
  ];
  const requests: { variables: { after: string | null } }[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as { variables: { after: string | null } });
    return Response.json(pages.shift());
  };

  const conversation = await createLinearPort({ apiKey: "test", sergeantUserIds: ["sergeant-user"], fetch }).readConversation("UNF-1");

  expect(requests.map((r) => r.variables.after)).toEqual([null, "cursor-1"]);
  expect(conversation.issue).toMatchObject({ state: "Todo", stateType: "unstarted", delegate: { id: "sergeant-user" }, description: "" });
  expect(conversation.humanComments.map((c) => c.id)).toEqual(["external-1", "human-2"]);
  expect(conversation.agentComments.map((c) => c.id)).toEqual(["bot", "sergeant"]);
  expect(conversation.issue.linkedPullRequests).toEqual([{ repo: "o/canary", number: 7 }]);
  expect(conversation.issue.attachments?.map((a) => a.id)).toEqual(["a2", "a3"]);
});

// The outcome comment is posted once per merge. A retry after a lost response or a crash before the
// loop saved its state must not post a second comment, and must not hide a genuine failure either.
test("postComment uses one id per key and treats Linear's duplicate refusal as already posted", async () => {
  const sent: { query: string; variables: { input?: { id: string }; id?: string } }[] = [];
  const posted = new Set<string>();
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as (typeof sent)[number];
    sent.push(req);
    if (req.query.includes("commentCreate")) {
      const id = req.variables.input?.id ?? "";
      if (posted.has(id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      posted.add(id);
      return Response.json({ data: { commentCreate: { success: true } } });
    }
    const id = req.variables.id ?? "";
    return Response.json(posted.has(id) ? { data: { comment: { id } } } : { errors: [{ message: "Entity not found" }] });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });

  await linear.postComment({ issueId: "UNF-1", body: "outcome", key: "outcome:UNF-1:o/r#7" });
  await linear.postComment({ issueId: "UNF-1", body: "outcome", key: "outcome:UNF-1:o/r#7" });
  expect(posted.size).toBe(1);
  expect([...posted][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // A refusal for any other reason, with no comment under that id, still fails.
  const failing = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async (_i, init) =>
      Response.json(String(init?.body).includes("commentCreate") ? { errors: [{ message: "forbidden" }] } : { data: { comment: null } }),
  });
  await expect(failing.postComment({ issueId: "UNF-1", body: "x", key: "k" })).rejects.toThrow(/forbidden/);
});

const workflow = [
  { id: "s-triage", name: "Triage", type: "triage", position: 0 },
  // Two backlog-type states: the lower position wins, regardless of input order.
  { id: "s-icebox", name: "Icebox", type: "backlog", position: 2 },
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 1 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 3 },
  // Two started states: the lower position wins, regardless of input order.
  { id: "s-review", name: "In Review", type: "started", position: 5 },
  { id: "s-progress", name: "In Progress", type: "started", position: 4 },
  { id: "s-done", name: "Done", type: "completed", position: 6 },
];

// TECH-4947: the first worker starting must make the issue visibly In Progress, moving it to the
// team's first `started` state only from Todo, by position, and never backward.
test("moveIssueToStarted moves an unstarted issue to the first started state and is a no-op otherwise", async () => {
  const states = workflow;
  const updates: { id: string; stateId: string }[] = [];
  const portFor = (current: { name: string; type: string }) =>
    createLinearPort({
      apiKey: "test",
      sergeantUserIds: [],
      fetch: async (_i, init) => {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { id: string; stateId?: string } };
        if (query.includes("issueUpdate")) {
          updates.push({ id: variables.id, stateId: variables.stateId ?? "" });
          return Response.json({ data: { issueUpdate: { success: true } } });
        }
        return Response.json({ data: { issue: { state: current, team: { states: { nodes: states } } } } });
      },
    });

  // Todo moves forward to the lowest-position started state.
  expect(await portFor({ name: "Todo", type: "unstarted" }).moveIssueToStarted("UNF-1")).toEqual({ moved: true, from: "Todo", to: "In Progress" });
  expect(updates).toEqual([{ id: "UNF-1", stateId: "s-progress" }]);

  // Triage or Backlog (never moved forward, TECH-4989), or already started, completed, or canceled
  // (never moved backward): never touched.
  updates.length = 0;
  for (const current of [{ name: "Triage", type: "triage" }, { name: "Backlog", type: "backlog" }, { name: "In Progress", type: "started" }, { name: "Done", type: "completed" }, { name: "Canceled", type: "canceled" }]) {
    expect(await portFor(current).moveIssueToStarted("UNF-1")).toEqual({ moved: false });
  }
  expect(updates).toEqual([]);

  // A team with no started state leaves an unstarted issue where it is rather than failing.
  const noStarted = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async () => Response.json({ data: { issue: { state: { name: "Todo", type: "unstarted" }, team: { states: { nodes: states.filter((s) => s.type !== "started") } } } } }),
  });
  expect(await noStarted.moveIssueToStarted("UNF-1")).toEqual({ moved: false });
});

// TECH-5066: intake holds a Todo issue back only for its unfinished "blocked by" issues. Linear keeps
// "X blocked by Y" as Y's `blocks` relation, among X's inverse relations; any other relation, or a
// blocker completed or canceled, must not hold it back.
test("delegatedIssues lists each issue's unfinished blockers", async () => {
  const blocker = (type: string, identifier: string, stateType: string) => ({ type, issue: { identifier, state: { type: stateType } } });
  const linear = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async () =>
      Response.json({
        data: {
          issues: {
            nodes: [
              {
                identifier: "UNF-5",
                priority: 2,
                createdAt: at(0),
                state: { name: "Todo", type: "unstarted" },
                inverseRelations: {
                  nodes: [
                    blocker("blocks", "UNF-1", "started"),
                    blocker("blocks", "UNF-2", "unstarted"),
                    blocker("blocks", "UNF-3", "completed"),
                    blocker("blocks", "UNF-4", "canceled"),
                    blocker("related", "UNF-6", "started"),
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
  });
  expect(await linear.delegatedIssues("agent")).toEqual([
    { identifier: "UNF-5", priority: 2, createdAt: at(0), state: { name: "Todo", type: "unstarted" }, blockedBy: ["UNF-1", "UNF-2"] },
  ]);
});

// TECH-5066: only the first 20 inverse relations are read, so an issue with more must wait rather than
// start while an unread open blocker may hold it up.
test("delegatedIssues holds back an issue whose relations it could not read in full", async () => {
  const relations = Array.from({ length: 20 }, (_, i) => ({ type: "related", issue: { identifier: `UNF-${i + 10}`, state: { type: "started" } } }));
  const linear = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async () =>
      Response.json({
        data: {
          issues: {
            nodes: [
              {
                identifier: "UNF-5",
                priority: 2,
                createdAt: at(0),
                state: { name: "Todo", type: "unstarted" },
                inverseRelations: { nodes: relations, pageInfo: { hasNextPage: true } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
  });
  expect((await linear.delegatedIssues("agent"))[0]?.blockedBy).toEqual(["relations past the first 20, unread"]);
});

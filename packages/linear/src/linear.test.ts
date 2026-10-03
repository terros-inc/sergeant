import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

const at = (minute: number) => `2026-10-02T06:${String(minute).padStart(2, "0")}:00.000Z`;
const issue = (comments: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  data: {
    issue: {
      id: "issue-1",
      identifier: "UNF-1",
      url: "https://linear.app/unforgotten/issue/UNF-1",
      title: "Canary",
      description: null,
      state: { name: "Todo" },
      delegate: { id: "sergeant-user", name: "Sergeant" },
      attachments: {
        nodes: [
          { url: "https://github.com/o/canary/pull/7", sourceType: "github" },
          // Not the GitHub integration's PR link: a plain link anyone could add, and a linked issue.
          { url: "https://github.com/o/canary/pull/9", sourceType: null },
          { url: "https://github.com/o/canary/issues/3", sourceType: "github" },
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
  expect(conversation.issue).toMatchObject({ state: "Todo", delegate: { id: "sergeant-user" }, description: "" });
  expect(conversation.humanComments.map((c) => c.id)).toEqual(["external-1", "human-2"]);
  expect(conversation.agentComments.map((c) => c.id)).toEqual(["bot", "sergeant"]);
  expect(conversation.issue.linkedPullRequests).toEqual([{ repo: "o/canary", number: 7 }]);
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
// team's first `started` state only from an unstarted-like state, by position, and never backward.
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

  // Unstarted-like states move forward to the lowest-position started state.
  for (const type of ["triage", "backlog", "unstarted"]) {
    expect(await portFor({ name: type, type }).moveIssueToStarted("UNF-1")).toEqual({ moved: true, from: type, to: "In Progress" });
  }
  expect(updates).toEqual([
    { id: "UNF-1", stateId: "s-progress" },
    { id: "UNF-1", stateId: "s-progress" },
    { id: "UNF-1", stateId: "s-progress" },
  ]);

  // Already started, completed, or canceled: never touched, so never moved backward.
  updates.length = 0;
  for (const current of [{ name: "In Progress", type: "started" }, { name: "Done", type: "completed" }, { name: "Canceled", type: "canceled" }]) {
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

// UNF-729: a follow-up must never be filed twice, even when the process dies between Linear creating
// the issue and linking it, and it must land in the origin's team and project, delegated to nobody.
// This fake keeps Linear's one behavior the adapter relies on: a create under an existing id fails.
test("createFollowupIssue files one issue per key in the origin's team and project, and links it after a crash", async () => {
  type Req = { query: string; variables: { id?: string; input?: Record<string, unknown> & { id: string } } };
  const issues = new Map<string, Record<string, unknown>>();
  const relations = new Map<string, Record<string, unknown>>();
  let relationOutage = true;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as Req;
    const input = variables.input;
    if (query.includes("SergeantFollowupOrigin")) {
      return Response.json({ data: { issue: { id: "origin-1", assignee: { id: "owner" }, delegate: null, team: { id: "team-1", states: { nodes: workflow } }, project: { id: "project-1" } } } });
    }
    if (input && query.includes("issueCreate")) {
      if (issues.has(input.id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      issues.set(input.id, input);
      return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } });
    }
    if (query.includes("SergeantIssueById")) {
      return Response.json(issues.has(variables.id ?? "") ? { data: { issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } : { errors: [{ message: "Entity not found" }] });
    }
    if (input && query.includes("issueRelationCreate")) {
      if (relationOutage) return (relationOutage = false), new Response("unavailable", { status: 503 });
      if (relations.has(input.id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      relations.set(input.id, input);
      return Response.json({ data: { issueRelationCreate: { success: true } } });
    }
    const id = variables.id ?? "";
    return Response.json(relations.has(id) ? { data: { issueRelation: { id } } } : { errors: [{ message: "Entity not found" }] });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });
  const req = { originIssueId: "UNF-1", title: "Add jitter", description: "Review f1.", relation: "blocked_by", key: "followup:t1:retry-jitter" } as const;

  await expect(linear.createFollowupIssue(req)).rejects.toThrow(/503/);
  expect(await linear.createFollowupIssue(req)).toEqual({ identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" });
  expect(await linear.createFollowupIssue(req)).toMatchObject({ identifier: "UNF-2" });

  expect(issues.size).toBe(1);
  const [issueId, issue] = [...issues][0] ?? [];
  expect(issue).toEqual({ id: issueId, teamId: "team-1", projectId: "project-1", stateId: "s-backlog", assigneeId: "owner", title: "Add jitter", description: "Review f1." });
  // blocked_by: the origin blocks the follow-up.
  expect([...relations.values()]).toMatchObject([{ issueId: "origin-1", relatedIssueId: issueId, type: "blocks" }]);
});

// TECH-4998: a follow-up filed in Triage was auto-assigned to whoever was on the PagerDuty rotation.
// It must land in Backlog with the origin's owner: its assignee, else the human who delegated it to
// Sergeant, else nobody — never Sergeant itself.
test("createFollowupIssue files in Backlog, assigned to the origin's owner, and falls back to unassigned", async () => {
  const fileFor = async (origin: { assignee: { id: string } | null; delegate: { id: string } | null }, history: unknown[] = []) => {
    const created: Record<string, unknown>[] = [];
    const linear = createLinearPort({
      apiKey: "test",
      sergeantUserIds: ["sergeant-user"],
      fetch: async (_i, init) => {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { input?: Record<string, unknown> } };
        if (query.includes("SergeantFollowupOrigin")) {
          return Response.json({ data: { issue: { id: "origin-1", ...origin, team: { id: "team-1", states: { nodes: workflow } }, project: null } } });
        }
        if (query.includes("SergeantDelegationHistory")) return Response.json({ data: { issue: { history: { nodes: history } } } });
        if (query.includes("issueCreate")) {
          created.push(variables.input ?? {});
          return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } });
        }
        return Response.json({ data: { issueRelationCreate: { success: true } } });
      },
    });
    await linear.createFollowupIssue({ originIssueId: "UNF-1", title: "t", description: "d", relation: "related", key: "followup:t1:k" });
    return created[0];
  };
  const sergeant = { id: "sergeant-user" };
  const delegatedBy = (actor: { id: string } | null, minute: number) => ({ createdAt: at(minute), actor, toDelegate: sergeant });

  // Assigned to X: Backlog, assigned to X, even when someone else delegated it.
  expect(await fileFor({ assignee: { id: "x" }, delegate: sergeant }, [delegatedBy({ id: "d" }, 1)])).toMatchObject({ stateId: "s-backlog", assigneeId: "x" });
  // No assignee: the human whose delegation to Sergeant is the latest.
  const history = [delegatedBy({ id: "earlier" }, 1), delegatedBy({ id: "d" }, 3), { createdAt: at(4), actor: { id: "other" }, toDelegate: null }];
  expect(await fileFor({ assignee: null, delegate: sergeant }, history)).toMatchObject({ stateId: "s-backlog", assigneeId: "d" });
  // No assignee and no human delegator (none in history, an automation, or Sergeant itself): unassigned, still Backlog.
  for (const h of [[], [delegatedBy(null, 1)], [delegatedBy(sergeant, 1)]]) {
    const filed = await fileFor({ assignee: null, delegate: sergeant }, h);
    expect(filed).toMatchObject({ stateId: "s-backlog" });
    expect(filed).not.toHaveProperty("assigneeId");
  }
  expect(await fileFor({ assignee: null, delegate: null })).not.toHaveProperty("assigneeId");
});

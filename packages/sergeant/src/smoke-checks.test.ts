import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiClient } from "@terros/sergeant-contracts";
import { createGitHubPort, githubReadProbes } from "@terros/sergeant-github";
import { createLinearPort } from "@terros/sergeant-linear";
import { expect, test } from "vitest";
import { apiChecks, githubChecks, hostChecks, linearChecks, report, runChecks } from "./smoke-checks.ts";

// The smoke check runs against production after every deploy, so it must never write: these drive the
// real Linear and GitHub adapters (their queries and parsers) over a fake API that fails any mutation
// or non-GET call, and check one broken read fails only its own line and the overall result.

const repo = "terros-inc/sergeant";
const head = "a".repeat(40);
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const person = { id: "user-ann", name: "Ann" };

const linearAnswers: Record<string, unknown> = {
  SergeantDelegated: { issues: page([]) },
  SergeantCompleted: { issues: page([{ identifier: "TECH-1" }]) },
  SergeantFollowupByKey: { issues: { nodes: [] } },
  SergeantRetroDocuments: { documents: page([]) },
  SergeantRetroFeedback: { issues: page([]) },
  SergeantRetroFiled: { issues: page([]) },
  SergeantIssue: {
    issue: {
      id: "issue-1",
      identifier: "TECH-9",
      url: "https://linear.app/terros/issue/TECH-9",
      title: "Controlled issue",
      description: "Follows https://linear.app/terros/issue/TECH-8/earlier-work.",
      state: { name: "Todo", type: "unstarted" },
      delegate: { id: "agent", name: "Sergeant" },
      assignee: { ...person, url: "https://linear.app/terros/profiles/ann" },
      labels: { nodes: [] },
      attachments: { nodes: [] },
      comments: page([{ id: "c1", body: "Please do it.", createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", parentId: null, user: person, externalUser: null, botActor: null }]),
    },
  },
  SergeantDelegationHistory: { issue: { history: page([{ createdAt: "2026-10-06T00:00:00.000Z", actor: person, botActor: null, toDelegate: { id: "agent" }, fromDelegate: null }]) } },
  SergeantIssueOwnership: { issue: { id: "issue-1", createdAt: "2026-10-05T00:00:00.000Z", creator: person, botActor: null, assignee: { ...person, displayName: "ann" }, delegate: { id: "agent", name: "Sergeant" } } },
  SergeantIssueProgress: { issue: { state: { type: "unstarted" }, completedAt: null } },
  SergeantLinkedIssue: { issue: { identifier: "TECH-8", url: "https://linear.app/terros/issue/TECH-8/earlier-work", title: "Earlier work", state: { name: "Done" } } },
  SergeantViewer: { viewer: { id: "agent", name: "Sergeant", organization: { id: "org" } } },
  SergeantUsers: { users: { nodes: [{ id: "agent", name: "Sergeant" }] } },
  SergeantIssueLabels: { issue: { id: "issue-1", team: { id: "team-1" }, labels: { nodes: [{ id: "l1", name: "bug" }] } } },
  SergeantLabelsByName: { issueLabels: { nodes: [{ id: "l2", team: null }] } },
  SergeantBlockedIssue: { issue: { id: "issue-1", inverseRelations: { nodes: [{ type: "blocks", issue: { id: "issue-0" } }] } } },
  SergeantIssueId: { issue: { id: "issue-1" } },
  // Linear answers "not found" for an id nothing was created with; null is the same answer.
  SergeantBlockedByRelation: { issueRelation: null },
  SergeantIssueWorkflow: { issue: { state: { name: "Todo", type: "unstarted" }, team: { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 1 }] } } } },
  // Only the issue's comment exists; a lookup under the never-created id answers null.
  SergeantCommentById: (id: string) => ({ comment: id === "c1" ? { id } : null }),
  SergeantCommentThread: (id: string) => ({ comment: id === "c1" ? { id, parentId: null, resolvedAt: null, user: person } : null }),
  SergeantFollowupOrigin: { issue: { id: "issue-1", assignee: { id: "user-ann" }, delegate: { id: "agent" }, team: { id: "team-1", states: { nodes: [] } }, project: null } },
  SergeantIssueById: { issue: { identifier: "TECH-9", url: "https://linear.app/terros/issue/TECH-9" } },
  SergeantRetroIssue: { issue: { identifier: "TECH-9", title: "Controlled issue", url: "https://linear.app/terros/issue/TECH-9", createdAt: "2026-10-05T00:00:00.000Z", state: { name: "Todo", type: "unstarted" } } },
  SergeantRetroTeam: { team: { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 1 }] } } },
  SergeantRetroDocumentById: { document: null },
};
const notFound = new Set(["SergeantRelationById"]);
/** Every named read query in the Linear adapter's source. */
const linearSrc = fileURLToPath(new URL("../../linear/src/", import.meta.url));
const allReads = readdirSync(linearSrc)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .flatMap((f) => [...readFileSync(join(linearSrc, f), "utf8").matchAll(/query (Sergeant\w+)/g)].map((m) => m[1]!));

const pr = {
  number: 7,
  node_id: "PR_7",
  html_url: `https://github.com/${repo}/pull/7`,
  user: { login: "sergeant-worker[bot]" },
  title: "Add the thing",
  body: "Adds the thing.",
  state: "open",
  draft: false,
  merged_at: null,
  mergeable: true,
  mergeable_state: "clean",
  merge_commit_sha: null,
  head: { ref: "sergeant/tech-9-thing", sha: head, repo: { full_name: repo } },
  base: { ref: "main", sha: "b".repeat(40) },
  requested_reviewers: [{ login: "trevor" }],
  requested_teams: [],
};
const githubAnswer = (path: string): unknown => {
  if (path === `/repos/${repo}`) return { default_branch: "main" };
  if (path === `/repos/${repo}/branches/main`) return { commit: { sha: "c".repeat(40) } };
  if (path.endsWith("/pulls/7")) return pr;
  if (path.includes("/pulls?state=open")) return [{ number: 7 }];
  if (path.includes("/check-runs")) return { total_count: 1, check_runs: [{ name: "v2", status: "completed", conclusion: "success", app: { id: 15368 } }] };
  if (path.includes("/status")) return { state: "success", total_count: 0, statuses: [] };
  if (path.includes("/rules/branches/")) return [{ type: "required_status_checks", ruleset_id: 1, parameters: { required_status_checks: [{ context: "v2" }] } }];
  if (path.includes("/commits?")) return [{ commit: { message: "Add the thing\n\nCo-authored-by: Claude <noreply@anthropic.com>", author: { name: "Trevor", email: "trevor@terros.com" } }, author: { login: "trevor" } }];
  if (/\/(reviews|comments)\?/.test(path)) return [];
  return undefined;
};

function fakes(broken?: string) {
  const writes: string[] = [];
  const queried = new Set<string>();
  const linearFetch: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://uploads.linear.app/")) {
      if ((init?.method ?? "GET") !== "GET") writes.push(`${init?.method} ${String(url)}`);
      return new Response("png", { headers: { "content-type": "image/png" } });
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { id?: string } };
    if (!query.trim().startsWith("query")) writes.push(query);
    const name = /query (\w+)/.exec(query)?.[1] ?? "";
    queried.add(name);
    if (name === broken) return Response.json({ errors: [{ message: "outage" }] });
    if (notFound.has(name)) return Response.json({ errors: [{ message: "Entity not found: IssueRelation" }] });
    const answer = linearAnswers[name];
    return Response.json({ data: (typeof answer === "function" ? answer(variables.id) : answer) ?? null });
  };
  const githubFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    if ((init?.method ?? "GET") !== "GET") writes.push(`${init?.method} ${path}`);
    if (path.includes("/protection/")) return new Response(null, { status: 403 });
    const body = githubAnswer(path);
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: ["agent"], fetch: linearFetch, log: () => {} });
  const token = async () => "test";
  const port = createGitHubPort({ token, repositories: { [repo]: { mergeMethod: "squash", mergePolicy: "sergeant" } }, fetch: githubFetch });
  // Records which port methods the checks call, so the GitHub coverage test below sees a new one.
  const called = new Set<string>();
  const github = new Proxy(port, { get: (target, key: string) => (called.add(key), target[key as keyof typeof target]) });
  return { writes, queried, called, linear, github, githubPort: port, probes: githubReadProbes({ token, fetch: githubFetch }) };
}

const status = (version: string): typeof fetch => async () => Response.json({ ok: true, version, tasks: [] });

test("every check passes over the real adapters, and nothing is written", async () => {
  const f = fakes();
  const results = await runChecks([
    ...hostChecks({ statusUrl: "http://127.0.0.1:8080/status", localVersion: "2.0.90+abc1234", fetch: status("2.0.90+abc1234") }),
    ...linearChecks(f.linear, { agentUserId: "agent", issue: "TECH-9", retroProjectId: "project", upload: "https://uploads.linear.app/org/a/shot.png" }),
    ...githubChecks(f.github, f.probes, { repo, mergePolicy: "sergeant", pr: 7, issue: "TECH-9" }),
  ]);
  expect(f.writes).toEqual([]);
  expect(results.filter((r) => r.status !== "PASS")).toEqual([]);
  // The squash message is built as a merge would send it: the human commit author is a co-author, the agent's trailer is not.
  expect(results.find((r) => r.name.includes("squash"))?.detail).toEqual({ title: "Add the thing (#7)", coAuthors: ["Trevor <trevor@terros.com>"] });
  expect(results.find((r) => r.name === "linear task owner from delegation history")?.detail).toMatchObject({ owner: person });
  expect(results.find((r) => r.name.startsWith("linear upload"))?.detail).toEqual({ status: 200, contentType: "image/png", bytes: 3 });
  expect(results.find((r) => r.name.startsWith("linear blocked-by"))?.detail).toEqual({ blockedBy: 1, sameIssue: true, relation: "absent" });
  expect(results.find((r) => r.name.startsWith("linear follow-up and retro"))?.detail).toMatchObject({ issue: "TECH-9", teamStates: 1, relation: "absent", document: "absent" });
  expect(results.find((r) => r.name.includes("branch-delete"))?.detail).toEqual({ ref: "sergeant/tech-9-thing", openPullRequestsUsingIt: 0, branch: "deleted" });
  // Every named Linear read query the adapter has ran (SergeantCaller reads with a human's own token, at `sgt login`).
  expect([...f.queried].sort()).toEqual(allReads.filter((q) => q !== "SergeantCaller").sort());
  expect(results.find((r) => r.name.includes("default branch head"))?.detail).toEqual({ branch: "main", sha: "c".repeat(40) });
  // Every GitHub port method is a read a check calls, a write whose reads a probe covers, or local:
  // a new port method fails here until it gets a check or is classified.
  const readByProbe = { mergePullRequest: "squash message", handToHuman: "handoff read", closePullRequest: "handoff read", deletePullRequestBranch: "branch-delete read" };
  const local = ["mergePolicy", "rateLimit"];
  expect(Object.keys(f.githubPort).filter((m) => !f.called.has(m) && !(m in readByProbe) && !local.includes(m))).toEqual([]);
  expect([...f.called].sort()).toEqual(["defaultBranchHead", "readPullRequest"]);
  const { text, exitCode } = report(results, "header");
  expect(exitCode).toBe(0);
  expect(text.split("\n").at(-1)).toBe(`SMOKE PASS: ${results.length} passed, 0 failed, 0 skipped`);
});

test("a failed read, or a host on another version, fails its own line and the result; the rest still run", async () => {
  const f = fakes("SergeantCompleted");
  const results = await runChecks([
    ...hostChecks({ statusUrl: "http://127.0.0.1:8080/status", localVersion: "2.0.91+def5678", fetch: status("2.0.90+abc1234") }),
    ...linearChecks(f.linear, { agentUserId: "agent" }),
    ...githubChecks(f.github, f.probes, { repo, mergePolicy: "human" }),
  ]);
  expect(results.map((r) => `${r.status} ${r.name}`)).toEqual([
    "FAIL host serves this checkout's version",
    "PASS linear viewer and user names",
    "SKIP linear upload download (attachment reading)",
    "PASS linear delegated issues (intake)",
    "FAIL linear completed issues in the feedback lookback",
    "PASS linear follow-up lookup by key",
    "SKIP linear retro reads (documents, feedback, filed issues)",
    "SKIP linear issue conversation",
    "SKIP linear task owner from delegation history",
    "SKIP linear issue progress (close gate)",
    "SKIP linear issue labels and label by name (feedback label)",
    "SKIP linear blocked-by reads (relations, issue id, relation by id)",
    "SKIP linear issue workflow (state moves, close)",
    "SKIP linear comment thread and comment by id",
    "SKIP linear follow-up and retro issue reads (origin, issue, team states, relation and document by id)",
    `PASS github ${repo} default branch head (follow-up "Written against")`,
    `SKIP github ${repo} PR facts (mergeable state, human reviews, required checks)`,
    `SKIP github ${repo} squash message from PR text and commits`,
    `SKIP github ${repo} handoff read (draft, requested reviewers, posted comments)`,
    `SKIP github ${repo} branch-delete read (head, open PRs on the branch, branch tip)`,
  ]);
  expect(results[4]?.detail).toBe("Linear API error: outage");
  const { text, exitCode } = report(results, "header");
  expect(exitCode).toBe(1);
  expect(text).toContain("FAIL linear completed issues in the feedback lookback [TECH-5049]");
  expect(text.split("\n").at(-1)).toBe("SMOKE FAIL: 4 passed, 2 failed, 14 skipped");
});

test("the API check reads the run list and a run's view with its provider choice and account, as sent", async () => {
  const run = {
    runId: "run_1",
    role: "worker",
    status: "succeeded",
    provider: "codex",
    model: "gpt-5",
    report: null,
    providerChoice: { adapter: "codex-local", reason: "more weekly quota left", readings: [] },
    account: { id: "acct-1", group: "registered", holder: "Ann" },
  };
  const seen: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push(`${init?.method} ${new URL(String(input)).pathname} ${new Headers(init?.headers).get("authorization")}`);
    const path = new URL(String(input)).pathname;
    return Response.json(path === "/v1/runs" ? { runs: [{ runId: "run_1", task: "TECH-9", status: "succeeded" }] } : { task: "TECH-9", run });
  };
  const [check] = await runChecks(apiChecks(apiClient({ api: "https://sergeant.example", token: "login", version: "2.0.90+abc1234", fetch: fetchFn })));
  expect(seen).toEqual(["GET /v1/runs Bearer login", "GET /v1/runs/run_1 Bearer login"]);
  expect(check).toMatchObject({ status: "PASS", detail: { runs: 1, shown: "run_1", provider: "codex", providerChoice: "codex-local", account: "Ann" } });
});

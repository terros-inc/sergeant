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
      description: null,
      state: { name: "Todo", type: "unstarted" },
      delegate: { id: "agent", name: "Sergeant" },
      assignee: { ...person, url: "https://linear.app/terros/profiles/ann" },
      labels: { nodes: [] },
      attachments: { nodes: [] },
      comments: page([]),
    },
  },
  SergeantDelegationHistory: { issue: { history: page([{ createdAt: "2026-10-06T00:00:00.000Z", actor: person, botActor: null, toDelegate: { id: "agent" }, fromDelegate: null }]) } },
  SergeantIssueOwnership: { issue: { id: "issue-1", createdAt: "2026-10-05T00:00:00.000Z", creator: person, botActor: null, assignee: { ...person, displayName: "ann" }, delegate: { id: "agent", name: "Sergeant" } } },
  SergeantIssueProgress: { issue: { state: { type: "unstarted" }, completedAt: null } },
};

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
  head: { sha: head },
  base: { ref: "main", sha: "b".repeat(40) },
  requested_reviewers: [{ login: "trevor" }],
  requested_teams: [],
};
const githubAnswer = (path: string): unknown => {
  if (path.endsWith("/pulls/7")) return pr;
  if (path.includes("/check-runs")) return { total_count: 1, check_runs: [{ name: "v2", status: "completed", conclusion: "success", app: { id: 15368 } }] };
  if (path.includes("/status")) return { state: "success", total_count: 0, statuses: [] };
  if (path.includes("/rules/branches/")) return [{ type: "required_status_checks", ruleset_id: 1, parameters: { required_status_checks: [{ context: "v2" }] } }];
  if (path.includes("/commits?")) return [{ commit: { message: "Add the thing\n\nCo-authored-by: Claude <noreply@anthropic.com>", author: { name: "Trevor", email: "trevor@terros.com" } }, author: { login: "trevor" } }];
  if (/\/(reviews|comments)\?/.test(path)) return [];
  return undefined;
};

function fakes(broken?: string) {
  const writes: string[] = [];
  const linearFetch: typeof fetch = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (!query.trim().startsWith("query")) writes.push(query);
    const name = /query (\w+)/.exec(query)?.[1] ?? "";
    if (name === broken) return Response.json({ errors: [{ message: "outage" }] });
    return Response.json({ data: linearAnswers[name] ?? null });
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
  const github = createGitHubPort({ token, repositories: { [repo]: { mergeMethod: "squash", mergePolicy: "sergeant" } }, fetch: githubFetch });
  return { writes, linear, github, probes: githubReadProbes({ token, fetch: githubFetch }) };
}

const status = (version: string): typeof fetch => async () => Response.json({ ok: true, version, tasks: [] });

test("every check passes over the real adapters, and nothing is written", async () => {
  const f = fakes();
  const results = await runChecks([
    ...hostChecks({ statusUrl: "http://127.0.0.1:8080/status", localVersion: "2.0.90+abc1234", fetch: status("2.0.90+abc1234") }),
    ...linearChecks(f.linear, { agentUserId: "agent", issue: "TECH-9", retroProjectId: "project" }),
    ...githubChecks(f.github, f.probes, { repo, mergePolicy: "sergeant", pr: 7, issue: "TECH-9" }),
  ]);
  expect(f.writes).toEqual([]);
  expect(results.filter((r) => r.status !== "PASS")).toEqual([]);
  // The squash message is built as a merge would send it: the human commit author is a co-author, the agent's trailer is not.
  expect(results.find((r) => r.name.includes("squash"))?.detail).toEqual({ title: "Add the thing (#7)", coAuthors: ["Trevor <trevor@terros.com>"] });
  expect(results.find((r) => r.name === "linear task owner from delegation history")?.detail).toMatchObject({ owner: person });
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
    "PASS linear delegated issues (intake)",
    "FAIL linear completed issues in the feedback lookback",
    "PASS linear follow-up lookup by key",
    "SKIP linear retro reads (documents, feedback, filed issues)",
    "SKIP linear issue conversation",
    "SKIP linear task owner from delegation history",
    "SKIP linear issue progress (close gate)",
    `SKIP github ${repo} PR facts (mergeable state, human reviews, required checks)`,
    `SKIP github ${repo} squash message from PR text and commits`,
    `SKIP github ${repo} handoff read (draft, requested reviewers)`,
  ]);
  expect(results[2]?.detail).toBe("Linear API error: outage");
  const { text, exitCode } = report(results, "header");
  expect(exitCode).toBe(1);
  expect(text).toContain("FAIL linear completed issues in the feedback lookback [TECH-5049]");
  expect(text.split("\n").at(-1)).toBe("SMOKE FAIL: 2 passed, 2 failed, 7 skipped");
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

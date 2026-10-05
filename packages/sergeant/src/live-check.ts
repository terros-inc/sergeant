// UNF-720's manual live check, for after the V2 Linear app, both GitHub Apps, and the canary
// repository's ruleset are provisioned. Never run by tests or CI. It writes nothing to Linear or
// GitHub (the tokens it mints are revoked at the end), costs no model spend, and prints no secret.
// From packages/sergeant:
//
//   node src/live-check.ts --config <installation.json> --repo owner/name [--issue UNF-123] [--pr 45]
//
// Each line is a named check; the exit code is nonzero if any fails.
import { parseArgs } from "node:util";
import { conversationRevision, RepoSlug } from "@terros/sergeant-contracts";
import { RUN_PERMISSIONS } from "@terros/sergeant-github";
import { z } from "zod";
import { BranchRules } from "./branch-rules.ts";
import { connect, loadConfig } from "./config.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    repo: { type: "string" },
    issue: { type: "string" },
    pr: { type: "string" },
  },
});
const config = await loadConfig(values.config ?? fail("--config is required"));
const repo = RepoSlug.parse(values.repo ?? fail("--repo is required"));
const installation = await connect(config, [repo]);

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};
const github = async (token: string, path: string, method = "GET") => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (${res.status})`);
  return res.status === 204 ? null : res.json();
};

// Linear: `connect` already refused a token that is not the V2 agent (V1's or a person's).
check("linear token is the V2 agent", true, { agentUserId: installation.agentUserId });
if (values.issue) {
  const conversation = await installation.linear.readConversation(values.issue);
  check("issue is delegated to the V2 agent", conversation.issue.delegate?.id === installation.agentUserId, conversation.issue.delegate);
  check("linear reads the issue conversation", true, {
    issue: conversation.issue.identifier,
    state: conversation.issue.state,
    delegate: conversation.issue.delegate,
    linkedPullRequests: conversation.issue.linkedPullRequests,
    humanComments: conversation.humanComments.length,
    revision: conversationRevision(conversation),
  });
}

// An installation token not narrowed by permissions shows everything the App's installation grants.
// Neither App may hold these (08 §1, 09 §5).
const forbidden = (permissions: Record<string, string>) =>
  Object.entries(permissions).filter(
    ([name, level]) => ["administration", "workflows", "secrets", "environments", "deployments"].includes(name) || (name === "actions" && level === "write"),
  );

check("control-plane and worker are different Apps", config.github.controlPlaneApp.appId !== config.github.workerApp.appId, {
  controlPlaneApp: config.github.controlPlaneApp.appId,
  workerApp: config.github.workerApp.appId,
});

// Control-plane App: reads the repository and its default-branch rules.
const control = await installation.controlPlaneApp.mint({ repositories: [repo] });
check("control-plane App holds no forbidden permission", forbidden(control.permissions).length === 0, control.permissions);
const { default_branch: base } = z.object({ default_branch: z.string() }).parse(await github(control.token, `/repos/${repo}`));
const rules = BranchRules.parse(await github(control.token, `/repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=100`));
const declared = rules
  .filter((r) => r.type === "required_status_checks")
  .flatMap((r) => z.object({ required_status_checks: z.array(z.object({ context: z.string() })) }).parse(r.parameters).required_status_checks)
  .map((c) => c.context);
check(`${base} requires a pull request`, rules.some((r) => r.type === "pull_request"), rules.map((r) => r.type));
// The worker App may push, which on GitHub also lets it merge its own green PR. Only a required
// approval stops that: GitHub never lets a PR's author approve it, so the control-plane App's
// approval at merge time is the only one the worker's PRs can get.
const approvals = Math.max(
  0,
  ...rules
    .filter((r) => r.type === "pull_request")
    .map((r) => z.object({ required_approving_review_count: z.number().int() }).parse(r.parameters).required_approving_review_count),
);
check(
  `${base} requires at least one approving review`,
  approvals >= 1,
  approvals >= 1 ? { requiredApprovals: approvals } : `requires ${approvals} approvals; the worker App could merge its own PRs`,
);
check(`${base} declares required checks`, declared.length > 0, declared);
if (values.pr) {
  const facts = await installation.github.readPullRequest(repo, Number(values.pr));
  check("control-plane reads exact-head PR facts", true, { url: facts.url, headSha: facts.headSha, checks: facts.checks.required });
}

// Worker App: what its installation grants, and a run token exactly as the runner mints one.
const workerInstallation = await installation.workerApp.mint({ repositories: [repo] });
check("worker App holds no forbidden permission", forbidden(workerInstallation.permissions).length === 0, workerInstallation.permissions);
const run = await installation.workerApp.mint({ repositories: [repo], permissions: RUN_PERMISSIONS.write });
check("worker run token is scoped to the repository", run.repositories.join() === repo, { repositories: run.repositories, permissions: run.permissions });
// GitHub reports whether the calling actor may bypass each ruleset; anything but "never", or no
// answer, fails.
const rulesetIds = new Set(rules.map((r) => r.ruleset_id));
check("worker bypass is checked against at least one ruleset", rulesetIds.size > 0, [...rulesetIds]);
for (const id of rulesetIds) {
  const ruleset = z
    .object({ name: z.string(), current_user_can_bypass: z.string().optional() })
    .parse(await github(run.token, `/repos/${repo}/rulesets/${id}`));
  check(`worker App cannot bypass ruleset ${ruleset.name}`, ruleset.current_user_can_bypass === "never", ruleset);
}

await Promise.all([control, workerInstallation, run].map((t) => github(t.token, "/installation/token", "DELETE")));

process.exit(failed > 0 ? 1 : 0);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

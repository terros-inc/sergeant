import { type ApiClient, FEEDBACK_LABEL, type GitHubPort, type MergePolicy, type RepoSlug, RunDetail, RunList } from "@terros/sergeant-contracts";
import type { githubReadProbes } from "@terros/sergeant-github";
import type { createLinearPort } from "@terros/sergeant-linear";
import { z } from "zod";

// The post-deploy smoke check (TECH-5279, smoke.ts): each live read Sergeant added since V2, through the
// production adapter and its parser, writing nothing. A check that throws fails; the rest still run.
// docs/live-verification.md lists what each check covers.

export type SmokeCheck = { name: string; covers: string[] } & ({ run: () => Promise<unknown> } | { skip: string });
export type SmokeResult = { name: string; covers: string[]; status: "PASS" | "FAIL" | "SKIP"; detail: unknown };

type LinearReads = Pick<
  ReturnType<typeof createLinearPort>,
  "delegatedIssues" | "completedIssues" | "findFollowupIssue" | "issueProgress" | "readConversation" | "readTaskOwner" | "viewer" | "userNames" | "fetchUpload" | "readProbes"
> & { retro: Pick<ReturnType<typeof createLinearPort>["retro"], "lastRetro" | "feedbackTasks" | "filedIssues"> };
type GitHubReads = Pick<GitHubPort, "readPullRequest" | "defaultBranchHead">;
type GitHubProbes = ReturnType<typeof githubReadProbes>;

const DAY_MS = 86_400_000;

/** `/status` (loopback only) serves the version this checkout reports: the deploy landed and serve restarted on it. */
export function hostChecks(input: { statusUrl: string; localVersion: string; fetch?: typeof globalThis.fetch }): SmokeCheck[] {
  const fetchFn = input.fetch ?? globalThis.fetch;
  return [
    {
      name: "host serves this checkout's version",
      covers: ["deployed version"],
      run: async () => {
        const res = await fetchFn(input.statusUrl).catch((e: Error) => {
          throw new Error(`cannot reach ${input.statusUrl} (${(e.cause as Error | undefined)?.message ?? e.message})`);
        });
        const status = z.object({ ok: z.boolean(), version: z.string() }).parse(await res.json());
        const detail = { hostVersion: status.version, localVersion: input.localVersion, ok: status.ok };
        if (!status.ok) throw new Error(`serve is not healthy: ${JSON.stringify(detail)}`);
        if (status.version !== input.localVersion) throw new Error(`the host serves another version: ${JSON.stringify(detail)}`);
        return detail;
      },
    },
  ];
}

export function linearChecks(
  linear: LinearReads,
  input: { agentUserId: string; issue?: string | undefined; retroProjectId?: string | undefined; upload?: string | undefined; now?: Date },
): SmokeCheck[] {
  const since = new Date((input.now ?? new Date()).getTime() - 14 * DAY_MS).toISOString();
  const { issue, retroProjectId, upload } = input;
  const needsIssue = "needs --issue <a controlled issue delegated to the agent>";
  const uploadCheck = { name: "linear upload download (attachment reading)", covers: ["TECH-4994", "TECH-5042"] };
  const checks: SmokeCheck[] = [
    {
      name: "linear viewer and user names",
      covers: ["V2 config"],
      run: async () => ({ viewerIsAgent: (await linear.viewer()).id === input.agentUserId, agentName: (await linear.userNames([input.agentUserId]))[0] ?? null }),
    },
    upload
      ? {
          ...uploadCheck,
          run: async () => {
            const res = await linear.fetchUpload(upload);
            const bytes = (await res.arrayBuffer()).byteLength;
            if (!res.ok) throw new Error(`Linear upload answered ${res.status}`);
            return { status: res.status, contentType: res.headers.get("content-type"), bytes };
          },
        }
      : { ...uploadCheck, skip: "needs --upload <an https://uploads.linear.app/... URL from a controlled issue>" },
    { name: "linear delegated issues (intake)", covers: ["V2 intake"], run: async () => ({ open: (await linear.delegatedIssues(input.agentUserId)).length }) },
    {
      name: "linear completed issues in the feedback lookback",
      covers: ["TECH-5049"],
      run: async () => ({ since, completed: (await linear.completedIssues(input.agentUserId, since)).length }),
    },
    {
      // A key nothing was filed under: the query must answer "none", not fail as an outage would.
      name: "linear follow-up lookup by key",
      covers: ["TECH-5049"],
      run: async () => ({ found: (await linear.findFollowupIssue(`sergeant-smoke-check ${since}`)) ?? null }),
    },
    retroProjectId
      ? {
          name: "linear retro reads (documents, feedback, filed issues)",
          covers: ["TECH-5187"],
          run: async () => ({
            lastRetro: (await linear.retro.lastRetro(retroProjectId))?.title ?? null,
            feedbackTasks: (await linear.retro.feedbackTasks(since)).length,
            filedIssues: (await linear.retro.filedIssues(input.agentUserId, since)).length,
          }),
        }
      : { name: "linear retro reads (documents, feedback, filed issues)", covers: ["TECH-5187"], skip: "no `retro` in the installation config" },
  ];
  const issueProbes = [
    { name: "linear issue labels and label by name (feedback label)", covers: ["TECH-5186"] },
    { name: "linear blocked-by reads (relations, issue id, relation by id)", covers: ["TECH-5278"] },
    { name: "linear issue workflow (state moves, close)", covers: ["TECH-4947", "TECH-4989"] },
    { name: "linear comment thread and comment by id", covers: ["TECH-5052"] },
    { name: "linear follow-up and retro issue reads (origin, issue, team states, relation and document by id)", covers: ["TECH-5049", "TECH-5187"] },
  ];
  if (!issue) {
    return [
      ...checks,
      ...[
        { name: "linear issue conversation", covers: ["TECH-5244"] },
        { name: "linear task owner from delegation history", covers: ["TECH-5192", "TECH-5217"] },
        { name: "linear issue progress (close gate)", covers: ["TECH-5232"] },
        ...issueProbes,
      ].map((c) => ({ ...c, skip: needsIssue })),
    ];
  }
  return [
    ...checks,
    {
      name: "linear issue conversation",
      covers: ["TECH-5244"],
      run: async () => {
        const c = await linear.readConversation(issue);
        return {
          issue: c.issue.identifier,
          state: c.issue.state,
          delegatedToAgent: c.issue.delegate?.id === input.agentUserId,
          assignee: c.issue.assignee ? { name: c.issue.assignee.name, profileUrl: c.issue.assignee.url !== undefined } : null,
          humanComments: c.humanComments.length,
          linkedIssues: c.linkedIssueBackground?.length ?? 0,
          linkedPullRequests: c.issue.linkedPullRequests.length,
        };
      },
    },
    {
      // A refusal is a correct answer too; only a read that fails, or an answer outside the schema, fails.
      name: "linear task owner from delegation history",
      covers: ["TECH-5192", "TECH-5217"],
      run: () => linear.readTaskOwner(issue, input.agentUserId),
    },
    { name: "linear issue progress (close gate)", covers: ["TECH-5232"], run: () => linear.issueProgress(issue) },
    ...[
      () => linear.readProbes.labels(issue, FEEDBACK_LABEL),
      () => linear.readProbes.blockedBy(issue),
      () => linear.readProbes.workflow(issue),
      async () => {
        const c = await linear.readConversation(issue);
        return linear.readProbes.comments(c.humanComments[0]?.id ?? c.agentComments[0]?.id);
      },
      () => linear.readProbes.followupAndRetro(issue),
    ].map((run, i) => ({ ...issueProbes[i]!, run })),
  ];
}

export function githubChecks(
  github: GitHubReads,
  probes: GitHubProbes,
  input: { repo: RepoSlug; mergePolicy: MergePolicy; pr?: number | undefined; issue?: string | undefined },
): SmokeCheck[] {
  const { repo, pr } = input;
  const facts = { name: `github ${repo} PR facts (mergeable state, human reviews, required checks)`, covers: ["TECH-5232", "TECH-5218", "TECH-5244"] };
  const squash = { name: `github ${repo} squash message from PR text and commits`, covers: ["TECH-5085"] };
  const handoff = { name: `github ${repo} handoff read (draft, requested reviewers, posted comments)`, covers: ["TECH-5244"] };
  const branch = { name: `github ${repo} branch-delete read (head, open PRs on the branch, branch tip)`, covers: ["TECH-5230"] };
  const defaultHead: SmokeCheck = {
    name: `github ${repo} default branch head (follow-up "Written against")`,
    covers: ["TECH-5258"],
    run: () => {
      if (!github.defaultBranchHead) throw new Error("the GitHub adapter has no defaultBranchHead");
      return github.defaultBranchHead(repo);
    },
  };
  if (pr === undefined) return [defaultHead, ...[facts, squash, handoff, branch].map((c) => ({ ...c, skip: "needs --pr <a pull request in the repository>" }))];
  return [
    defaultHead,
    {
      ...facts,
      run: async () => {
        const f = await github.readPullRequest(repo, pr);
        return {
          url: f.url,
          state: f.state,
          headSha: f.headSha,
          mergeable: f.mergeable,
          mergeableState: f.mergeableState,
          mergePolicy: input.mergePolicy,
          requiredChecks: f.checks.required.map((c) => `${c.name} ${c.state}`),
          humanFeedback: f.humanFeedback.length,
        };
      },
    },
    {
      ...squash,
      run: async () => {
        // Only built, never sent: the issue identifier is what the message would close or refer to.
        const message = await probes.squashMessage(repo, pr, { issueIdentifier: input.issue ?? "TECH-0", closesIssue: false, builtBy: "Built by Sergeant (smoke check)" });
        const coAuthors = message.commit_message.split("\n").flatMap((l) => /^co-authored-by:\s*(.+)$/i.exec(l)?.[1] ?? []);
        return { title: message.commit_title, coAuthors };
      },
    },
    { ...handoff, run: () => probes.handoffRead(repo, pr) },
    { ...branch, run: () => probes.branchDeleteRead(repo, pr) },
  ];
}

/** The hosted API's run list and run view, with the operator's `sgt login` (TECH-5123), as `sgt run show` reads it (TECH-5148). */
export function apiChecks(client: ApiClient): SmokeCheck[] {
  return [
    {
      name: "api run list and run view (provider choice, account)",
      covers: ["TECH-5148", "TECH-5123"],
      run: async () => {
        const list = await client.call("GET", "/v1/runs", RunList);
        if (!list.ok) throw new Error(`GET /v1/runs: ${list.error.code}: ${list.error.message}`);
        const first = list.value.runs[0];
        if (!first) return { runs: 0 };
        const shown = await client.call("GET", `/v1/runs/${first.runId}`, RunDetail);
        if (!shown.ok) throw new Error(`GET /v1/runs/${first.runId}: ${shown.error.code}: ${shown.error.message}`);
        const { run } = shown.value;
        return {
          runs: list.value.runs.length,
          shown: run.runId,
          provider: run.provider,
          providerChoice: run.providerChoice ? run.providerChoice.adapter : "absent",
          account: run.account ? run.account.holder : "absent",
        };
      },
    },
  ];
}

export async function runChecks(checks: SmokeCheck[]): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  // One at a time, so a failure's cause is the only thing in flight and output order is the docs' order.
  for (const check of checks) {
    const { name, covers } = check;
    if ("skip" in check) {
      results.push({ name, covers, status: "SKIP", detail: check.skip });
      continue;
    }
    try {
      results.push({ name, covers, status: "PASS", detail: (await check.run()) ?? null });
    } catch (e) {
      results.push({ name, covers, status: "FAIL", detail: (e as Error).message });
    }
  }
  return results;
}

/** One line per check, then the overall result; exit code 1 when any check failed, else 0. */
export function report(results: SmokeResult[], header: string): { text: string; exitCode: number } {
  const failed = results.filter((r) => r.status === "FAIL").length;
  const count = (s: SmokeResult["status"]) => results.filter((r) => r.status === s).length;
  const lines = results.map((r) => `${r.status} ${r.name} [${r.covers.join(", ")}]: ${JSON.stringify(r.detail)}`);
  const overall = `SMOKE ${failed > 0 ? "FAIL" : "PASS"}: ${count("PASS")} passed, ${failed} failed, ${count("SKIP")} skipped`;
  return { text: [header, ...lines, overall].join("\n"), exitCode: failed > 0 ? 1 : 0 };
}

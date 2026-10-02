import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseReport,
  ReviewReport,
  RunRecord,
  WorkerReport,
  type RunGitHubTokens,
  type RunId,
  type RunnerPort,
  type RunSpec,
} from "@terros/sergeant-contracts";
import { z } from "zod";
import { reviewerBrief, workerBrief, type ReviewSubject } from "./brief.ts";
import { checked, exec as hostExec, TOKEN_CREDENTIAL, type Exec } from "./exec.ts";

export type Role = RunSpec["role"];
export type Limits = { maxWallSeconds: number; maxCostUsd: number };

export type ContainerRunnerOptions = {
  /** Host directory holding one directory per run: its workspace, metadata, and final record. */
  rootDir: string;
  /** Built from `container/Dockerfile`. */
  image?: string;
  /** Claude model per role; each run is a new `claude -p` session in a new container. */
  models: Record<Role, string>;
  /**
   * The Sergeant Claude worker token. It enters every container, always and only as
   * `CLAUDE_CODE_OAUTH_TOKEN`. There is deliberately no generic environment input.
   */
  claudeOAuthToken: string;
  /**
   * Mints each run's GitHub token from the worker App, scoped to the run's repositories. A worker's
   * write token is its only GitHub credential and enters its container as `GH_TOKEN`; a reviewer's
   * read-only token is used on the host to check out the PR and never enters its container.
   */
  githubTokens: RunGitHubTokens;
  /**
   * Who a worker's commits are authored and committed as: the installation's human identity, never
   * an agent's. Set through git's environment, which overrides any `user.*` config a run sets.
   */
  gitIdentity: { name: string; email: string };
  limits?: Partial<Record<Role, Limits>>;
  /** Host command runner; injected in tests so no real process is launched. */
  exec?: Exec;
  githubApiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export const PROVIDER = "anthropic/claude-code";

const DEFAULT_LIMITS: Record<Role, Limits> = {
  worker: { maxWallSeconds: 3_600, maxCostUsd: 10 },
  reviewer: { maxWallSeconds: 1_800, maxCostUsd: 5 },
};

const RunMeta = z.object({
  runId: z.string(),
  role: z.enum(["worker", "reviewer"]),
  model: z.string(),
  repositories: z.array(z.string()),
  container: z.string(),
  startedAt: z.string(),
});
type RunMeta = z.infer<typeof RunMeta>;

/** The `claude -p` result line; everything else in it is ignored. */
const AgentOutput = z.object({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

// Runs inside the container.
const AGENT_SCRIPT = `
wall="$1"; model="$2"; budget="$3"
exec timeout "$wall" claude -p "Read /workspace/sergeant-brief.md and do what it says. Your last step is writing /workspace/sergeant-report.md." \\
  --output-format json --model "$model" --max-budget-usd "$budget" --permission-mode bypassPermissions
`;

/**
 * The local runner (04 §10 `claude-code-local`, laptop shape): every worker and reviewer is a new
 * `claude -p` session in a new container whose only mount is the run's own workspace. Its credentials
 * are the model token and, for a worker, the worker-App token it pushes branches and opens PRs with.
 * Repositories are cloned on the host before launch.
 *
 * Basic cancellation only: no leases, adoption, or restart recovery. `send` is not supported.
 */
export function containerRunner(opts: ContainerRunnerOptions): RunnerPort {
  const root = resolve(opts.rootDir);
  const image = opts.image ?? "sergeant-runner:local";
  if (!opts.claudeOAuthToken) throw new Error("containerRunner needs claudeOAuthToken");
  const token = opts.claudeOAuthToken;
  const exec = opts.exec ?? hostExec;
  const execOk = checked(exec);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const apiUrl = (opts.githubApiUrl ?? "https://api.github.com").replace(/\/$/, "");
  /** Host git with the run's token, passed by environment so it is never stored in a repository. */
  const tokenGit = (githubToken: string, args: string[], cwd: string) =>
    execOk("git", [...TOKEN_CREDENTIAL, ...args], { cwd, env: { ...process.env, SERGEANT_RUN_GITHUB_TOKEN: githubToken } });
  const readPr = async (githubToken: string, repo: string, number: number) => {
    const res = await fetchFn(`${apiUrl}/repos/${repo}/pulls/${number}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${githubToken}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`reading ${repo}#${number} failed (${res.status})`);
    return z
      .object({ html_url: z.string(), title: z.string(), body: z.string().nullable(), base: z.object({ ref: z.string() }) })
      .parse(await res.json());
  };
  const paths = (runId: string) => {
    const dir = join(root, runId);
    return { dir, workspace: join(dir, "workspace"), meta: join(dir, "run.json"), record: join(dir, "record.json") };
  };
  const readMeta = async (runId: RunId) => RunMeta.parse(JSON.parse(await readFile(paths(runId).meta, "utf8")));
  const readRecord = async (runId: RunId) => {
    try {
      return RunRecord.parse(JSON.parse(await readFile(paths(runId).record, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  async function finish(meta: RunMeta, record: RunRecord, agent: unknown) {
    const p = paths(meta.runId);
    await writeFile(join(p.dir, "agent.json"), JSON.stringify(agent, null, 2));
    await writeFile(p.record, JSON.stringify(record, null, 2));
    await exec("docker", ["rm", "-f", meta.container]);
    return record;
  }

  async function finalize(meta: RunMeta, exitCode: number): Promise<RunRecord> {
    const p = paths(meta.runId);
    const logs = await exec("docker", ["logs", meta.container]);
    const line = logs.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
    const agent = line ? AgentOutput.safeParse(JSON.parse(line)).data : undefined;
    const succeeded = exitCode === 0 && agent?.is_error === false;
    const resolved = Object.keys(agent?.modelUsage ?? {});
    const base = {
      runId: meta.runId,
      status: succeeded ? "succeeded" : "failed",
      provider: PROVIDER,
      model: resolved.length ? resolved.join(",") : meta.model,
      ...(agent?.total_cost_usd !== undefined && { costUsd: agent.total_cost_usd }),
    } as const;
    const why = exitCode === 124 ? "wall-time limit reached" : `agent exited ${exitCode}${agent?.subtype ? ` (${agent.subtype})` : ""}`;
    const facts = { exitCode, sessionId: agent?.session_id, costUsd: agent?.total_cost_usd, models: resolved };

    const reportPath = await agentFile(p.workspace, "sergeant-report.md");
    const markdown = reportPath && (await readFile(reportPath, "utf8"));
    if (!markdown) {
      return finish(meta, { ...base, role: meta.role, report: null, reportError: `no report written; ${why}` }, facts);
    }
    await writeFile(join(p.dir, "report.md"), markdown);
    if (meta.role === "reviewer") {
      const parsed = parseReport(markdown, ReviewReport);
      return finish(
        meta,
        parsed.ok ? { ...base, role: "reviewer", report: parsed.report } : { ...base, role: "reviewer", report: null, reportError: parsed.error },
        facts,
      );
    }
    const parsed = parseReport(markdown, WorkerReport);
    return finish(
      meta,
      parsed.ok ? { ...base, role: "worker", report: parsed.report } : { ...base, role: "worker", report: null, reportError: parsed.error },
      facts,
    );
  }

  /**
   * Earlier runs naming these PRs: the worker reports are the implementer's claims a reviewer checks,
   * and earlier reviews are the findings it checks were addressed (06 §2).
   */
  async function priorReports(subjects: { repo: string; number: number }[]) {
    const names = (pr: { repo: string; number: number }) => subjects.some((s) => s.repo === pr.repo && s.number === pr.number);
    const claims: string[] = [];
    const reviews: ReviewReport[] = [];
    for (const runId of await readdir(root)) {
      const record = await readRecord(runId).catch(() => undefined);
      if (!record?.report) continue;
      if (record.role === "reviewer") {
        if (record.report.reviewed.some(names)) reviews.push(record.report);
      } else if (record.report.pullRequests.some(names)) {
        claims.push(await readFile(join(paths(runId).dir, "report.md"), "utf8"));
      }
    }
    return { claims, reviews };
  }

  return {
    async start(spec) {
      const p = paths(spec.runId);
      await mkdir(root, { recursive: true });
      try {
        await mkdir(p.dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return; // idempotent on runId
        throw e;
      }
      await mkdir(p.workspace);
      const githubToken = await opts.githubTokens({
        repositories: spec.repositories,
        access: spec.role === "worker" ? "write" : "read",
      });

      let brief: string;
      if (spec.role === "worker") {
        const existing: string[] = [];
        for (const repo of spec.repositories) {
          const dir = join(p.workspace, repo);
          await tokenGit(githubToken, ["clone", "--quiet", `https://github.com/${repo}.git`, dir], p.workspace);
          const remote = await execOk("git", ["branch", "-r", "--list", "origin/sergeant/*", "--format=%(refname:short)"], { cwd: dir });
          existing.push(...remote.split("\n").filter(Boolean).map((b) => `${repo}: ${b.replace(/^origin\//, "")}`));
        }
        brief = workerBrief(spec, existing);
      } else {
        const subjects: ReviewSubject[] = [];
        for (const s of spec.subject) {
          const [owner, name] = s.repo.split("/");
          const rel = `${owner}/${name}-pr${s.number}`;
          const dir = join(p.workspace, rel);
          const pr = await readPr(githubToken, s.repo, s.number);
          await tokenGit(githubToken, ["clone", "--quiet", `https://github.com/${s.repo}.git`, dir], p.workspace);
          await tokenGit(githubToken, ["fetch", "--quiet", "origin", s.headSha], dir);
          await execOk("git", ["checkout", "--quiet", "--detach", s.headSha], { cwd: dir });
          subjects.push({ ...s, url: pr.html_url, title: pr.title, body: pr.body ?? "", baseRef: pr.base.ref, path: `/workspace/${rel}` });
        }
        const prior = await priorReports(spec.subject);
        brief = reviewerBrief(spec, subjects, prior.claims, prior.reviews);
      }
      await writeFile(join(p.workspace, "sergeant-brief.md"), brief);

      const limits = opts.limits?.[spec.role] ?? DEFAULT_LIMITS[spec.role];
      const meta: RunMeta = {
        runId: spec.runId,
        role: spec.role,
        model: opts.models[spec.role],
        repositories: spec.repositories,
        container: `sergeant-${spec.runId}`,
        startedAt: new Date().toISOString(),
      };
      await writeFile(p.meta, JSON.stringify(meta, null, 2));
      // `--env NAME` copies the value from the docker CLI's own environment, so no token is ever on
      // a command line. These are the only credentials that cross into the container: the model
      // token, and a worker's own scoped GitHub token. The git identity variables are not secret.
      const worker = spec.role === "worker";
      await execOk(
        "docker",
        [
          "run", "--detach", "--name", meta.container, "--label", `sergeant.run=${spec.runId}`,
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--volume", `${p.workspace}:/workspace`,
          "--env", "CLAUDE_CODE_OAUTH_TOKEN",
          ...(worker ? ["--env", "GH_TOKEN"] : []),
          ...gitIdentityEnv(opts.gitIdentity),
          image, "sh", "-c", AGENT_SCRIPT, "sh",
          String(limits.maxWallSeconds), meta.model, String(limits.maxCostUsd),
        ],
        { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, ...(worker && { GH_TOKEN: githubToken }) } },
      );
    },

    async status(runId) {
      const done = await readRecord(runId);
      if (done) return done;
      const meta = await readMeta(runId);
      const inspect = await exec("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", meta.container]);
      const base = { runId, provider: PROVIDER, model: meta.model, role: meta.role, report: null };
      if (inspect.code !== 0) {
        // Unknown is not death (04 §6): only Docker saying the container does not exist is loss.
        if (!isGone(inspect)) throw new Error(`status of ${runId} unavailable: ${inspect.stderr.trim().slice(-500)}`);
        return finish(meta, { ...base, status: "failed", reportError: "container is gone and left no result" }, {});
      }
      const [state, code] = inspect.stdout.trim().split(" ");
      if (state !== "exited" && state !== "dead") return RunRecord.parse({ ...base, status: "running" });
      return finalize(meta, Number(code));
    },

    async cancel(runId) {
      if (await readRecord(runId)) return;
      const meta = await readMeta(runId).catch(() => undefined);
      if (!meta) return;
      // Canceled is terminal and stops further cancel attempts, so it is recorded only once Docker
      // shows the container stopped or gone. Anything else throws and the caller retries.
      const stop = await exec("docker", ["stop", "--time", "30", meta.container]);
      const inspect = await exec("docker", ["inspect", "--format", "{{.State.Running}}", meta.container]);
      if (!isGone(inspect) && !(inspect.code === 0 && inspect.stdout.trim() === "false")) {
        throw new Error(`cancel of ${runId} not confirmed: ${(stop.stderr || inspect.stderr || inspect.stdout).trim().slice(-500)}`);
      }
      await finish(meta, { runId, role: meta.role, status: "canceled", provider: PROVIDER, model: meta.model, report: null }, {});
    },
  };
}

/** Docker's definite answer that a container does not exist; any other failure is unknown. */
const isGone = (r: { code: number; stderr: string }) => r.code !== 0 && /no such (container|object)/i.test(r.stderr);

/**
 * The path of a regular file the agent wrote, refusing symlinks anywhere below the workspace: a
 * link planted in the container would otherwise make this host process read a host file.
 */
async function agentFile(workspace: string, ...parts: string[]): Promise<string | undefined> {
  let path = workspace;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const st = await lstat(path).catch(() => undefined);
    if (!st || st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) return undefined;
  }
  return path;
}

const gitIdentityEnv = ({ name, email }: { name: string; email: string }) =>
  [`GIT_AUTHOR_NAME=${name}`, `GIT_AUTHOR_EMAIL=${email}`, `GIT_COMMITTER_NAME=${name}`, `GIT_COMMITTER_EMAIL=${email}`].flatMap(
    (v) => ["--env", v],
  );

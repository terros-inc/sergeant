import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  issueRevision,
  parseReport,
  ReviewReport,
  RunRecord,
  WorkerReport,
  type RunnerPort,
  type RunSpec,
} from "@terros/sergeant-contracts";
import { z } from "zod";
import { ATTACHMENTS_PATH, fetchAttachments, renderAttachments } from "./attachments.ts";
import { hasCodexLabel, pickAccount, runAccount, setAside } from "./accounts.ts";
import { AGENTS, type Adapter } from "./agents.ts";
import { reviewerBrief, workerBrief, type ReviewSubject } from "./brief.ts";
import { CODEX_PRICES } from "./codex-prices.ts";
import { agentFile, gitIdentityEnv, isGone } from "./container.ts";
import { agentFields, setAsideOnFailure } from "./ended.ts";
import { checked, exec as hostExec, TOKEN_CREDENTIAL } from "./exec.ts";
import { DEFAULT_LIMITS, type ContainerRunnerOptions, type Role } from "./options.ts";
import { recorded, runFiles, type RunMeta } from "./run-files.ts";
import { redactSecrets } from "./redact.ts";
import { endOnce, publish } from "./terminal.ts";

export type { ContainerRunnerOptions, Limits, Role } from "./options.ts";

export const PROVIDER = AGENTS["claude-code-local"].provider;

/**
 * The local runner (04 §10 `claude-code-local` and `codex-local`, laptop shape): every worker and
 * reviewer is a new `claude -p` or `codex exec` session in a new container whose only mount is the
 * run's own workspace. Its credentials are one of the task owner's model accounts and, for a worker,
 * the worker-App token it pushes branches and opens PRs with. Repositories are cloned on the host before launch.
 *
 * Basic cancellation only: no leases, adoption, or restart recovery. `send` is not supported.
 */
export function containerRunner(opts: ContainerRunnerOptions): RunnerPort {
  const root = resolve(opts.rootDir);
  const image = opts.image ?? "sergeant-runner:local";
  const adapterOf = (role: Role): Adapter => opts.adapters?.[role] ?? "claude-code-local";
  const asides = opts.asides ?? setAside();
  const codexPrices = { ...CODEX_PRICES, ...opts.codexPrices };
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
  const { paths, readMeta, readRecord, priorReports } = runFiles(root);

  /** Ends the run with the record `end` makes, unless another caller ends it first; either way, the run's one record (terminal.ts). */
  function endRun(meta: RunMeta, end: () => Promise<{ record: RunRecord; agent: unknown }>) {
    return endOnce(paths(meta.runId).dir, () => readRecord(meta.runId), async () => finish(meta, await end()));
  }

  async function finish(meta: RunMeta, { record, agent }: { record: RunRecord; agent: unknown }) {
    const p = paths(meta.runId);
    await publish(join(p.dir, "agent.json"), JSON.stringify(agent, null, 2));
    await publish(p.record, JSON.stringify(record, null, 2), true);
    await exec("docker", ["rm", "-f", meta.container]);
    // Only now, with the record and the copied report on disk: nothing reads an ended run's workspace
    // (workspaces.ts), and a removal that fails is retried by serve's startup sweep.
    await rm(p.workspace, { recursive: true, force: true }).catch(() => undefined);
    return (await readRecord(meta.runId)) ?? record;
  }

  async function finalize(meta: RunMeta, exitCode: number) {
    const logs = await exec("docker", ["logs", meta.container]);
    const agent = AGENTS[meta.adapter].parse(logs.stdout, logs.stderr);
    const base = agentFields(meta, agent, exitCode === 0, codexPrices);
    await setAsideOnFailure(meta, agent, asides, opts);
    const why = exitCode === 124 ? "wall-time limit reached" : `agent exited ${exitCode}${agent.detail ? ` (${agent.detail})` : ""}`;
    const facts = { adapter: meta.adapter, exitCode, sessionId: agent.sessionId, costUsd: agent.costUsd, tokens: agent.tokens, models: agent.models };

    const written = await agentReport(meta);
    return { record: RunRecord.parse({ ...base, role: meta.role, ...(written ?? { report: null, reportError: redactSecrets(`no report written; ${why}`) }) }), agent: facts };
  }

  /** The report the agent wrote in its workspace, if any: copied out as `report.md` and parsed for its role. */
  async function agentReport(meta: RunMeta) {
    const p = paths(meta.runId);
    const reportPath = await agentFile(p.workspace, "sergeant-report.md");
    const markdown = reportPath && (await readFile(reportPath, "utf8"));
    if (!markdown) return undefined;
    await publish(join(p.dir, "report.md"), markdown);
    const parsed = meta.role === "reviewer" ? parseReport(markdown, ReviewReport) : parseReport(markdown, WorkerReport);
    return parsed.ok ? { report: parsed.report } : { report: null, reportError: redactSecrets(parsed.error) };
  }

  /** The task owner's account for a launch, from quota read now (accounts.ts). */
  async function chooseAccount(spec: RunSpec, workerAdapter: Adapter | undefined) {
    const accounts = await opts.accounts(spec.owner.id);
    const codexLabel = hasCodexLabel(spec.conversation.issue.labels);
    return pickAccount({ owner: spec.owner, accounts, read: opts.quota, isSetAside: asides.has, role: spec.role, configured: adapterOf(spec.role), workerAdapter, codexLabel });
  }

  return {
    async start(spec) {
      const p = paths(spec.runId);
      if (await stat(p.dir).then(() => true, () => false)) return; // idempotent on runId
      // The reviewer's other provider comes from the earlier runs, so the account is known before
      // anything is cloned: an owner with no usable account starts nothing (TECH-5179).
      const prior = spec.role === "reviewer" ? await priorReports(spec.subject) : undefined;
      const workerAdapter = prior?.workerAdapter;
      // Quota is read now, before the clones; a burst of launches shares one reading (quota.ts).
      const { account, accountReason, providerChoice } = await chooseAccount(spec, workerAdapter);
      await mkdir(root, { recursive: true });
      try {
        await mkdir(p.dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
        throw e;
      }
      await mkdir(p.workspace);
      const githubToken = await opts.githubTokens({
        repositories: spec.repositories,
        access: spec.role === "worker" ? "write" : "read",
      });

      // The task's files, for worker and reviewer alike; mounted read-only, never fatal.
      const attachmentsDir = join(p.dir, "attachments");
      const attachments = await fetchAttachments(spec.conversation, attachmentsDir, {
        ...(opts.fetchLink && { fetchLink: opts.fetchLink }),
        ...(opts.fetchUpload && { fetchUpload: opts.fetchUpload }),
        ...(opts.attachmentLimits && { limits: opts.attachmentLimits }),
      });
      const files = renderAttachments(attachments);

      let brief: string;
      if (spec.role === "worker") {
        const existing: string[] = [];
        for (const repo of spec.repositories) {
          const dir = join(p.workspace, repo);
          await tokenGit(githubToken, ["clone", "--quiet", `https://github.com/${repo}.git`, dir], p.workspace);
          const remote = await execOk("git", ["branch", "-r", "--list", "origin/sergeant/*", "--format=%(refname:short)"], { cwd: dir });
          existing.push(...remote.split("\n").filter(Boolean).map((b) => `${repo}: ${b.replace(/^origin\//, "")}`));
        }
        brief = workerBrief(spec, existing, files);
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
        brief = reviewerBrief(spec, subjects, prior?.claims ?? [], prior?.reviews ?? [], files);
      }
      await writeFile(join(p.workspace, "sergeant-brief.md"), brief);

      const limits = opts.limits?.[spec.role] ?? DEFAULT_LIMITS[spec.role];
      const adapter = account.adapter;
      const agent = AGENTS[adapter];
      const meta: RunMeta = {
        runId: spec.runId,
        role: spec.role,
        adapter,
        model: opts.models[spec.role][adapter],
        repositories: spec.repositories,
        container: `sergeant-${spec.runId}`,
        startedAt: new Date().toISOString(),
        issueRevision: issueRevision(spec.conversation.issue),
        ...(providerChoice && { providerChoice }),
        account: runAccount(account),
        accountReason,
        ownerId: spec.owner.id,
      };
      await writeFile(p.meta, JSON.stringify(meta, null, 2));
      // `--env NAME` copies the value from the docker CLI's own environment, so no token is ever on
      // a command line. These are the only credentials that cross into the container: its account's
      // model credential, and a worker's own scoped GitHub token. The git identity variables are not secret.
      const worker = spec.role === "worker";
      await execOk(
        "docker",
        [
          "run", "--detach", "--name", meta.container, "--label", `sergeant.run=${spec.runId}`,
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--volume", `${p.workspace}:/workspace`,
          ...(attachments.files.length ? ["--volume", `${attachmentsDir}:${ATTACHMENTS_PATH}:ro`] : []),
          "--env", agent.credentialEnv,
          ...(worker ? ["--env", "GH_TOKEN"] : []),
          ...gitIdentityEnv(opts.gitIdentity),
          image, "sh", "-c", agent.script, "sh",
          String(limits.maxWallSeconds), meta.model, String(limits.maxCostUsd),
        ],
        { env: { ...process.env, [agent.credentialEnv]: account.credential, ...(worker && { GH_TOKEN: githubToken }) } },
      );
    },

    async status(runId) {
      const done = await readRecord(runId);
      if (done) return done;
      const meta = await readMeta(runId);
      const inspect = await exec("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", meta.container]);
      const base = { runId, provider: AGENTS[meta.adapter].provider, model: meta.model, role: meta.role, report: null, ...recorded(meta) };
      if (inspect.code !== 0) {
        // Unknown is not death (04 §6): only Docker saying the container does not exist is loss.
        if (!isGone(inspect)) throw new Error(`status of ${runId} unavailable: ${inspect.stderr.trim().slice(-500)}`);
        return endRun(meta, async () => ({ record: { ...base, status: "failed", reportError: "container is gone and left no result" }, agent: {} }));
      }
      const [state, code] = inspect.stdout.trim().split(" ");
      if (state !== "exited" && state !== "dead") return RunRecord.parse({ ...base, status: "running" });
      return endRun(meta, () => finalize(meta, Number(code)));
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
      // A worker may have written its report, and opened PRs, before it exited or was stopped: the
      // canceled record keeps it, so a stop still finds and closes those PRs (TECH-5070).
      const base = { runId, role: meta.role, status: "canceled", provider: AGENTS[meta.adapter].provider, model: meta.model, report: null, ...recorded(meta) };
      await endRun(meta, async () => ({ record: RunRecord.parse({ ...base, ...(await agentReport(meta)) }), agent: {} }));
    },

    async report(runId) {
      // Only an ended run's: `report.md` is copied out of the workspace as the run finalizes.
      if (!(await readRecord(runId))) return undefined;
      return readFile(join(paths(runId).dir, "report.md"), "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
    },
  };
}

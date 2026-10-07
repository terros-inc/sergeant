import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { issueRevision, parseReport, RunRecord, WorkerReport, type RunnerPort, type RunSpec } from "@terros/sergeant-contracts";
import { hasCodexLabel, pickAccount, runAccount, setAside } from "../accounts.ts";
import { AGENTS, type AgentResult } from "../agents.ts";
import { fetchAttachments } from "../attachments.ts";
import { workerBrief } from "../brief.ts";
import { CODEX_PRICES } from "../codex-prices.ts";
import { agentFields, setAsideOnFailure } from "../ended.ts";
import { checked, exec as hostExec, TOKEN_CREDENTIAL, type Exec } from "../exec.ts";
import { DEFAULT_LIMITS, type ContainerRunnerOptions } from "../options.ts";
import { recorded, runFiles, type RunMeta } from "../run-files.ts";
import { redactSecrets } from "../redact.ts";
import { fargateAws, fargateClients, type FargateClients, type FargateSettings } from "./aws.ts";
import { cleanUp, discard, startRun, type Launch, type LaunchStore } from "./launch.ts";
import { runSecret } from "./secret.ts";
import { agentOutput, awaitingLogs, CONTAINER, extractFrame, secondsBetween, TASK_SCRIPT, taskDefinition, taskState, type TaskState } from "./task.ts";

export type FargateRunnerOptions = Omit<ContainerRunnerOptions, "image" | "githubApiUrl" | "fetch"> & {
  settings: FargateSettings;
  /** The SDK clients; injected in tests. Defaults to the host's instance role in `settings.region`. */
  clients?: FargateClients;
  /** Host command runner, for listing a repository's `sergeant/*` branches; injected in tests. */
  exec?: Exec;
  now?: () => Date;
};

/**
 * The Fargate runner (TECH-5237): every worker is one ECS Fargate task with its own CPU and memory,
 * so it does not compete with the Sergeant host. Account choice, the brief, the agent scripts, and the
 * report are the local runner's; only where the run happens differs. The task clones its repositories
 * itself with the worker token. The brief, the issue's files, and the two credentials reach it in one
 * Secrets Manager secret per run, `sergeant/runs/<runId>`, which the run's collection deletes. The
 * agent's result and report come back framed in the task's CloudWatch log stream (`task.ts`).
 *
 * A start is resumable at each AWS effect (`launch.ts`): a start whose RunTask answer was lost is
 * settled by the run's next `status` or `cancel`, and one that failed before its task leaves no
 * secret. Workers only: a reviewer's checkout stays on the host (`containerRunner`).
 */
export function fargateRunner(opts: FargateRunnerOptions): RunnerPort {
  const root = resolve(opts.rootDir);
  const s = opts.settings;
  const aws = fargateAws(s, opts.clients ?? fargateClients(s.region));
  const asides = opts.asides ?? setAside();
  const codexPrices = { ...CODEX_PRICES, ...opts.codexPrices };
  const execOk = checked(opts.exec ?? hostExec);
  const now = opts.now ?? (() => new Date());
  const { paths, readMeta, readRecord } = runFiles(root);
  /** Runs whose `start` is in progress in this process: their record is not theirs to settle yet. */
  const starting = new Set<string>();

  const store = (runId: string): LaunchStore => {
    const file = join(paths(runId).dir, "launch.json");
    return {
      read: () =>
        readFile(file, "utf8").then(
          (t) => JSON.parse(t) as Launch,
          (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)),
        ),
      write: (l) => writeFile(file, JSON.stringify(l, null, 2)),
      remove: () => rm(file, { force: true }),
    };
  };
  /** Settles a start an earlier call left after sending RunTask: finds its task, or sends the same RunTask again. */
  const resume = (meta: RunMeta) =>
    startRun(
      {
        runId: meta.runId,
        adapter: meta.adapter,
        model: meta.model,
        secretString: () => Promise.reject(new Error("the run's secret is gone; it cannot be started again")),
        taskDefinition: () => {
          throw new Error("the run's task definition is gone; it cannot be started again");
        },
      },
      aws.launch,
      store(meta.runId),
    );

  const base = (meta: RunMeta) => ({ runId: meta.runId, role: "worker", provider: AGENTS[meta.adapter].provider, model: meta.model, report: null, ...recorded(meta) }) as const;

  /** Writes the run's terminal record, the last thing a run's end does, so it is final. */
  async function finish(meta: RunMeta, record: RunRecord, agent: unknown, report?: string) {
    const p = paths(meta.runId);
    await writeFile(join(p.dir, "agent.json"), JSON.stringify(agent, null, 2));
    if (report) await writeFile(join(p.dir, "report.md"), report);
    await writeFile(p.record, JSON.stringify(record, null, 2));
    return record;
  }

  /**
   * The stopped (or forgotten) task's record from its log stream: its agent's result, its report, and
   * then its secret deleted. Undefined while the task's last lines may still be on their way.
   */
  async function collect(meta: RunMeta, l: Launch & { taskArn: string }, state: Exclude<TaskState, { state: "running" }>, stoppedAt: Date | undefined, canceled: boolean) {
    const lines = await aws.logLines(l.taskArn);
    if (awaitingLogs(state, lines, l.nonce, secondsBetween(stoppedAt, now()))) return undefined;
    const agent = parseAgent(meta, agentOutput(lines, l.nonce));
    const exitCode = state.state === "stopped" ? state.exitCode : undefined;
    const fields = agentFields(meta, agent, exitCode === 0, codexPrices);
    const markdown = extractFrame(lines, "REPORT", l.nonce).text;
    const parsed = markdown ? parseReport(markdown, WorkerReport) : undefined;
    const why =
      state.state === "gone" ? "the task is gone" : exitCode === 124 ? "wall-time limit reached" : `exit ${exitCode ?? "unknown"}${state.detail ? ` (${state.detail})` : ""}${agent.detail ? ` (${agent.detail})` : ""}`;
    const status = canceled || (state.state === "stopped" && state.canceled) ? "canceled" : state.state === "gone" ? "failed" : fields.status;
    const record = RunRecord.parse({
      ...fields,
      status,
      role: "worker",
      report: parsed?.ok ? parsed.report : null,
      ...(!parsed?.ok &&
        status !== "canceled" && { reportProblem: parsed ? "malformed" : "missing", reportError: redactSecrets(parsed ? parsed.error : `no report written; ${why}`) }),
    });
    if (status !== "canceled") await setAsideOnFailure(meta, agent, asides, opts);
    await cleanUp(l, aws.launch, store(meta.runId));
    const facts = { adapter: meta.adapter, taskArn: l.taskArn, exitCode, sessionId: agent.sessionId, costUsd: agent.costUsd, tokens: agent.tokens, models: agent.models };
    return finish(meta, record, facts, markdown);
  }

  /** The run's launch, its task settled: undefined when it never started, after cleaning up what its start made. */
  async function settled(meta: RunMeta): Promise<(Launch & { taskArn: string }) | undefined> {
    const st = store(meta.runId);
    const l = await st.read();
    if (!l) return undefined;
    if (l.taskArn) return l as Launch & { taskArn: string };
    // Never sent, or rejected (its secret is gone only once a discard began): its start never got a
    // task and did not finish cleaning up.
    if (!l.runTaskSentAt || !l.secretArn) {
      await discard(l, aws.launch, st);
      return undefined;
    }
    const { taskArn } = await resume(meta);
    return { ...l, taskArn };
  }

  const neverStarted = (meta: RunMeta, status: "failed" | "canceled") =>
    finish(meta, RunRecord.parse({ ...base(meta), status, ...(status === "failed" && { reportProblem: "missing", reportError: "its Fargate task never started" }) }), {});

  return {
    async start(spec: RunSpec) {
      if (spec.role !== "worker") throw new Error("the Fargate runner runs workers only; reviewers run on the host");
      const p = paths(spec.runId);
      if (await stat(p.dir).then(() => true, () => false)) return; // idempotent on runId
      const owner = spec.owner;
      const accounts = await opts.accounts(owner.id);
      const codexLabel = hasCodexLabel(spec.conversation.issue.labels);
      const { account, accountReason, providerChoice } = await pickAccount({ owner, accounts, read: opts.quota, isSetAside: asides.has, role: "worker", workerAdapter: undefined, codexLabel });
      await mkdir(root, { recursive: true });
      try {
        await mkdir(p.dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
        throw e;
      }
      starting.add(spec.runId);
      try {
        const githubToken = await opts.githubTokens({ repositories: spec.repositories, access: "write" });
        // The brief lists each repository's `sergeant/*` branches, here with `ls-remote`: the task clones.
        const existing: string[] = [];
        for (const repo of spec.repositories) {
          const out = await execOk("git", [...TOKEN_CREDENTIAL, "ls-remote", "--heads", `https://github.com/${repo}.git`, "refs/heads/sergeant/*"], {
            env: { ...process.env, SERGEANT_RUN_GITHUB_TOKEN: githubToken },
          });
          existing.push(...out.split("\n").filter(Boolean).map((line) => `${repo}: ${line.split("refs/heads/")[1]}`));
        }
        const attachmentsDir = join(p.dir, "attachments");
        const attachments = await fetchAttachments(spec.conversation, attachmentsDir, {
          ...(opts.fetchLink && { fetchLink: opts.fetchLink }),
          ...(opts.fetchUpload && { fetchUpload: opts.fetchUpload }),
          ...(opts.attachmentLimits && { limits: opts.attachmentLimits }),
        });
        const adapter = account.adapter;
        const secret = await runSecret({
          attachments,
          dir: attachmentsDir,
          brief: (files) => workerBrief(spec, existing, files),
          credentials: { GH_TOKEN: githubToken, [AGENTS[adapter].credentialEnv]: account.credential },
        });
        // The files are in the secret now; nothing reads them here again.
        await rm(attachmentsDir, { recursive: true, force: true });

        const limits = opts.limits?.worker ?? DEFAULT_LIMITS.worker;
        const meta: RunMeta = {
          runId: spec.runId,
          role: "worker",
          adapter,
          model: opts.models.worker[adapter],
          repositories: spec.repositories,
          container: CONTAINER,
          backend: "fargate",
          startedAt: now().toISOString(),
          issueRevision: issueRevision(spec.conversation.issue),
          ...(providerChoice && { providerChoice }),
          account: runAccount(account),
          accountReason,
          ownerId: owner.id,
        };
        await writeFile(p.meta, JSON.stringify(meta, null, 2));
        const command = ["sh", "-c", TASK_SCRIPT, "sh", String(limits.maxWallSeconds), meta.model, String(limits.maxCostUsd), ...spec.repositories];
        await startRun(
          {
            runId: spec.runId,
            adapter,
            model: meta.model,
            secretString: async () => secret.secretString,
            taskDefinition: (l) =>
              taskDefinition({
                family: s.taskFamily,
                image: s.image,
                adapter: l.adapter,
                secretArn: l.secretArn,
                attachments: secret.attachments,
                executionRoleArn: s.executionRoleArn,
                logGroup: s.logGroup,
                region: s.region,
                cpu: s.cpu,
                memory: s.memory,
                gitIdentity: opts.gitIdentity,
                reportNonce: l.nonce,
                command,
              }),
          },
          aws.launch,
          store(spec.runId),
        );
      } finally {
        starting.delete(spec.runId);
      }
    },

    async status(runId) {
      const done = await readRecord(runId);
      if (done) return done;
      const meta = await readMeta(runId);
      if (starting.has(runId)) return RunRecord.parse({ ...base(meta), status: "running" });
      const l = await settled(meta);
      if (!l) return neverStarted(meta, "failed");
      const out = await aws.describe(l.taskArn);
      const state = taskState(out);
      if (state.state === "running") return RunRecord.parse({ ...base(meta), status: "running" });
      const record = await collect(meta, l, state, toDate(out.tasks?.[0]?.stoppedAt), false);
      // Stopped, its last log lines still on their way: running until they arrive.
      return record ?? RunRecord.parse({ ...base(meta), status: "running" });
    },

    async cancel(runId) {
      if (await readRecord(runId)) return;
      const meta = await readMeta(runId).catch(() => undefined);
      if (!meta) return;
      if (starting.has(runId)) throw new Error(`cancel of ${runId} not confirmed: its start is still in progress`);
      const l = await settled(meta);
      if (!l) {
        await neverStarted(meta, "canceled");
        return;
      }
      // Canceled is terminal, so it is recorded only once ECS shows the task stopped or gone, and the
      // report, which may name PRs the worker opened, has arrived (TECH-5070). Otherwise this throws and
      // the caller retries; ECS stops it with SIGTERM, then SIGKILL after the definition's 30 s.
      let out = await aws.describe(l.taskArn);
      if (taskState(out).state === "running") {
        await aws.stop(l.taskArn);
        out = await aws.describe(l.taskArn);
      }
      const state = taskState(out);
      if (state.state === "running") throw new Error(`cancel of ${runId} not confirmed: the task is ${state.lastStatus}`);
      const record = await collect(meta, l, state, toDate(out.tasks?.[0]?.stoppedAt), true);
      if (!record) throw new Error(`cancel of ${runId} not confirmed: its report is not in the task's logs yet`);
    },

    async report(runId) {
      if (!(await readRecord(runId))) return undefined;
      return readFile(join(paths(runId).dir, "report.md"), "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
    },
  };
}

/** The agent's result; a last JSON line the log split and no frame recovered is unreadable, not fatal. */
function parseAgent(meta: RunMeta, output: string): AgentResult {
  try {
    return AGENTS[meta.adapter].parse(output, "");
  } catch {
    return { ok: false, detail: "the agent's result line is unreadable in the task's logs", models: [] };
  }
}

const toDate = (t: Date | string | number | undefined) => (t === undefined ? undefined : t instanceof Date ? t : new Date(typeof t === "number" ? t * 1000 : t));

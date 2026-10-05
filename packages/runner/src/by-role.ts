import { resolve } from "node:path";
import type { RunnerPort, RunId } from "@terros/sergeant-contracts";
import { runFiles } from "./run-files.ts";

/**
 * One runner for an installation whose workers may run on ECS Fargate while its reviewers stay on
 * the host (TECH-5237, `runners.workerBackend`). Both runners keep their runs under the same
 * `rootDir`. A start goes by role; every later call goes by where the run was started, from its
 * `run.json`, so switching the setting leaves running runs where they are. A Fargate run with no
 * Fargate runner configured is unavailable, never read as lost.
 */
export function byRole(rootDir: string, runners: { local: RunnerPort; fargate?: RunnerPort | undefined; workerBackend: "local" | "fargate" }): RunnerPort {
  const { readMeta } = runFiles(resolve(rootDir));
  const { local, fargate } = runners;
  const of = async (runId: RunId): Promise<RunnerPort> => {
    const meta = await readMeta(runId).catch(() => undefined);
    if (meta?.backend !== "fargate") return local;
    if (!fargate) throw new Error(`${runId} runs on Fargate, and this Sergeant has no Fargate runner configured`);
    return fargate;
  };
  return {
    start(spec) {
      if (spec.role !== "worker" || runners.workerBackend === "local") return local.start(spec);
      if (!fargate) throw new Error("runners.workerBackend is fargate, and this Sergeant has no Fargate runner configured");
      return fargate.start(spec);
    },
    status: async (runId) => (await of(runId)).status(runId),
    cancel: async (runId) => (await of(runId)).cancel(runId),
    report: async (runId) => (await of(runId)).report?.(runId),
  };
}

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RunnerPort, RunRecord, RunSpec } from "@terros/sergeant-contracts";
import { byRole } from "./by-role.ts";
import { spec } from "./runner-fixtures.ts";

const fake = (name: string, calls: string[]): RunnerPort => ({
  start: async (s) => void calls.push(`${name} start ${s.role}`),
  status: async (id) => (calls.push(`${name} status ${id}`), {} as RunRecord),
  cancel: async (id) => void calls.push(`${name} cancel ${id}`),
});

// A worker started on Fargate must be read and canceled there after the setting changes back, or the
// local runner would find no container, record it lost, and strand its task and credentials.
it("starts workers on the configured backend, and reads each run where it was started", async () => {
  const root = await mkdtemp(join(tmpdir(), "sergeant-by-role-test-"));
  await mkdir(join(root, "run_f"));
  await writeFile(join(root, "run_f", "run.json"), JSON.stringify({ runId: "run_f", role: "worker", model: "m", repositories: [], container: "worker", startedAt: "t", backend: "fargate" }));
  const calls: string[] = [];
  const runners = { local: fake("local", calls), fargate: fake("fargate", calls) };

  await byRole(root, { ...runners, workerBackend: "fargate" }).start(spec);
  await byRole(root, { ...runners, workerBackend: "fargate" }).start({ ...spec, role: "reviewer" } as unknown as RunSpec);
  const switchedBack = byRole(root, { ...runners, workerBackend: "local" });
  await switchedBack.status("run_f");
  await switchedBack.cancel("run_l");
  expect(calls).toEqual(["fargate start worker", "local start reviewer", "fargate status run_f", "local cancel run_l"]);
  await expect(byRole(root, { local: runners.local, workerBackend: "local" }).status("run_f")).rejects.toThrow(/no Fargate runner/);
});

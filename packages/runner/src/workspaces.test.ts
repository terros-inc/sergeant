import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ended, started } from "./runner-fixtures.ts";
import { pruneWorkspaces, runsUsage } from "./workspaces.ts";

// TECH-5229: every run kept its whole checkout forever and filled the data volume. An ended run's
// workspace goes once its record and report are written, which is all `sgt run show/report`, a
// reviewer's earlier reports, and the feedback sweep read; a run still going keeps everything.

test("a run that ends loses its workspace and keeps run.json, its record, and its report", async () => {
  const { runner, host, rootDir } = await started();
  const dir = join(rootDir, "run_t1");
  await writeFile(join(dir, "workspace", "sergeant-report.md"), "Done, nothing to report.");

  // Still running: nothing is removed, by the runner or the sweep.
  expect(await runner.status("run_t1")).toMatchObject({ status: "running" });
  expect(await pruneWorkspaces(rootDir)).toEqual({ pruned: 0, failed: [] });
  expect((await readdir(join(dir, "workspace"))).sort()).toEqual(["sergeant-brief.md", "sergeant-report.md"]);

  host.docker.running = false;
  const record = await runner.status("run_t1");
  expect(record).toMatchObject({ status: "failed" });
  expect((await readdir(dir)).sort()).toEqual(["agent.json", "record.json", "report.md", "run.json"]);
  expect(await runner.status("run_t1")).toEqual(record);
  expect(await runner.report?.("run_t1")).toBe("Done, nothing to report.");

  const canceled = await started();
  await canceled.runner.cancel("run_t1");
  expect(await readdir(join(canceled.rootDir, "run_t1"))).not.toContain("workspace");
  expect(await canceled.runner.status("run_t1")).toMatchObject({ status: "canceled" });
});

test("the startup sweep removes only ended runs' workspaces, as an older serve left them", async () => {
  const done = await ended({}, "");
  expect(done).toMatchObject({ status: "failed" });
  const { rootDir } = await started();
  const before = await readFile(join(rootDir, "run_t1", "run.json"), "utf8");
  // An ended run whose workspace an older serve kept, and a run still starting, with no run.json yet.
  await mkdir(join(rootDir, "run_old", "workspace", "o", "canary"), { recursive: true });
  await writeFile(join(rootDir, "run_old", "record.json"), JSON.stringify({ ...done, runId: "run_old" }));
  await writeFile(join(rootDir, "run_old", "report.md"), "old report");
  await mkdir(join(rootDir, "run_new", "workspace"), { recursive: true });

  expect(await pruneWorkspaces(rootDir)).toEqual({ pruned: 1, failed: [] });
  expect((await readdir(join(rootDir, "run_old"))).sort()).toEqual(["record.json", "report.md"]);
  expect(await readdir(join(rootDir, "run_new"))).toEqual(["workspace"]);
  expect(await readdir(join(rootDir, "run_t1", "workspace"))).toContain("sergeant-brief.md");
  expect(await readFile(join(rootDir, "run_t1", "run.json"), "utf8")).toBe(before);
  expect(await pruneWorkspaces(rootDir)).toEqual({ pruned: 0, failed: [] });

  const usage = await runsUsage(rootDir);
  expect(usage.count).toBe(3);
  expect(usage.bytes).toBeGreaterThan(0);
  expect(usage.volumeBytes).toBeGreaterThanOrEqual(usage.volumeFreeBytes);
});

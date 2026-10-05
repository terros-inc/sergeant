import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPORT, started } from "./runner-fixtures.ts";

// TECH-5235: the task loop's status and a run view, a task view, a cancel, or a post-merge read can
// all find the same run exited with no record. The one that ends it removes the container and the
// workspace; a second that read "no record" before that, and goes on after it, must not record the run
// again without the report the workspace held, or continuations, stops, and reviews lose it.

/**
 * A run whose worker exited with its report, and `race`, which starts two callers together: the first
 * to reach `firstCmd` waits there until the other has passed its record check and reached `lateCmd`,
 * and that one then waits until the first has ended the run, removing its container and workspace.
 */
async function exitedWithReport() {
  const { runner, host, rootDir } = await started();
  await writeFile(join(rootDir, "run_t1", "workspace", "sergeant-report.md"), REPORT);
  host.docker.running = false;
  host.docker.logs = '{"is_error":false,"session_id":"s","total_cost_usd":1.25}';
  const race = <A, B>(first: () => Promise<A>, firstCmd: string, late: () => Promise<B>, lateCmd: string) => {
    let lateArrived!: () => void;
    const arrived = new Promise<void>((r) => (lateArrived = r));
    let oneEnded!: () => void;
    const ended = new Promise<void>((r) => (oneEnded = r));
    let firstHeld = false;
    let lateHeld = false;
    host.hold.before = async ([cmd]) => {
      if (!firstHeld && cmd === firstCmd) {
        firstHeld = true;
        await arrived;
      } else if (!lateHeld && cmd === lateCmd) {
        lateHeld = true;
        lateArrived();
        await ended;
      }
    };
    return Promise.all([first().finally(oneEnded), late().finally(oneEnded)]);
  };
  return { runner, host, rootDir, race };
}

test("two status reads of a run that just exited record it once, with its report", async () => {
  const { runner, host, rootDir, race } = await exitedWithReport();

  const [first, late] = await race(() => runner.status("run_t1"), "inspect", () => runner.status("run_t1"), "inspect");

  expect(first).toMatchObject({ status: "succeeded", report: { outcome: "completed" } });
  expect(late).toEqual(first);
  expect(await runner.status("run_t1")).toEqual(first);
  expect(await runner.report?.("run_t1")).toBe(REPORT);
  expect(host.calls.filter((c) => c.args[0] === "logs")).toHaveLength(1);
  expect((await readdir(join(rootDir, "run_t1"))).sort()).toEqual(["agent.json", "record.json", "report.md", "run.json"]);
});

test("a cancel racing the status read that ends a run keeps the run's report", async () => {
  const { runner, race } = await exitedWithReport();

  const [ended] = await race(() => runner.status("run_t1"), "inspect", () => runner.cancel("run_t1"), "stop");

  expect(ended).toMatchObject({ status: "succeeded", report: { outcome: "completed" } });
  expect(await runner.status("run_t1")).toEqual(ended);
  expect(await runner.report?.("run_t1")).toBe(REPORT);
});

test("a status read racing the cancel that ends a run reads the canceled record and its report", async () => {
  const { runner, race } = await exitedWithReport();

  const [, late] = await race(() => runner.cancel("run_t1"), "stop", () => runner.status("run_t1"), "inspect");

  expect(late).toMatchObject({ status: "canceled", report: { outcome: "completed" } });
  expect(await runner.report?.("run_t1")).toBe(REPORT);
});

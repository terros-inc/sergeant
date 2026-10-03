import { expect, test, afterEach } from "vitest";
import type { RunRecord, RunnerPort } from "@terros/sergeant-contracts";
import { cleanup, issue, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// UNF-728: undelegating the issue must cancel running work for real (an unconfirmed cancel is
// retried, never taken as stopped), across a crash at any point and a restart.

afterEach(cleanup);

test("a run started just before a crash is still canceled when the human undelegates after the restart", async () => {
  const running = new Map<string, RunRecord>();
  const canceled: string[] = [];
  const runner: RunnerPort = {
    start: async (spec) => void running.set(spec.runId, { ...worker("running"), runId: spec.runId }),
    status: async (id) => running.get(id) ?? Promise.reject(new Error(`no run ${id}`)),
    cancel: async (id) => {
      canceled.push(id);
      const run = running.get(id);
      if (run) running.set(id, { ...run, status: "canceled" });
    },
  };
  // The process dies after the runner started the worker, before the turn's save.
  const crash = await scenario({
    runner,
    reasoner: async () => turnOf([start]),
    onPoll: (_poll, live) => live,
    loop: { log: (line) => { if (line.startsWith("turn 1 (")) throw new Error("process killed"); } },
  }).catch((e: Error) => e.message);
  expect(crash).toBe("process killed");
  const [runId] = running.keys();

  const { result } = await scenario({
    conversation: { issue: { ...issue, delegate: null } },
    runner,
    reasoner: async () => { throw new Error("an undelegated issue gets no turn"); },
    onPoll: (_poll, live) => live,
  });

  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("not delegated") });
  expect(canceled).toEqual([runId]);
  expect(running.get(runId ?? "")?.status).toBe("canceled");
});

test("undelegation stops the loop only once the runner confirms the running run canceled", async () => {
  let w = worker("running");
  let statusReads = 0;
  let cancels = 0;
  const { result } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w"] },
    conversation: { issue: { ...issue, delegate: null } },
    runner: {
      start: async () => {},
      // The runner cannot say at first: unknown is not stopped.
      status: async () => {
        if (++statusReads === 1) throw new Error("docker unavailable");
        return w;
      },
      cancel: async () => {
        if (++cancels < 3) throw new Error("cancel not confirmed");
        w = worker("canceled");
      },
    },
    reasoner: async () => {
      throw new Error("an undelegated issue gets no turn");
    },
    onPoll: (_poll, live) => live,
  });

  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("not delegated") });
  expect(cancels).toBe(3);
});

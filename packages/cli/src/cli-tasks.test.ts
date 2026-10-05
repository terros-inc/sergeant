import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

const detail = {
  task: { ref: "UNF-12", status: "active", startedAt: "2026-10-02T10:00:00.000Z", turns: 2, lastTurnAt: "2026-10-02T10:30:00.000Z", runs: 1 },
  issue: { title: "Fix the login", state: "In Progress", url: "https://linear.app/x/issue/UNF-12", delegatedToSergeant: true, delegate: "Sergeant" },
  budget: {
    window: { wallMinutes: 120, costUsd: 25 },
    wallDeadline: "2026-10-02T12:00:00.000Z",
    spentUsd: 3.5,
    costLimitUsd: 25,
    unknownCostRuns: 1,
    taskStart: "2026-10-02T10:00:00.000Z",
    windowStart: "2026-10-02T10:00:00.000Z",
  },
  runs: [{ runId: "run_w1", task: "UNF-12", role: "worker", status: "running", model: "opus" }],
  recentTurns: [{ at: "2026-10-02T10:30:00.000Z", summary: "Started a worker on the login fix", outcomes: ["start_worker: done"] }],
  followups: [],
};

test("task show prints the facts an operator acts on, and --json is the API's answer unchanged", async () => {
  const { api } = await fakeApi({ "GET /v1/tasks/UNF-12": { json: detail } });

  const human = await sgt(api, "task", "show", "UNF-12");
  expect(human.code).toBe(0);
  expect(human.out).toContain("UNF-12  active  Fix the login");
  expect(human.out).toContain("budget: $3.50 of $25.00 (+1 run of unknown cost)");
  expect(human.out).toMatch(/run_w1\s+worker\s+running/);
  expect(human.out).toContain("Started a worker on the login fix");

  const json = await sgt(api, "--json", "task", "show", "UNF-12");
  expect(JSON.parse(json.out)).toEqual(detail);
});

test("task cancel requires a reason before calling the API, then posts it as JSON with a request id", async () => {
  const { api, seen } = await fakeApi({ "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [] } } });

  const missing = await sgt(api, "task", "cancel", "UNF-12");
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("task cancel needs --reason");
  expect(seen).toEqual([]);

  const done = await sgt(api, "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(done).toMatchObject({ code: 0, out: expect.stringContaining("UNF-12 canceled") });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.contentType).toBe("application/json");
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ reason: "wrong approach", requestId: expect.stringMatching(/^[\w-]+$/) });
});

// An operator must see which worker PRs a cancel closed without opening Linear.
test("task cancel lists the PRs the cancel closed", async () => {
  const pr = { repo: "terros-inc/sergeant", number: 7, url: "https://github.com/terros-inc/sergeant/pull/7" };
  const { api } = await fakeApi({
    "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [pr] } },
    "POST /v1/tasks/UNF-15/cancel": { json: { ref: "UNF-15", undelegated: true, stopping: [], closedPullRequests: [] } },
    "POST /v1/tasks/UNF-14/cancel": { json: { ref: "UNF-14", undelegated: true, stopping: ["run_w1"], closedPullRequests: [] } },
  });

  const closed = await sgt(api, "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(closed).toEqual({
    code: 0,
    out: "UNF-12 canceled: Sergeant's delegation is removed and no run of it is running\nclosed terros-inc/sergeant#7  https://github.com/terros-inc/sergeant/pull/7\n",
    err: "",
  });
  const json = await sgt(api, "--json", "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(JSON.parse(json.out)).toEqual({ ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [pr] });

  const none = await sgt(api, "task", "cancel", "UNF-15", "--reason", "wrong approach");
  expect(none.out).toBe("UNF-15 canceled: Sergeant's delegation is removed and no run of it is running\nno open worker PR to close\n");

  const stopping = await sgt(api, "task", "cancel", "UNF-14", "--reason", "wrong approach");
  expect(stopping).toMatchObject({ code: 0, out: expect.stringContaining("Sergeant keeps canceling: run_w1") });
  expect(stopping.out).toContain("Its open PRs are closed once they stop.");
});

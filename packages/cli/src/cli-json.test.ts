import { expect, test } from "vitest";
import type { Io } from "./cli.ts";
import { closeApi, fakeApi, sgtWith, whoami } from "./fake-api.ts";

// TECH-5224: `--json` is the API's answer as sent, for every command that prints one. sgt's zod parse
// drops a field its copy of the contracts does not know, and the server's minimum sgt is not raised for
// an added optional field, so a parse printed instead would hide every new field from a slightly older
// sgt. The answer is still checked against the contract: outside it, the command fails.

/** A field newer than this sgt's contracts, at the top of an answer and inside it. */
const newer = { newerField: { kept: true } };

const run = { runId: "run_w1", task: "UNF-12", role: "worker", status: "running", model: "opus", ...newer };
const account = { id: "person:u1:codex", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "codex-local", name: "codex", mine: true, ...newer };
const quota = { adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 82 }, fiveHour: { remainingPercent: 99 } };
const request = { id: "req-1", action: "restart", by: "Grace Example <grace@example.com>", at: "2026-10-04T10:00:00.700Z", ...newer };
const outcome = { id: "req-1", action: "restart", by: request.by, outcome: "succeeded", message: "restarted", startedAt: "2026-10-04T10:00:05Z", ...newer };
const status = { serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T09:00:00.000Z", ...newer }, release: null, pending: null, last: outcome, config: null, ...newer };

type Case = { argv: string[]; route: string; answer: object; io?: Partial<Io>; others?: Record<string, { json: unknown }>; printed?: unknown };
const cases: Record<string, Case> = {
  whoami: { argv: ["whoami"], route: "GET /v1/whoami", answer: { ...whoami(), user: { ...whoami().user, ...newer }, ...newer } },
  "task list": { argv: ["task", "list"], route: "GET /v1/tasks", answer: { tasks: [{ ref: "UNF-12", status: "active", turns: 2, runs: 1, ...newer }], ...newer } },
  "task show": {
    argv: ["task", "show", "UNF-12"],
    route: "GET /v1/tasks/UNF-12",
    answer: { task: { ref: "UNF-12", status: "active", turns: 2, runs: 1, ...newer }, issue: { error: "Linear is down", ...newer }, runs: [run], recentTurns: [], followups: [], ...newer },
  },
  "task wake": { argv: ["task", "wake", "UNF-12"], route: "POST /v1/tasks/UNF-12/wake", answer: { ref: "UNF-12", woke: "active", ...newer } },
  "task cancel": {
    argv: ["task", "cancel", "UNF-12", "--reason", "wrong approach"],
    route: "POST /v1/tasks/UNF-12/cancel",
    answer: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [{ repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", ...newer }], ...newer },
  },
  "run list": { argv: ["run", "list", "--task", "UNF-12"], route: "GET /v1/runs?task=UNF-12", answer: { runs: [run], ...newer } },
  "run show": {
    argv: ["run", "show", "run_w1"],
    route: "GET /v1/runs/run_w1",
    answer: { task: "UNF-12", run: { runId: "run_w1", role: "worker", status: "running", provider: "openai/codex", model: "gpt-5", report: null, ...newer }, ...newer },
  },
  "run cancel": { argv: ["run", "cancel", "run_w1"], route: "POST /v1/runs/run_w1/cancel", answer: { runId: "run_w1", task: "UNF-12", status: "canceled", ...newer } },
  "repo list": { argv: ["repo", "list"], route: "GET /v1/repositories", answer: { repositories: [{ repo: "o/r", mergeMethod: "squash", mergePolicy: "human", ...newer }], ...newer } },
  "admin repo add": { argv: ["admin", "repo", "add", "o/r"], route: "POST /v1/repositories/add", answer: { repo: "o/r", changed: true, repositories: ["o/r"], ...newer } },
  "admin repo remove": { argv: ["admin", "repo", "remove", "o/r"], route: "POST /v1/repositories/remove", answer: { repo: "o/r", changed: true, repositories: [], ...newer } },
  retro: { argv: ["retro"], route: "POST /v1/retro", answer: { requested: true, ...newer } },
  "account list": { argv: ["account", "list"], route: "GET /v1/accounts", answer: { accounts: [{ ...account, usage: { runs: 1, costUsd: 0, unknownCostRuns: 1, ...newer } }], ...newer } },
  "account register": {
    argv: ["account", "register", "codex"],
    io: { stdin: async () => '{"tokens":{"access_token":"t"}}' },
    others: { "GET /v1/whoami": { json: whoami() } },
    route: "POST /v1/accounts/register",
    answer: { account, replaced: false, quota: { ...quota, ...newer }, notice: "Your credential is used inside Sergeant's containers.", ...newer },
  },
  "account remove": { argv: ["account", "remove", "codex"], route: "POST /v1/accounts/remove", answer: { name: "codex", removed: true, ...newer } },
  "admin account remove-person": {
    argv: ["admin", "account", "remove-person", "u1"],
    route: "POST /v1/accounts/remove-person",
    answer: { userId: "u1", removed: [{ id: "person:u1:codex-local", adapter: "codex-local", holder: "Ada", ...newer }], ...newer },
  },
  "admin status": { argv: ["admin", "status"], route: "GET /v1/admin/status", answer: status },
  // sgt builds this one's shape ({request, outcome}, USAGE); each part is still as the API sent it.
  "admin restart": {
    argv: ["admin", "restart"],
    io: { sleep: async () => {} },
    others: { "GET /v1/admin/status": { json: status } },
    route: "POST /v1/admin/restart",
    answer: { request, last: null, ...newer },
    printed: { request, outcome },
  },
};

test.each(Object.entries(cases))("%s --json prints the API's answer as sent, and fails on one outside the contract", async (_, c) => {
  const { api } = await fakeApi({ ...c.others, [c.route]: { json: c.answer } });
  const kept = await sgtWith(c.io ?? {}, api, "--json", ...c.argv);
  expect([kept.code, JSON.parse(kept.out)]).toEqual([0, c.printed ?? c.answer]);

  await closeApi();
  const { api: drifted } = await fakeApi({ ...c.others, [c.route]: { json: { ...newer } } });
  const outside = await sgtWith(c.io ?? {}, drifted, "--json", ...c.argv);
  expect([outside.code, JSON.parse(outside.out).error]).toEqual([1, { code: "unavailable", message: expect.stringContaining("outside the API contract") }]);
});

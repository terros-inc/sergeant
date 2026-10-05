import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

// TECH-5148: the client's RunDetail parse strips unknown keys, so the provider choice and account
// must be in its schema to reach `sgt run show` and `--json`.
test("run show prints the run's account, provider and quota, and --json keeps them", async () => {
  const run = {
    runId: "run_w1", role: "worker", status: "succeeded", provider: "openai/codex", model: "gpt-5", report: null, costUsd: 0,
    providerChoice: {
      adapter: "codex-local",
      reason: "more weekly quota",
      readings: [{ adapter: "codex-local", account: "installation-codex", readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 80 }, fiveHour: { remainingPercent: 90 } }],
    },
    account: { id: "installation-codex", group: "owner", holder: "the installation" },
    accountReason: "owner's account installation-codex",
  };
  const { api } = await fakeApi({ "GET /v1/runs/run_w1": { json: { task: "UNF-12", run } } });

  const human = await sgt(api, "run", "show", "run_w1");
  expect(human.code).toBe(0);
  expect(human.out).toContain("account: installation-codex (the installation), owner's account installation-codex");
  expect(human.out).toContain("provider: codex-local, more weekly quota");
  expect(human.out).toContain("quota: codex-local 80% weekly, 90% 5-hour left");

  const json = await sgt(api, "--json", "run", "show", "run_w1");
  expect(JSON.parse(json.out)).toEqual({ task: "UNF-12", run });
});

// TECH-5148 live: an sgt whose contract predates a run field stripped it from `--json` too, so the
// hosted answer looked as if it lacked the field. `--json` is the API's answer as sent.
test("run show --json keeps a run field this sgt's contract does not know", async () => {
  const run = { runId: "run_w1", role: "worker", status: "running", provider: "openai/codex", model: "gpt-5", report: null, newerField: { kept: true } };
  const { api } = await fakeApi({ "GET /v1/runs/run_w1": { json: { task: "UNF-12", run } }, "GET /v1/runs/run_w2": { json: { task: "UNF-12" } } });

  expect(JSON.parse((await sgt(api, "--json", "run", "show", "run_w1")).out)).toEqual({ task: "UNF-12", run });
  // Still checked against the contract: an answer outside it is an error, never printed as the run.
  const outside = await sgt(api, "--json", "run", "show", "run_w2");
  expect([outside.code, JSON.parse(outside.out).error.code]).toEqual([1, "unavailable"]);
});

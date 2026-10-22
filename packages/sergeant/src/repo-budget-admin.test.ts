import { afterEach, expect, test } from "vitest";
import { closeServer, CONFIG, serve } from "./enrollment-fixtures.ts";

// TECH-6606: an approver sets a repository's own budget with `sgt admin repo budget`, no AWS. Getting it
// wrong rewrites the other field or another setting of the installation config, which serve then runs,
// or lets a non-approver or a malformed value change how long Sergeant's tasks may run.

afterEach(closeServer);

const repo = "terros-inc/one";
const ownIn = (value: string) => (JSON.parse(value) as { repositories: Record<string, { budget?: object }> }).repositories[repo]?.budget;

test("each field is set and cleared on its own, the other kept, and only that repository's budget is written", async () => {
  const { call, parameter, configs, logs } = await serve();

  // One field: the other stays the installation's.
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo: "Terros-Inc/One", wallMinutes: 60 })).toMatchObject({
    status: 200,
    json: { repo, changed: true, ownBudget: { wallMinutes: 60 }, budget: { wallMinutes: 60, costUsd: 10 } },
  });
  // Exactly the parameter as it was plus the one field, never Zod's defaults or anything else.
  expect(JSON.parse(parameter.value)).toEqual({ ...CONFIG, repositories: { [repo]: { mergeMethod: "squash", budget: { wallMinutes: 60 } } } });
  expect(parameter.descriptions).toEqual(["Grace Example set terros-inc/one's budget: wallMinutes 60, costUsd the installation's"]);
  // The live settings every task loop reads when a window opens.
  expect(configs[repo]).toMatchObject({ budget: { wallMinutes: 60 } });
  expect(logs.at(-1)).toContain("the installation-config parameter and the running service have it");

  // The other field leaves the first as it is; the same value again writes nothing.
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, costUsd: 12.5 })).toMatchObject({ status: 200, json: { changed: true, budget: { wallMinutes: 60, costUsd: 12.5 } } });
  expect(ownIn(parameter.value)).toEqual({ wallMinutes: 60, costUsd: 12.5 });
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, costUsd: 12.5 })).toMatchObject({ status: 200, json: { changed: false } });
  expect(parameter.descriptions).toHaveLength(2);

  // Both at once.
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, wallMinutes: 90, costUsd: 30 })).toMatchObject({ status: 200, json: { changed: true, ownBudget: { wallMinutes: 90, costUsd: 30 } } });
  expect(ownIn(parameter.value)).toEqual({ wallMinutes: 90, costUsd: 30 });

  // Anyone signed in sees the window it gives and which fields are the repository's own.
  expect(await call("GET", "/v1/repositories", "ada")).toMatchObject({ status: 200, json: { repositories: [{ repo, budget: { wallMinutes: 90, costUsd: 30 }, ownBudget: { wallMinutes: 90, costUsd: 30 } }] } });

  // Clearing one keeps the other; clearing the last removes the override, leaving the parameter as it began.
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, wallMinutes: "default" })).toMatchObject({ status: 200, json: { changed: true, ownBudget: { costUsd: 30 }, budget: { wallMinutes: 120, costUsd: 30 } } });
  expect(ownIn(parameter.value)).toEqual({ costUsd: 30 });
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, costUsd: "default" })).toMatchObject({ status: 200, json: { changed: true, ownBudget: {}, budget: { wallMinutes: 120, costUsd: 10 } } });
  expect(JSON.parse(parameter.value)).toEqual(CONFIG);
  expect(configs[repo]?.budget).toBeUndefined();
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo, costUsd: "default" })).toMatchObject({ status: 200, json: { changed: false } });
});

test("a non-approver, an unenrolled repository, and an invalid value are refused, and nothing is written", async () => {
  const { call, parameter, configs } = await serve();
  const refused = [
    [403, "ada", { repo, wallMinutes: 60 }],
    [400, "grace", { repo: "terros-inc/two", wallMinutes: 60 }],
    [400, "grace", { repo: "not a slug", wallMinutes: 60 }],
    [400, "grace", { repo, wallMinutes: 0 }],
    [400, "grace", { repo, costUsd: -5 }],
    [400, "grace", { repo, wallMinutes: "60" }],
    [400, "grace", { repo }],
    // A client's NaN or Infinity reaches serve as null, or as a literal too big for a double: neither clears.
    [400, "grace", { repo, wallMinutes: null }],
    [400, "grace", `{"repo":"${repo}","costUsd":1e999}`],
    [400, "grace", { repo, wallMinutes: 60, mergePolicy: "sergeant" }],
  ] as const;
  for (const [status, as, body] of refused) expect(await call("POST", "/v1/repositories/budget", as, body)).toMatchObject({ status });
  expect(await call("POST", "/v1/repositories/budget", "grace", { repo: "terros-inc/two", costUsd: 5 })).toMatchObject({ json: { error: { message: expect.stringContaining("terros-inc/two is not enrolled") } } });
  expect([parameter.version, parameter.descriptions, JSON.parse(parameter.value), configs[repo]?.budget]).toEqual([1, [], CONFIG, undefined]);
});

// TECH-6617: `sgt admin repo audit-rate` turns the daily merged-PR audit on or off for one repository.
// A stray `0` key left behind, a rate above 1 or a NaN sent as null, or a non-approver's change would
// start (or silently stop) audits nobody chose.
test("an approver sets a repository's merged-PR audit rate, 0 removes it, and anything else is refused", async () => {
  const { call, parameter, configs } = await serve();
  expect(await call("POST", "/v1/repositories/audit-rate", "grace", { repo, mergedAuditSampleRate: 0.1 })).toMatchObject({ status: 200, json: { repo, changed: true, mergedAuditSampleRate: 0.1 } });
  expect(JSON.parse(parameter.value)).toEqual({ ...CONFIG, repositories: { [repo]: { mergeMethod: "squash", mergedAuditSampleRate: 0.1 } } });
  expect(configs[repo]?.mergedAuditSampleRate).toBe(0.1);
  expect(await call("GET", "/v1/repositories", "ada")).toMatchObject({ json: { repositories: [{ repo, mergedAuditSampleRate: 0.1 }] } });

  for (const bad of [1.5, -0.1, null, "0.1"]) expect((await call("POST", "/v1/repositories/audit-rate", "grace", { repo, mergedAuditSampleRate: bad })).status).toBe(400);
  expect((await call("POST", "/v1/repositories/audit-rate", "ada", { repo, mergedAuditSampleRate: 1 })).status).toBe(403);
  expect((await call("POST", "/v1/repositories/audit-rate", "grace", { repo: "terros-inc/other", mergedAuditSampleRate: 1 })).status).toBe(400);
  expect(configs[repo]?.mergedAuditSampleRate).toBe(0.1);

  expect(await call("POST", "/v1/repositories/audit-rate", "grace", { repo, mergedAuditSampleRate: 0 })).toMatchObject({ status: 200, json: { changed: true, mergedAuditSampleRate: 0 } });
  expect(JSON.parse(parameter.value)).toEqual(CONFIG);
  expect(configs[repo]?.mergedAuditSampleRate).toBeUndefined();
});

import { LinearRateLimitedError } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5923: the installation's Linear token ran past its hourly complexity budget. Linear refused every
// call with HTTP 400 `RATELIMITED`, the adapter reported a bare "(400)", and every failed task loop was
// readmitted, and read Linear again, at each intake, so the budget never recovered.

const T0 = Date.parse("2026-10-13T01:39:44Z");
const RESET = T0 + 20 * 60_000;
const rateLimited = () =>
  Response.json(
    { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
    {
      status: 400,
      headers: {
        "x-complexity": "244",
        "x-ratelimit-complexity-remaining": "120",
        "x-ratelimit-complexity-reset": String(RESET),
        "x-ratelimit-requests-remaining": "1800",
        "x-ratelimit-requests-reset": String(T0 + 50 * 60_000),
      },
    },
  );

const linear = (answer: () => Response) => {
  const clock = { now: T0 };
  const logs: string[] = [];
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return answer();
  };
  const port = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch, log: (l) => logs.push(l), now: () => clock.now });
  return { port, clock, logs, calls: () => calls };
};

test("a RATELIMITED refusal pauses every Linear call until the latest advertised reset, logged once", async () => {
  let limited = true;
  const { port, clock, logs, calls } = linear(() => (limited ? rateLimited() : Response.json({ data: { issue: { state: { type: "started" }, completedAt: null } } })));
  const until = new Date(T0 + 50 * 60_000).toISOString();

  const first = await port.issueProgress("UNF-1").catch((e: unknown) => e);
  expect(first).toBeInstanceOf(LinearRateLimitedError);
  expect((first as LinearRateLimitedError).until).toBe(until);

  // While paused, a call throws at once and never reaches Linear.
  clock.now = T0 + 50 * 60_000 - 1000;
  await expect(port.issueProgress("UNF-1")).rejects.toThrow(LinearRateLimitedError);
  expect(calls()).toBe(1);
  expect(logs).toEqual([`Linear API rate limit: no Linear calls until ${until}`]);

  limited = false;
  clock.now = T0 + 50 * 60_000;
  await expect(port.issueProgress("UNF-1")).resolves.toEqual({ stateType: "started", completedAt: null });
  expect(calls()).toBe(2);
});

test("a far-future reset cannot pause Linear calls for more than an hour", async () => {
  const farFuture = T0 + 24 * 60 * 60_000;
  const { port } = linear(() =>
    Response.json(
      { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
      { status: 400, headers: { "x-ratelimit-requests-reset": String(farFuture) } },
    ),
  );

  const error = await port.issueProgress("UNF-1").catch((e: unknown) => e);

  expect((error as LinearRateLimitedError).until).toBe(new Date(T0 + 60 * 60_000).toISOString());
});

test("a refusal without an advertised reset pauses a minute", async () => {
  const { port } = linear(() => Response.json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, { status: 400 }));

  const error = await port.issueProgress("UNF-1").catch((e: unknown) => e);

  expect((error as LinearRateLimitedError).until).toBe(new Date(T0 + 60_000).toISOString());
});

test("any other refusal says Linear's code and message, and pauses nothing", async () => {
  let calls = 0;
  const { port } = linear(() => {
    calls += 1;
    return Response.json({ errors: [{ message: "Argument Validation Error", extensions: { code: "INVALID_INPUT" } }] }, { status: 400 });
  });

  await expect(port.issueProgress("UNF-1")).rejects.toThrow("Linear API request failed (400: INVALID_INPUT: Argument Validation Error)");
  await expect(port.issueProgress("UNF-1")).rejects.not.toThrow(LinearRateLimitedError);
  expect(calls).toBe(2);
});

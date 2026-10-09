import { accountQuota } from "@terros/sergeant-runner";
import { expect, test } from "vitest";
import { accountRegistry } from "./accounts.ts";

// TECH-5211: a personal ChatGPT plan reports only one quota window. The credential works, so it
// registers and says which window is unknown; only a credential that reads no window is refused.
test("a Codex login whose usage reports one window registers with the other unknown; one reporting none is refused", async () => {
  let usage: unknown = { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800 }, secondary_window: null } };
  let status = 200;
  const fetch = (async () => new Response(JSON.stringify(usage), { status })) as typeof globalThis.fetch;
  const secrets: Record<string, string> = { s: '{"accounts":[]}' };
  const registry = accountRegistry({
    secret: "s",
    readSecret: async (ref) => secrets[ref] ?? "",
    writeSecret: async (ref, value) => void (secrets[ref] = value),
    readQuota: accountQuota({ fetch }),
    log: () => undefined,
  });
  const ada = { id: "u-ada", name: "Ada", email: "ada@example.com" };
  const login = (token: string) => JSON.stringify({ tokens: { access_token: token } });

  const res = await registry.register(ada, "codex-local", "codexPersonal", login("a"));
  expect(res.quota).toMatchObject({ weekly: { remainingPercent: 60 } });
  expect(res.quota.fiveHour).toBeUndefined();
  expect(res.account.quotaUnknown).toEqual(["5-hour"]);
  expect((await registry.list())[0]?.quotaUnknown).toEqual(["5-hour"]);

  usage = { rate_limit: null };
  await expect(registry.register(ada, "codex-local", "codexNone", login("b"))).rejects.toThrow(/quota cannot be read with this credential \(no quota window reported\)/);
  status = 401;
  await expect(registry.register(ada, "codex-local", "codexExpired", login("c"))).rejects.toThrow(/usage endpoint answered 401/);
  expect((await registry.list()).map((a) => a.name)).toEqual(["codexPersonal"]);
});

// TECH-5593: a run on a registered account commits as the person who registered it with their Linear
// login, the task owner; the API's list of accounts gains nothing from it.
test("an account carries its registrant's login name and email to the runner, not to the list", async () => {
  const usage = { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800 }, secondary_window: null } };
  const fetch = (async () => new Response(JSON.stringify(usage))) as typeof globalThis.fetch;
  const secrets: Record<string, string> = { s: '{"accounts":[]}' };
  const registry = accountRegistry({
    secret: "s",
    readSecret: async (ref) => secrets[ref] ?? "",
    writeSecret: async (ref, value) => void (secrets[ref] = value),
    readQuota: accountQuota({ fetch }),
    log: () => undefined,
  });
  await registry.register({ id: "u-ada", name: "Ada Lovelace", email: "ada@example.com" }, "codex-local", "codex", JSON.stringify({ tokens: { access_token: "a" } }));

  expect((await registry.of("u-ada"))[0]?.person).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  expect((await registry.list())[0]).not.toHaveProperty("person");
});

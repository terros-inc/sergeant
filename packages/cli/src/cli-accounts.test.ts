import type { WhoAmI } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { closeApi, fakeApi, sgt, sgtWith, whoami } from "./fake-api.ts";
import { quotaLeft } from "./format.ts";

// TECH-5113: a credential is read from stdin, never an argument a shell history or process list keeps,
// and only the API's answer, which never holds it, is printed. TECH-5196: with nothing piped it comes
// from the provider's own sign-in, and a name defaults to the provider.
test("account register sends the piped or signed-in credential under its name and prints the account without it", async () => {
  const notice = "Your credential is used inside Sergeant's worker and reviewer containers … run `sgt account remove codex` … `codex login` again.";
  const account = { id: "person:u1:codex", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "codex-local", name: "codex", mine: true };
  const { api, seen } = await fakeApi({
    "GET /v1/whoami": { json: whoami() },
    "POST /v1/accounts/register": { json: { account, replaced: false, quota: { adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 82 }, fiveHour: { remainingPercent: 99 } }, notice } },
    "GET /v1/accounts": { json: { accounts: [{ ...account, usage: { runs: 3, costUsd: 0, unknownCostRuns: 3 } }, { ...account, name: "codexPersonal", quotaUnknown: ["5-hour"], usage: { runs: 0, costUsd: 0, unknownCostRuns: 0 } }] } },
  });
  const credential = '{"tokens":{"access_token":"secret-access"}}';
  const signIns: string[] = [];
  const signIn = async (provider: string) => (signIns.push(provider), `${credential}\n`);

  for (const bad of [["codex", "--name", "my work"], ["codex-local"]]) expect((await sgtWith({ signIn }, api, "account", "register", ...bad)).code).toBe(2);
  // TECH-5205: bare, it names the providers and shows --name, before any login or API call.
  const bare = await sgtWith({ signIn }, api, "account", "register");
  expect([bare.code, bare.out, seen, signIns]).toEqual([2, "", [], []]);
  expect(bare.err).toMatch(/claude \(your Claude subscription\) or codex/);
  expect(bare.err).toContain("\n  sgt account register codex --name codexWork\n(sgt --help for usage)\n");
  expect((await sgtWith({ stdin: async () => "\n", signIn }, api, "account", "register", "codex")).code).toBe(2);
  expect([seen, signIns]).toEqual([[], []]);

  // TECH-5215: whose Sergeant account it is comes first; the result names the provider login, never the Linear email.
  const piped = await sgtWith({ stdin: async () => `${credential}\n`, signIn }, api, "account", "register", "codex");
  expect(piped).toMatchObject({ code: 0, out: expect.stringContaining("registered codex: ChatGPT account, 82% weekly left, 99% 5-hour left. Sergeant uses it") });
  expect(piped.err).toBe("Signed in to Sergeant as Ada Example (ada@example.com, via Linear). Registering a Codex account for you as codex.\n");
  expect(piped.out).toContain(notice);
  expect(piped.out).not.toContain("ada@example.com");
  const signedIn = await sgtWith({ signIn }, api, "account", "register", "codex", "--name", "codexWork");
  expect(signedIn.code).toBe(0);
  expect(signedIn.err.indexOf("Registering a Codex account for you as codexWork.")).toBeLessThan(signedIn.err.indexOf("Signing in with `codex login`"));
  const idToken = `h.${Buffer.from(JSON.stringify({ email: "ada.personal@example.org" })).toString("base64url")}.sig`;
  const withEmail = await sgtWith({ stdin: async () => JSON.stringify({ tokens: { id_token: idToken, access_token: "secret-access" } }), signIn }, api, "account", "register", "codex");
  expect(withEmail.out).toContain("registered codex: ChatGPT account ada.personal@example.org, 82% weekly left, 99% 5-hour left.");
  expect(withEmail.out + withEmail.err).not.toMatch(/secret-access|h\.ey/);
  expect(signIns).toEqual(["codex"]);
  const posted = seen.filter((s) => s.method === "POST").map((s) => JSON.parse(s.body));
  expect(posted.slice(0, 2)).toEqual([{ provider: "codex", name: "codex", credential }, { provider: "codex", name: "codexWork", credential }]);
  for (const r of [piped, signedIn]) expect(r.out + r.err).not.toContain("secret-access");

  const list = await sgt(api, "account", "list");
  expect(list.out).toMatch(/codex\s+codex\s+Ada Example <ada@example.com> \(yours\)\s+3 runs\s+\$0.00 \+3 of unknown cost/);
  // TECH-5211: a plan that reports one window registers, and both lines say which one is unknown.
  expect(list.out).toMatch(/codexPersonal\s+codex\s+.*\$0.00\s+quota: 5-hour unknown/);
  expect(quotaLeft({ adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 60.4 } })).toBe("60% weekly left, 5-hour unknown");
});

// TECH-5202: a refusal comes before the provider's sign-in makes a credential, in words a person acts
// on; one that comes after says what to do with the credential that now exists.
test("account register asks first, refuses before any sign-in, and says what to do with a credential it could not register", async () => {
  const signIns: string[] = [];
  const signIn = async (provider: string) => (signIns.push(provider), "sk-ant-oat01-made");
  const refusedBy = async (me: WhoAmI, provider: string) => {
    const { api, seen } = await fakeApi({ "GET /v1/whoami": { json: me } });
    const res = await sgtWith({ signIn }, api, "account", "register", provider, "--name", "claudeWork");
    await closeApi();
    expect(seen.map((s) => s.url)).toEqual(["/v1/whoami"]);
    return res;
  };
  expect(await refusedBy(whoami({ registration: { providers: [] } }), "claude")).toEqual({
    code: 1,
    out: "",
    err: "sgt: bad_request: This Sergeant isn't set up for account registration yet. Ask an approver (Grace Hopper or Linus Torvalds) to enable it (deploy/README.md, \"Model accounts\").\n",
  });
  expect((await refusedBy(whoami({ registration: { providers: ["claude"] }, approvers: [] }), "codex")).err).toContain(
    "This Sergeant doesn't run Codex accounts, only Claude. Ask an approver if you need Codex.",
  );
  expect((await refusedBy(whoami({ auth: "loopback", user: null }), "claude")).err).toContain("sign in with `sgt login`");
  expect(signIns).toEqual([]);

  const refusal = { status: 400, json: { error: { code: "bad_request", message: "its subscription quota cannot be read with this credential" } } };
  const { api } = await fakeApi({ "GET /v1/whoami": { json: whoami() }, "POST /v1/accounts/register": refusal });
  const failed = await sgtWith({ signIn }, api, "account", "register", "claude", "--name", "claudeWork");
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("claudeWork was not registered.");
  expect(failed.err).toContain("`pbpaste | sgt account register claude --name claudeWork`");
  expect(failed.err).toContain("open https://claude.ai/new#settings/claude-code and, under Authorization tokens, delete the user:inference-scoped token `claude setup-token` made");
  expect(failed.out + failed.err).not.toContain("sk-ant-oat01-made");
  const codex = await sgtWith({ signIn }, api, "account", "register", "codex");
  expect(codex.err).toContain("codex was not registered. sgt deleted its copy of the Codex login and Sergeant stored none, so no copy of it is left: `sgt account register codex --name codex` signs in again.");
  expect(failed.err).toContain("https://claude.ai/new#settings/claude-code and, under Authorization tokens");
  // A piped credential is the person's own copy: nothing is stranded.
  expect((await sgtWith({ stdin: async () => "sk-ant-oat01-mine", signIn }, api, "account", "register", "claude")).err).not.toContain("pbpaste");
  await closeApi();

  // The person already has a claudeWork; the server stored the new token over it, but its answer did not
  // arrive whole. A listed claudeWork proves nothing, so sgt says to send the same token again, which
  // replaces whichever claudeWork is there, never to look at the list or to revoke first.
  const lost = await fakeApi({
    "GET /v1/whoami": { json: whoami() },
    "GET /v1/accounts": { json: { accounts: [{ id: "person:u1:claudeWork", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "claude-code-local", name: "claudeWork", mine: true, usage: { runs: 0, costUsd: 0, unknownCostRuns: 0 } }] } },
    "POST /v1/accounts/register": { json: { account: {} } },
  });
  const unknown = await sgtWith({ signIn }, lost.api, "account", "register", "claude", "--name", "claudeWork");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("sgt: unavailable: POST /v1/accounts/register answered outside the API contract");
  expect(unknown.err).toContain("sgt cannot tell whether claudeWork was registered. Once Sergeant answers, register the same token again");
  expect(unknown.err).toContain("`pbpaste | sgt account register claude --name claudeWork`");
  expect(unknown.err).not.toMatch(/sgt account list|was not registered/);
  const codexUnknown = await sgtWith({ signIn }, lost.api, "account", "register", "codex", "--name", "codexWork");
  expect(codexUnknown.err).toContain("Once Sergeant answers, `sgt account register codex --name codexWork` signs in again and replaces whatever codexWork holds. To not use it at all, `sgt account remove codexWork` and revoke it. To revoke a Codex login, open https://chatgpt.com/settings/security?view=sessions and log out the session its sign-in created");
});

// TECH-5198: removing an account passes on where to revoke it, since removal does not revoke a copy.
test("account remove prints the server's revoke reminder", async () => {
  const notice = "A run could have copied it, and removing it here does not revoke that copy. To revoke a Codex login, open https://chatgpt.com/settings/security?view=sessions and log out the session its sign-in created.";
  const { api, seen } = await fakeApi({ "POST /v1/accounts/remove": { json: { name: "codex", removed: true, notice } } });
  expect(await sgt(api, "account", "remove", "codex")).toMatchObject({ code: 0, out: expect.stringContaining(`removed your account codex. ${notice}`) });
  expect(seen.map((s) => [s.method, s.url, JSON.parse(s.body)])).toEqual([["POST", "/v1/accounts/remove", { name: "codex" }]]);
});

// TECH-5130: a three-word command, sending the person's Linear user id in the body.
test("admin account remove-person posts the user id and says what it removed", async () => {
  const { api, seen } = await fakeApi({
    "POST /v1/accounts/remove-person": { json: { userId: "u1", removed: [{ id: "person:u1:codex-local", adapter: "codex-local", holder: "Ada Example <ada@example.com>" }] } },
  });
  const done = await sgt(api, "admin", "account", "remove-person", "u1");
  expect(done).toMatchObject({ code: 0, out: expect.stringContaining("removed person:u1:codex-local (Ada Example <ada@example.com>)") });
  expect(seen.map((s) => [s.method, s.url, JSON.parse(s.body)])).toEqual([["POST", "/v1/accounts/remove-person", { userId: "u1" }]]);
  expect((await sgt(api, "admin", "account", "remove-person")).code).toBe(2);
  expect((await sgt(api, "admin", "account")).code).toBe(2);
});

import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { githubApp, runTokens } from "./app-auth.ts";

// The worker App token is the only GitHub credential a run gets. If minting dropped the repository
// or permission scope, a worker would hold every repository and permission the App was installed
// with (administration, if someone over-granted it), and a reviewer could push. Workflow write is
// deliberately present only on worker tokens so they can propose workflow changes.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** A fake GitHub whose worker installation grants `installed`; it records every token request. */
function fakeGitHub(installed: Record<string, string>) {
  const requests: { url: string; auth: string; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const auth = String(new Headers(init?.headers).get("authorization"));
    if (String(input) === "https://api.github.com/app/installations/7") return Response.json({ id: 7, permissions: installed });
    requests.push({ url: String(input), auth, body: JSON.parse(String(init?.body)) });
    return Response.json({ token: `ghs_${requests.length}`, expires_at: "2026-10-02T08:00:00Z", permissions: {} }, { status: 201 });
  };
  return { requests, app: githubApp({ appId: 42, installationId: 7, privateKey: pem, fetch }) };
}

const base = { contents: "write", pull_requests: "write", checks: "read", actions: "read", metadata: "read" };

test("run tokens are minted by the worker App for exactly the run's repositories and role", async () => {
  const { requests, app } = fakeGitHub({ ...base, workflows: "write" });
  const tokens = runTokens(app);

  expect(await tokens({ repositories: ["o/canary"], access: "write" })).toBe("ghs_1");
  await tokens({ repositories: ["o/canary"], access: "read" });

  expect(requests.map((r) => [r.url, r.body])).toEqual([
    ["https://api.github.com/app/installations/7/access_tokens", { repositories: ["canary"], permissions: { ...base, workflows: "write" } }],
    [
      "https://api.github.com/app/installations/7/access_tokens",
      { repositories: ["canary"], permissions: { contents: "read", pull_requests: "read", metadata: "read" } },
    ],
  ]);
  const [header = "", payload = "", signature = ""] = (requests[0]?.auth ?? "").replace(/^Bearer /, "").split(".");
  expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url")).toBe(true);
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "42" });
  await expect(tokens({ repositories: [], access: "write" })).rejects.toThrow(/at least one repository/);
});

// TECH-5797: the captain grants workflows:write after this ships, and an owner then accepts it. Until
// then, asking for it would make GitHub refuse every worker token, so a worker gets the token it got before.
test.each([
  ["has not accepted", base],
  ["holds only read on", { ...base, workflows: "read" }],
])("a worker token asks for no workflows permission while the installation %s workflows", async (_, installed) => {
  const { requests, app } = fakeGitHub(installed);
  await runTokens(app)({ repositories: ["o/canary"], access: "write" });
  expect(requests.map((r) => r.body)).toEqual([{ repositories: ["canary"], permissions: base }]);
});

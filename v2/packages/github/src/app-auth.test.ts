import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { githubApp, runTokens } from "./app-auth.ts";

// The worker App token is the only GitHub credential a run gets. If minting dropped the repository
// or permission scope, a worker would hold every repository and permission the App was installed
// with (workflows or administration, if someone over-granted it), and a reviewer could push.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

test("run tokens are minted by the worker App for exactly the run's repositories and role", async () => {
  const requests: { url: string; auth: string; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const auth = String(new Headers(init?.headers).get("authorization"));
    requests.push({ url: String(input), auth, body: JSON.parse(String(init?.body)) });
    return Response.json({ token: `ghs_${requests.length}`, expires_at: "2026-10-02T08:00:00Z", permissions: {} }, { status: 201 });
  };
  const app = githubApp({ appId: 42, installationId: 7, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetch });
  const tokens = runTokens(app);

  expect(await tokens({ repositories: ["o/canary"], access: "write" })).toBe("ghs_1");
  await tokens({ repositories: ["o/canary"], access: "read" });

  expect(requests.map((r) => [r.url, r.body])).toEqual([
    [
      "https://api.github.com/app/installations/7/access_tokens",
      {
        repositories: ["canary"],
        permissions: { contents: "write", pull_requests: "write", checks: "read", actions: "read", metadata: "read" },
      },
    ],
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

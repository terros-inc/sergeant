import { expect, test } from "vitest";
import { providerEmail, registeredLine } from "./register.ts";

// TECH-5215: the email `sgt account register` names is the provider login's own, read from the Codex
// id_token without trusting or echoing the rest of the credential; anything unreadable names none.

const jwt = (payload: unknown) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const authJson = (idToken: unknown) => JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: "secret-access", refresh_token: "secret-refresh" } });

test("providerEmail reads the Codex id_token's email and nothing for a bad, missing, or Claude credential", () => {
  expect(providerEmail("codex", authJson(jwt({ email: "ada.personal@example.org", sub: "x" })))).toBe("ada.personal@example.org");
  for (const bad of [
    authJson(undefined),
    authJson(42),
    authJson("not-a-jwt"),
    authJson("a.!!!.c"),
    authJson(`a.${Buffer.from("not json").toString("base64url")}.c`),
    authJson(jwt({ sub: "no email" })),
    authJson(jwt({ email: 7 })),
    authJson(jwt({ email: "ada@example.org\u001b]0;evil\u0007" })),
    "{not json",
    '{"tokens":null}',
  ]) {
    expect(providerEmail("codex", bad)).toBeUndefined();
  }
  expect(providerEmail("claude", "sk-ant-oat01-secret")).toBeUndefined();
});

test("registeredLine names the provider account, with its email only when there is one", () => {
  expect(registeredLine("registered", "codexPersonal", "codex", "ada.personal@example.org", "96% weekly left, 5-hour unknown")).toBe(
    "registered codexPersonal: ChatGPT account ada.personal@example.org, 96% weekly left, 5-hour unknown.",
  );
  expect(registeredLine("replaced", "claude", "claude", undefined, "50% weekly left, 80% 5-hour left")).toBe("replaced claude: Claude account, 50% weekly left, 80% 5-hour left.");
});

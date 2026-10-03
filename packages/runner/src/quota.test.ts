import { expect, test } from "vitest";
import { providerQuota, QUOTA_CACHE_MS } from "./quota.ts";

const CLAUDE = "sk-ant-oat01-quota-test";
const CODEX = JSON.stringify({ tokens: { access_token: "codex-access-test", account_id: "acct-1" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

// The readings are what the chooser compares; a misread field (used read as left, the weekly window
// read as the 5-hour one) would send work to the exhausted provider.
test("reads Claude's and Codex's weekly and 5-hour percent left, with their resets", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.includes("anthropic")
      ? json({ five_hour: { utilization: 81, resets_at: "2026-10-03T15:00:00+00:00" }, seven_day: { utilization: 17, resets_at: null } })
      : json({
          rate_limit: {
            primary_window: { used_percent: 57, limit_window_seconds: 604_800, reset_at: 1_791_000_000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_790_000_000 },
          },
        }),
  );
  const read = providerQuota({ claudeOAuthToken: CLAUDE, codexCredential: CODEX, fetch });

  expect(await read("claude-code-local")).toMatchObject({
    weekly: { remainingPercent: 83 },
    fiveHour: { remainingPercent: 19, resetsAt: "2026-10-03T15:00:00.000Z" },
  });
  expect(await read("codex-local")).toMatchObject({
    weekly: { remainingPercent: 43, resetsAt: new Date(1_791_000_000_000).toISOString() },
    fiveHour: { remainingPercent: 88 },
  });
  expect(calls.find((c) => c.url.includes("chatgpt"))?.headers).toMatchObject({ Authorization: "Bearer codex-access-test", "ChatGPT-Account-Id": "acct-1" });
});

// `claude setup-token` tokens may only run inference, and the usage endpoint refuses them; the
// limits then come from the headers every Messages response carries.
test("a Claude token the usage endpoint refuses is read from the Messages rate-limit headers", async () => {
  const { fetch } = fakeFetch((url) =>
    url.endsWith("/usage")
      ? json({ error: { type: "permission_error" } }, 403)
      : new Response("{}", {
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.25",
            "anthropic-ratelimit-unified-5h-reset": "1790000000",
            "anthropic-ratelimit-unified-7d-utilization": "0.6",
          },
        }),
  );
  expect(await providerQuota({ claudeOAuthToken: CLAUDE, codexCredential: CODEX, fetch })("claude-code-local")).toMatchObject({
    weekly: { remainingPercent: 40 },
    fiveHour: { remainingPercent: 75, resetsAt: new Date(1_790_000_000_000).toISOString() },
  });
});

// A failed read is an unknown reading, never a thrown launch, and it is stored on the run record, so
// it must not quote the credential it failed to parse.
test("a failed read is unknown, never throws, and never records the credential", async () => {
  const down = fakeFetch(() => json({}, 500)).fetch;
  const broken = "{ not json sk-ant-oat01-secret";
  const read = providerQuota({ claudeOAuthToken: CLAUDE, codexCredential: broken, fetch: down });
  expect(await read("claude-code-local")).toMatchObject({ error: "usage endpoint answered 500" });
  const codex = await read("codex-local");
  expect(codex.weekly).toBeUndefined();
  expect(JSON.stringify(codex)).not.toContain("secret");
  expect(await providerQuota({ claudeOAuthToken: CLAUDE, codexCredential: "sk-proj-key", fetch: down })("codex-local")).toMatchObject({
    error: "an OpenAI API key has no subscription quota",
  });
});

test("a burst of launches shares one reading until it is a few minutes old", async () => {
  let clock = 0;
  const { fetch, calls } = fakeFetch(() => json({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }));
  const read = providerQuota({ claudeOAuthToken: CLAUDE, codexCredential: CODEX, fetch, now: () => clock });
  await Promise.all([read("claude-code-local"), read("claude-code-local")]);
  clock += QUOTA_CACHE_MS - 1;
  await read("claude-code-local");
  expect(calls).toHaveLength(1);
  clock += 1;
  await read("claude-code-local");
  expect(calls).toHaveLength(2);
});

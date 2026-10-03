import { expect, test } from "vitest";
import { accountQuota, QUOTA_CACHE_MS, type QuotaAccount } from "./quota.ts";

const CLAUDE = "sk-ant-oat01-quota-test";
const CODEX = JSON.stringify({ tokens: { access_token: "codex-access-test", account_id: "acct-1" } });
const claude = (credential = CLAUDE): QuotaAccount => ({ id: "terros-claude", adapter: "claude-code-local", credential });
const codex = (credential = CODEX): QuotaAccount => ({ id: "terros-codex", adapter: "codex-local", credential });
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
      ? json({ five_hour: { utilization: 80.4, resets_at: "2026-10-03T15:00:00+00:00" }, seven_day: { utilization: 17, resets_at: null } })
      : json({
          rate_limit: {
            primary_window: { used_percent: 57, limit_window_seconds: 604_800, reset_at: 1_791_000_000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_790_000_000 },
          },
        }),
  );
  const read = accountQuota({ fetch });

  expect(await read(claude())).toMatchObject({
    source: "usage-endpoint",
    weekly: { remainingPercent: 83 },
    // Unrounded: 80.4% used is 19.6% left, below the 20% floor, never rounded up to it.
    fiveHour: { remainingPercent: 19.6, resetsAt: "2026-10-03T15:00:00.000Z" },
  });
  expect(await read(codex())).toMatchObject({
    weekly: { remainingPercent: 43, resetsAt: new Date(1_791_000_000_000).toISOString() },
    fiveHour: { remainingPercent: 88 },
  });
  expect(calls.find((c) => c.url.includes("chatgpt"))?.headers).toMatchObject({ Authorization: "Bearer codex-access-test", "ChatGPT-Account-Id": "acct-1" });
});

// `claude setup-token` tokens may only run inference, and the usage endpoint refuses them; the
// limits then come from the headers every Messages response carries.
test("a Claude 429 is read from the Messages rate-limit headers and records its source", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.endsWith("/usage")
      ? json({ error: { type: "rate_limit_error" } }, 429)
      : new Response("{}", {
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.8",
            "anthropic-ratelimit-unified-5h-reset": "1790000000",
            "anthropic-ratelimit-unified-7d-utilization": "0.6",
          },
        }),
  );
  expect(await accountQuota({ fetch })(claude())).toMatchObject({
    source: "header-fallback",
    weekly: { remainingPercent: 40 },
    fiveHour: { remainingPercent: 20, resetsAt: new Date(1_790_000_000_000).toISOString() },
  });
  expect(calls.map(({ url }) => url)).toEqual(["https://api.anthropic.com/api/oauth/usage", "https://api.anthropic.com/v1/messages"]);
});

// A failed read is an unknown reading, never a thrown launch, and it is stored on the run record, so
// it must not quote the credential it failed to parse.
test("a failed read is unknown, never throws, and never records the credential", async () => {
  const down = fakeFetch(() => json({}, 500)).fetch;
  const broken = "{ not json sk-ant-oat01-secret";
  const read = accountQuota({ fetch: down });
  expect(await read(claude())).toMatchObject({
    account: "terros-claude",
    error: "usage endpoint answered 500; header fallback answered 500 without limits",
  });
  const unreadable = await read(codex(broken));
  expect(unreadable.weekly).toBeUndefined();
  expect(JSON.stringify(unreadable)).not.toContain("secret");
  expect(await read(codex("sk-proj-key"))).toMatchObject({
    error: "an OpenAI API key has no subscription quota",
  });
});

test("a burst of launches shares one reading until it is a few minutes old", async () => {
  let clock = 0;
  const { fetch, calls } = fakeFetch(() => json({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }));
  const read = accountQuota({ fetch, now: () => clock });
  await Promise.all([read(claude()), read(claude())]);
  clock += QUOTA_CACHE_MS - 1;
  await read(claude());
  expect(calls).toHaveLength(1);
  // A replaced credential is read afresh, not served the old one's reading.
  await read(claude("sk-ant-oat01-replaced"));
  expect(calls).toHaveLength(2);
  clock += 1;
  await read(claude());
  expect(calls).toHaveLength(3);
});

import { expect, test } from "vitest";
import { fakeApi, sgt, sgtWith } from "./fake-api.ts";

// TECH-5195: `sgt admin update` hands the host its request and waits out serve's restart for the outcome,
// so nobody polls the host; a failed outcome says why and exits 1.
test("admin update waits through serve's restart for the host's outcome, and a failed one exits 1", async () => {
  const request = { id: "req-1", action: "update", ref: "v2.1.0", by: "Grace Example <grace@example.com>", at: "2026-10-04T10:00:00.700Z" };
  // The host's outcome when the request was made: an automatic update that finished earlier.
  const before = { action: "automatic", by: "the release channel (main)", outcome: "succeeded", message: "updated zzz to aaa", startedAt: "2026-10-04T09:50:00Z" };
  const running = { id: "req-1", action: "update", ref: "v2.1.0", by: request.by, outcome: "running", message: "updating aaa to bbb", startedAt: "2026-10-04T10:00:05Z" };
  const status = (last: object | null, pending: object | null = null, config: object | null = null) => ({
    json: { serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T09:00:00.000Z" }, release: null, pending, last, config },
  });
  let statuses: { status?: number; json?: unknown; text?: string }[] = [];
  const { api, seen } = await fakeApi({
    "POST /v1/admin/update": { json: { request, last: before } },
    get "GET /v1/admin/status"() {
      return statuses.shift() ?? { status: 500, text: "read too often" };
    },
  });
  const noWait = { sleep: async () => {} };

  statuses = [status(before, request), status(running), { status: 502, text: "bad gateway" }, status({ ...running, outcome: "succeeded", message: "updated aaa to bbb" })];
  const done = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(done).toEqual({
    code: 0,
    out: "succeeded: updated aaa to bbb\n",
    err: "update to v2.1.0 requested (req-1); waiting for the host\nwaiting for the host to take it\nrunning: updating aaa to bbb\nserve is restarting\n",
  });
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ ref: "v2.1.0" });

  statuses = [status({ ...running, outcome: "failed", message: "update to bbb failed; reinstalled aaa", output: "serve is not healthy at /health" })];
  const failed = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(failed.code).toBe(1);
  expect(failed.out).toBe("failed: update to bbb failed; reinstalled aaa\n\nlast lines of the update's output:\nserve is not healthy at /health\n");
  expect((await sgt(api, "admin", "update", "a", "b")).code).toBe(2);

  // An automatic update replaced the outcome before sgt read it, even one the host stamped in the same
  // second as the request (its whole-second startedAt is before the request's): say so, never wait it out.
  statuses = [status(before, request), status({ ...before, outcome: "running", message: "updating bbb to ccc", startedAt: "2026-10-04T10:00:00Z" })];
  const replaced = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(replaced.code).toBe(1);
  expect(replaced.err).toContain("sgt: conflict: the host took your update (req-1), but automatic by the release channel (main) replaced its outcome before sgt read it");
  expect(statuses).toEqual([]);

  // TECH-5205: nothing newer to install, but the installation config changed since serve started.
  const unchanged = { ...running, outcome: "unchanged", message: "up to date at aaa (requested by Grace Example <grace@example.com>)" };
  statuses = [status(unchanged, null, { loaded: 3, current: 4 }), status(unchanged, null, { loaded: 3, current: 4 })];
  const stale = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(stale).toMatchObject({ code: 0, out: `unchanged: ${unchanged.message}\nversion 4 in AWS, but serve has version 3: the installation config changed since serve started, so run \`sgt admin restart\` to reread it\n` });
  statuses = [status(unchanged, null, { loaded: 4, current: 4 }), status(unchanged, null, { loaded: 4, current: 4 })];
  expect((await sgtWith(noWait, api, "admin", "update", "v2.1.0")).out).toBe(`unchanged: ${unchanged.message}\n`);

  // TECH-5209: a serve older than TECH-5205 sends no config; this sgt still reads its outcome rather than waiting 45 minutes.
  const { config: _, ...old } = status(unchanged).json;
  statuses = [{ json: old }, { json: old }];
  expect(await sgtWith(noWait, api, "admin", "update", "v2.1.0")).toMatchObject({ code: 0, out: `unchanged: ${unchanged.message}\n` });
});

test("admin status says when the installation config changed since serve started", async () => {
  const status = (config: object | null) => ({ json: { serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T09:00:00.000Z" }, release: null, pending: null, last: null, config } });
  let next: { json: object } = status({ loaded: 3, current: 4 });
  const { api } = await fakeApi({
    get "GET /v1/admin/status"() {
      return next;
    },
  });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4 in AWS, but serve has version 3: the installation config changed since serve started, so run `sgt admin restart` to reread it");
  next = status({ loaded: 4, current: 4 });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4, as serve has it\n");
  // TECH-5229: the runs directory's size and the data volume's free space, so growth is visible.
  next = { json: { ...status(null).json, runs: { count: 447, bytes: 46e9, volumeFreeBytes: 48.4e9, volumeBytes: 98e9 } } };
  expect((await sgt(api, "admin", "status")).out).toContain("runs     447 in 46.0 GB; data volume 48.4 GB free of 98.0 GB\n");
  // TECH-5336: the GitHub API budget and a rate-limit pause, so an operator sees why GitHub work waits.
  const github = { limit: 5000, remaining: 0, resetAt: "2026-10-04T10:30:00.000Z", observedAt: "2026-10-04T10:05:00.000Z", pausedUntil: "2026-10-04T10:30:00.000Z" };
  next = { json: { ...status(null).json, github } };
  expect((await sgt(api, "admin", "status")).out).toContain(
    "github   0 of 5000 API calls left, resets 2026-10-04T10:30:00.000Z (as of 2026-10-04T10:05:00.000Z); rate limited, no GitHub calls until 2026-10-04T10:30:00.000Z\n",
  );
  next = status({ loaded: 4, current: null });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4; serve cannot read the parameter now");
  next = status(null);
  expect((await sgt(api, "admin", "status")).out).not.toContain("config");
  // TECH-5209: a serve older than TECH-5205 sends no config at all.
  const { config: _, ...old } = status(null).json;
  next = { json: old };
  const older = await sgt(api, "admin", "status");
  expect(older).toMatchObject({ code: 0, err: "" });
  expect(older.out).toContain("last     no restart or update recorded");
  expect(older.out).not.toContain("config");
  expect(older.out).not.toContain("runs");
});

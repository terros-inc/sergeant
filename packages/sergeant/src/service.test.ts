import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, PullRequestFacts } from "@terros/sergeant-contracts";
import { startService, type ServiceDeps } from "./service.ts";

// The service must make progress with nobody waking a task: every delegated issue gets its turns
// without exceeding the task limit, a failed poll is retried rather than ending the service, and a
// restarted process rereads each task and takes a new turn only where Linear changed.

const agent = { id: "agent-v2", name: "Sergeant" };
const issues = ["UNF-1", "UNF-2", "UNF-3"];
/** An open Todo issue with no priority, as intake lists it. */
const todo = (identifier: string) => ({ identifier, priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] });

let dir = "";
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

test("works every delegated issue unattended within the task limit, and resumes after a restart", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const live = new Map<string, Conversation>(
    issues.map((id) => [
      id,
      {
        issue: { id: `i-${id}`, identifier: id, url: `https://linear.app/x/issue/${id}`, title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: agent, linkedPullRequests: [] },
        humanComments: [],
        agentComments: [],
      },
    ]),
  );
  const turns: { issue: string; comments: number }[] = [];
  const logs: string[] = [];
  let inTurn = 0;
  let maxInTurn = 0;
  let intakeFailures = 1;
  let readFailures = 1;

  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => {
      if (intakeFailures-- > 0) throw new Error("Linear is down");
      return issues.map(todo);
    },
    linear: {
      readConversation: async (id) => {
        if (id === "UNF-2" && readFailures-- > 0) throw new Error("Linear timed out");
        return live.get(id) ?? Promise.reject(new Error(`no ${id}`));
      },
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async () => {},
      createFollowupIssue: async () => ({ identifier: "UNF-9", url: "https://linear.app/x/issue/UNF-9" }),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
    reasoner: {
      async turn(situation) {
        maxInTurn = Math.max(maxInTurn, ++inTurn);
        await sleep(20);
        inTurn--;
        turns.push({ issue: situation.conversation.issue.identifier, comments: situation.conversation.humanComments.length });
        return { output: { summary: "nothing to do yet", actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  const start = () =>
    startService(
      { enrolledRepositories: ["o/r"], stateDir: dir, maxTasks: 2, intakeSeconds: 0.01, pollSeconds: 0, idleMinutes: 0, port: 0, log: (l) => logs.push(l) },
      deps,
    );

  const first = await start();
  await vi.waitFor(() => expect(new Set(turns.map((t) => t.issue))).toEqual(new Set(issues)), { timeout: 5_000 });
  const status = await fetch(`http://127.0.0.1:${first.port}/status`);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ ok: true, version: expect.stringMatching(/^\d+\.\d+\.\d+\+/), lastIntake: { at: expect.any(String) } });
  await first.stop();

  // Three tasks admitted together would overlap in their first turns; only two may run at once.
  expect(maxInTurn).toBe(2);
  // Each issue got exactly one turn: an unchanged task readmitted on a later intake takes none.
  expect(turns.map((t) => t.issue).sort()).toEqual(issues);
  expect(logs).toContainEqual(expect.stringContaining("intake failed, retrying next interval: Linear is down"));
  expect(logs).toContainEqual(expect.stringContaining("UNF-2: loop failed, retrying on a later intake: Linear timed out"));

  // A human comments while the process is down; the restarted process rereads every task and takes a
  // turn only for the one that changed.
  const unf1 = live.get("UNF-1");
  if (!unf1) throw new Error("unreachable");
  live.set("UNF-1", { ...unf1, humanComments: [{ id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Also update the README." }] });
  const second = await start();
  await vi.waitFor(() => expect(turns).toHaveLength(4), { timeout: 5_000 });
  await sleep(100);
  await second.stop();
  expect(turns.slice(3)).toEqual([{ issue: "UNF-1", comments: 1 }]);
});

/** Fakes for one delegated issue whose turns hold for `turnMs`, counting turns in flight. */
function oneIssue(ids: string[], turnMs: number) {
  const conversation: Conversation = {
    issue: { id: "i-UNF-1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: agent, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  };
  const counts = { turns: 0, inTurn: 0, maxInTurn: 0 };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => ids.map(todo),
    linear: { readConversation: async () => conversation, postComment: async () => {}, createFollowupIssue: async () => Promise.reject(new Error("unused")), moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
    reasoner: {
      async turn() {
        counts.turns++;
        counts.maxInTurn = Math.max(counts.maxInTurn, ++counts.inTurn);
        await sleep(turnMs);
        counts.inTurn--;
        return { output: { summary: "nothing to do yet", actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, counts };
}

const options = () => ({ enrolledRepositories: ["o/r" as const], stateDir: dir, maxTasks: 2, intakeSeconds: 0.01, pollSeconds: 0, idleMinutes: 60, log: () => {} });

test("an issue listed twice in one intake still runs one turn at a time", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const { deps, counts } = oneIssue(["UNF-1", "UNF-1"], 50);
  const service = await startService(options(), deps);
  await vi.waitFor(() => expect(counts.turns).toBe(1), { timeout: 5_000 });
  await sleep(100);
  await service.stop();
  expect(counts).toMatchObject({ turns: 1, maxInTurn: 1 });
});

test("a second service on the same state directory is refused until the first stops", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const { deps, counts } = oneIssue(["UNF-1"], 50);
  const first = await startService(options(), deps);
  await expect(startService(options(), deps)).rejects.toThrow(`(pid ${process.pid}) already serves`);
  await vi.waitFor(() => expect(counts.turns).toBe(1), { timeout: 5_000 });
  await first.stop();
  expect(counts.maxInTurn).toBe(1);
  await (await startService(options(), deps)).stop();
});

// The host publishes `/health` to the internet; it must not name a task or carry an intake error.
test("public /health says only whether serve is healthy; task ids and intake errors stay on /status", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const { deps, counts } = oneIssue(["UNF-1"], 0);
  let failing = false;
  const delegatedIssues = async () => {
    if (failing) throw new Error("Linear refused UNF-1's team");
    return [todo("UNF-1")];
  };
  const service = await startService({ ...options(), port: 0 }, { ...deps, delegatedIssues });
  const get = (path: string) => fetch(`http://127.0.0.1:${service.port}${path}`);
  await vi.waitFor(() => expect(counts.turns).toBe(1), { timeout: 5_000 });
  const healthy = await get("/health");
  expect([healthy.status, await healthy.text()]).toEqual([200, '{"ok":true}']);

  failing = true;
  await vi.waitFor(async () => expect((await get("/health")).status).toBe(503), { timeout: 5_000 });
  expect(await (await get("/health")).text()).toBe('{"ok":false}');
  expect(await (await get("/status")).json()).toMatchObject({ ok: false, tasks: ["UNF-1"], lastIntake: { error: "Linear refused UNF-1's team" } });
  await service.stop();
});

// TECH-4968: the installation's `review.auditSampleRate` (serve.ts) must reach every task loop, not
// only the canary's; omitted, the loop's default rate applies. A task resumed just after its merge
// draws the audit at once; a stable hash of the head decides, at 0.2 drawing head 5… but not head a….
test("each task loop audits merged heads at the service's audit sample rate, or the default without one", async () => {
  const audited = async (headSha: string, auditSampleRate?: number) => {
    dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
    const taskDir = join(dir, "tasks", "UNF-1");
    await mkdir(taskDir, { recursive: true });
    const at = new Date().toISOString();
    const merged = { repo: "o/r", number: 7, headSha, mergedSha: "c".repeat(40), at, outcomePostedAt: at };
    await writeFile(join(taskDir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: at, turns: 1, runIds: [], recentTurns: [], merged, owner: { id: "user-ann", name: "Ann", admittedAt: at } }));
    const { deps } = oneIssue(["UNF-1"], 0);
    const started: string[] = [];
    const pr: PullRequestFacts = { repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", state: "merged", draft: false, author: "sergeant-worker[bot]", headSha, mergedSha: merged.mergedSha, baseRef: "main", body: "Fixes UNF-1", mergeable: null, checks: { sha: headSha, required: [] }, humanFeedback: [] };
    const runner: ServiceDeps["runner"] = {
      start: async (spec) => void started.push(spec.runId),
      status: async (runId) => ({ runId, role: "reviewer", status: "running", provider: "anthropic/claude-code", model: "opus", report: null }),
      cancel: async () => {},
    };
    const service = await startService({ ...options(), ...(auditSampleRate !== undefined && { auditSampleRate }) }, { ...deps, runner, github: { ...deps.github, readPullRequest: async () => pr } });
    const drawn = async () => JSON.parse(await readFile(join(taskDir, "state.json"), "utf8")).merged.auditDrawnAt;
    await vi.waitFor(async () => expect(await drawn()).toBeDefined(), { timeout: 5_000 });
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    return started;
  };
  const [drawnAtDefault, notDrawnAtDefault] = ["5".repeat(40), "a".repeat(40)];

  expect(await audited(drawnAtDefault)).toEqual([`run_audit-${drawnAtDefault}`]);
  expect(await audited(drawnAtDefault, 0)).toEqual([]);
  expect(await audited(notDrawnAtDefault)).toEqual([]);
  expect(await audited(notDrawnAtDefault, 1)).toEqual([`run_audit-${notDrawnAtDefault}`]);
});

// Separate processes started together, each holding the service if it gets it: exactly one does,
// both on a fresh state directory and on one a killed holder left its lock files in.
test("of processes racing for one state directory, exactly one serves it, even over a killed holder's lock", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const script = `
    import { existsSync } from "node:fs";
    import { setTimeout as sleep } from "node:timers/promises";
    import { startService } from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};
    const [stateDir, go] = process.argv.slice(1);
    while (!existsSync(go)) await sleep(5);
    await startService({ enrolledRepositories: [], stateDir, intakeSeconds: 3600, log: () => {} }, { delegatedIssues: async () => [] }).then(
      () => console.log("serving"),
      (e) => (console.log("refused", e.message), process.exit(0)),
    );
    setInterval(() => {}, 1000);`;
  const race = async (n: number, go: string) => {
    const racers = Array.from({ length: n }, () => spawn(process.execPath, ["--input-type=module", "-e", script, dir, go]));
    children.push(...racers);
    const said = racers.map((c) => new Promise<string>((resolve) => c.stdout.once("data", (d: Buffer) => resolve(d.toString()))));
    await writeFile(go, "");
    const lines = await Promise.all(said);
    return { serving: racers.filter((_, i) => lines[i]!.startsWith("serving")), lines };
  };

  const fresh = await race(16, join(dir, "go-1"));
  expect(fresh.serving, fresh.lines.join("")).toHaveLength(1);
  const killed = new Promise((resolve) => fresh.serving[0]!.once("exit", resolve));
  fresh.serving[0]!.kill("SIGKILL");
  await killed;

  const afterCrash = await race(16, join(dir, "go-2"));
  expect(afterCrash.lines.join("")).toMatch(/refused/);
  expect(afterCrash.serving, afterCrash.lines.join("")).toHaveLength(1);
}, 30_000);

/** GETs `path` from `connect` (the address the peer reaches serve on) with `headers`. */
function get(connect: string, port: number | undefined, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: connect, port, path, headers }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

// TECH-4951: `/status` names tasks and intake errors, so it must refuse, as `/v1` does, any caller
// not on this host even when a proxy or a bind address publishes it: a request relayed by a proxy
// (which connects from loopback), a DNS-rebound page naming another Host, or a peer elsewhere.
const unauthorized = { status: 401, json: { error: { code: "unauthorized", message: expect.any(String) } } };

test("/status answers a caller on this host and refuses a proxied request or a foreign Host", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const { deps, counts } = oneIssue(["UNF-1"], 0);
  const service = await startService({ ...options(), port: 0 }, deps);
  await vi.waitFor(() => expect(counts.turns).toBe(1), { timeout: 5_000 });
  expect(await get("127.0.0.1", service.port, "/status")).toMatchObject({ status: 200, json: { tasks: ["UNF-1"] } });
  expect(await get("127.0.0.1", service.port, "/status", { "X-Forwarded-For": "203.0.113.9" })).toMatchObject(unauthorized);
  expect(await get("127.0.0.1", service.port, "/status", { Forwarded: "for=203.0.113.9" })).toMatchObject(unauthorized);
  expect(await get("127.0.0.1", service.port, "/status", { Host: "sergeant.example.com" })).toMatchObject(unauthorized);
  // `/health` is public and unchanged.
  expect(await get("127.0.0.1", service.port, "/health", { "X-Forwarded-For": "203.0.113.9" })).toEqual({ status: 200, json: { ok: true } });
  await service.stop();
});

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;

test.skipIf(!lanAddress)("/status refuses a peer that is not loopback, while /health answers it", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-test-"));
  const { deps } = oneIssue([], 0);
  const service = await startService({ ...options(), port: 0, host: "0.0.0.0" }, deps);
  const hostHeader = { Host: `127.0.0.1:${service.port}` };
  expect(await get(lanAddress ?? "", service.port, "/status", hostHeader)).toMatchObject(unauthorized);
  expect((await get(lanAddress ?? "", service.port, "/health", hostHeader)).status).toBe(200);
  expect((await get("127.0.0.1", service.port, "/status")).status).toBe(200);
  await service.stop();
});

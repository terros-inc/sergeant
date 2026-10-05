import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION, type RepoSlug } from "@terros/sergeant-contracts";
import type { InstallationToken } from "@terros/sergeant-github";
import { apiHandler, type ApiControl } from "./api.ts";
import type { Caller } from "./auth.ts";
import { InstallationConfig } from "./config.ts";
import { appsReach, configParameter, enrolledIn, EnrollmentRefused, enrollment, VERSION_MS } from "./enrollment.ts";

// TECH-5193: an approver enrolls and removes repositories with their Linear login. The parameter is
// the only record, so it gets the change first and only its `repositories`; the running service
// follows, a retry repairs a change whose answer was lost, nobody else can change it, and no other
// setting ever reaches an answer or a log.

const callers: Record<string, Caller> = {
  ada: { kind: "linear", user: { id: "u-ada", name: "Ada Example", email: "ada@example.com" }, approver: false },
  grace: { kind: "linear", user: { id: "u-grace", name: "Grace Example", email: "grace@example.com" }, approver: true },
};

const CONFIG = {
  secrets: { awsRegion: "us-west-2" },
  linear: { tokenSecret: "sergeant/x/linear", agentUserId: "agent" },
  github: {
    controlPlaneApp: { appId: 1, installationId: 11, privateKeySecret: "sergeant/x/cp" },
    workerApp: { appId: 2, installationId: 22, privateKeySecret: "sergeant/x/worker" },
  },
  repositories: { "terros-inc/one": { mergeMethod: "squash" } },
  modelTokenSecret: "sergeant/x/model",
  gitIdentity: { name: "Example Human", email: "human@example.com" },
  humans: { linearClientId: "client", teams: ["ENG"], approvers: ["u-grace"] },
  budget: { usd: 10 },
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

/** How the fake parameter's write ends: `ok`; `fails`, writing nothing; or `lost`, written but its answer lost. */
type Write = "ok" | "fails" | "lost";

async function serve(opts: { writable?: boolean; write?: () => Write } = {}) {
  const parameter = {
    value: JSON.stringify(CONFIG),
    version: 1,
    descriptions: [] as string[],
    read: async () => ({ value: parameter.value, version: parameter.version }),
    write: async (value: string, description: string) => {
      const outcome = opts.write?.() ?? "ok";
      if (outcome !== "fails") {
        parameter.value = value;
        parameter.version += 1;
        parameter.descriptions.push(description);
      }
      if (outcome === "ok") return parameter.version;
      // As execFile rejects: its message quotes the command line, which must never be shown.
      throw Object.assign(new Error(`Command failed: aws ssm put-parameter --value ${value}`), {
        stderr: outcome === "fails" ? "\nAn error occurred (AccessDeniedException) when calling the PutParameter operation\n" : "Read timeout on endpoint URL",
      });
    },
  };
  const repositories: RepoSlug[] = ["terros-inc/one"];
  const configs: Record<string, { mergeMethod: "merge" | "squash" | "rebase"; observedChecksFallback: boolean }> = {
    "terros-inc/one": { mergeMethod: "squash", observedChecksFallback: false },
  };
  const logs: string[] = [];
  const clock = { ms: 0 };
  const enrolled = enrollment({
    repositories,
    configs,
    parameter: opts.writable === false ? undefined : parameter,
    version: parameter.version,
    // GitHub's own name for the repository; `unreachable` is on no installation.
    reach: async (repo) => (repo.includes("unreachable") ? Promise.reject(new EnrollmentRefused(`the worker GitHub App cannot reach ${repo}`)) : (repo.toLowerCase() as RepoSlug)),
    log: (line) => logs.push(line),
    now: () => clock.ms,
  });
  const ctl = {
    stateDir: "/nonexistent",
    enrolledRepositories: repositories,
    log: (line: string) => logs.push(line),
    loop: () => undefined,
    known: () => [],
    callerOf: async (token: string) => callers[token] ?? Promise.reject(new Error("unknown")),
    enrollment: enrolled,
  } as unknown as ApiControl;
  server = createServer(apiHandler(ctl));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, as: string, body?: unknown) =>
    new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
      const headers = { [CLI_VERSION_HEADER]: MIN_CLI_VERSION, Authorization: `Bearer ${as}`, ...(body !== undefined && { "Content-Type": "application/json" }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { call, parameter, repositories, configs, logs, enrolled, clock };
}

test("an approver's add and remove change only the parameter's repositories, then the live list", async () => {
  const { call, parameter, repositories, configs, logs } = await serve();

  const added = await call("POST", "/v1/repositories/add", "grace", { repo: "Terros-Inc/Two", mergeMethod: "rebase" });
  expect(added).toMatchObject({ status: 200, json: { repo: "terros-inc/two", changed: true, repositories: ["terros-inc/one", "terros-inc/two"] } });
  // Exactly the parameter as it was, plus the one repository, never Zod's defaults or anything else.
  expect(JSON.parse(parameter.value)).toEqual({ ...CONFIG, repositories: { ...CONFIG.repositories, "terros-inc/two": { mergeMethod: "rebase" } } });
  expect(parameter.descriptions).toEqual(["Grace Example enrolled terros-inc/two (rebase)"]);
  // The same array and record every holder (loops, webhooks, the GitHub port) reads.
  expect(repositories).toEqual(["terros-inc/one", "terros-inc/two"]);
  expect(configs["terros-inc/two"]).toEqual({ mergeMethod: "rebase", observedChecksFallback: false });
  expect(logs).toContain("Grace Example enrolled terros-inc/two (rebase): the installation-config parameter and the running service have it");

  // Everyone signed in may list; nobody but an approver may change.
  expect(await call("GET", "/v1/repositories", "ada")).toMatchObject({ status: 200, json: { repositories: [{ repo: "terros-inc/one", mergeMethod: "squash" }, { repo: "terros-inc/two", mergeMethod: "rebase" }] } });
  expect(await call("POST", "/v1/repositories/remove", "ada", { repo: "terros-inc/one" })).toMatchObject({ status: 403 });

  // Unreachable or malformed: refused. Already enrolled under another case: nothing to write.
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/unreachable" })).toMatchObject({ status: 400 });
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "not a slug" })).toMatchObject({ status: 400 });
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/ONE" })).toMatchObject({ status: 200, json: { repo: "terros-inc/one", changed: false } });
  expect(parameter.descriptions).toHaveLength(1);

  expect(await call("POST", "/v1/repositories/remove", "grace", { repo: "TERROS-INC/one" })).toMatchObject({ status: 200, json: { repo: "terros-inc/one", changed: true, repositories: ["terros-inc/two"] } });
  expect(Object.keys(JSON.parse(parameter.value).repositories)).toEqual(["terros-inc/two"]);
  expect([repositories, Object.keys(configs)]).toEqual([["terros-inc/two"], ["terros-inc/two"]]);
  expect(parameter.descriptions.at(-1)).toBe("Grace Example removed terros-inc/one");
  expect(await call("POST", "/v1/repositories/remove", "grace", { repo: "terros-inc/one" })).toMatchObject({ status: 200, json: { changed: false } });
});

test("a failed write changes nothing live and shows no other setting in the answer or the log", async () => {
  const { call, parameter, repositories, logs } = await serve({ write: () => "fails" });
  const failed = await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" });
  expect(failed).toMatchObject({ status: 503, json: { error: { message: expect.stringContaining("could not confirm its write of the installation-config parameter (serve.log says why): retry") } } });
  expect(logs).toContain("could not write the installation-config parameter: An error occurred (AccessDeniedException) when calling the PutParameter operation");
  for (const shown of [failed.text, ...logs]) {
    for (const hidden of ["sergeant/x/", "budget", "u-grace", "human@example.com"]) expect(shown).not.toContain(hidden);
  }
  expect([repositories, JSON.parse(parameter.value)]).toEqual([["terros-inc/one"], CONFIG]);
});

test("a retry after a write whose answer was lost brings the running list up to the parameter, and so does a restart", async () => {
  let write: Write = "lost";
  const { call, parameter, repositories } = await serve({ write: () => write });
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" })).toMatchObject({ status: 503 });
  expect(repositories).toEqual(["terros-inc/one"]);
  // A restart now starts with the parameter's list, not the host's older copy.
  expect(Object.keys((await enrolledIn(parameter, () => {})).repositories)).toEqual(["terros-inc/one", "terros-inc/two"]);

  write = "ok";
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" })).toMatchObject({ status: 200, json: { changed: false, repositories: ["terros-inc/one", "terros-inc/two"] } });
  expect(repositories).toEqual(["terros-inc/one", "terros-inc/two"]);
  expect(parameter.descriptions).toHaveLength(1);
});

test("without the parameter, serve lists but cannot change the enrolled repositories", async () => {
  const { call, repositories } = await serve({ writable: false });
  expect(await call("GET", "/v1/repositories", "ada")).toMatchObject({ status: 200 });
  expect(await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" })).toMatchObject({ status: 400, json: { error: { message: expect.stringContaining("--config-parameter") } } });
  expect(repositories).toEqual(["terros-inc/one"]);
});

test("a repository is reachable only when both Apps' installations hold it under its own owner", async () => {
  // GitHub mints by repository name within the App's installation, whatever owner was asked for.
  const app = (owner: string | undefined) => ({
    mint: async (scope: { repositories?: RepoSlug[] } = {}): Promise<InstallationToken> => {
      if (!owner) throw new Error("GitHub App 2 could not mint an installation token (422)");
      return { token: "t", expiresAt: "2026-10-04T00:00:00Z", permissions: { metadata: "read" }, repositories: (scope.repositories ?? []).map((r) => `${owner}/${r.split("/")[1]}`) };
    },
  });
  await expect(appsReach({ "control-plane": app("Terros-Inc"), worker: app("Terros-Inc") })("terros-inc/two")).resolves.toBe("Terros-Inc/two");
  await expect(appsReach({ "control-plane": app("Terros-Inc"), worker: app("Terros-Inc") })("elsewhere/two")).rejects.toThrow("its installation is on another owner");
  await expect(appsReach({ "control-plane": app("Terros-Inc"), worker: app(undefined) })("terros-inc/two")).rejects.toThrow("the worker GitHub App cannot reach terros-inc/two");
});

// TECH-5205: `sgt admin status` says the config changed since serve started only when someone else changed
// the parameter: serve's own changes, which it takes in place, keep it current, and never hide another's.
test("serve's own changes keep the version it has; a change made in AWS stays one serve lacks", async () => {
  const { call, parameter, enrolled, clock } = await serve();
  expect(await enrolled.versions()).toEqual({ loaded: 1, current: 1 });
  await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" });
  expect(await enrolled.versions()).toEqual({ loaded: 2, current: 2 });

  // Someone changes the budget in AWS; serve's next change writes over that version and still lacks it.
  parameter.value = JSON.stringify({ ...JSON.parse(parameter.value), budget: { usd: 20 } });
  parameter.version += 1;
  clock.ms += VERSION_MS;
  expect(await enrolled.versions()).toEqual({ loaded: 2, current: 3 });
  await call("POST", "/v1/repositories/remove", "grace", { repo: "terros-inc/two" });
  expect(await enrolled.versions()).toEqual({ loaded: 2, current: 4 });
  expect(await enrollment({ repositories: [], configs: {}, parameter: undefined, reach: async (r) => r, log: () => {} }).versions()).toBeNull();
});

// TECH-5208: someone changes the parameter in AWS between serve's read and its write, which then lands
// two versions on. Serve must not take that version as its own, or status would hide the other change.
test("serve's own change keeps the version it has only when no other write came between its read and its write", async () => {
  let between = false;
  const { call, parameter, enrolled } = await serve({
    write: () => {
      if (between) {
        parameter.value = JSON.stringify({ ...JSON.parse(parameter.value), budget: { usd: 20 } });
        parameter.version += 1;
      }
      return "ok";
    },
  });
  await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" });
  expect(await enrolled.versions()).toEqual({ loaded: 2, current: 2 });

  between = true;
  expect(await call("POST", "/v1/repositories/remove", "grace", { repo: "terros-inc/two" })).toMatchObject({ status: 200, json: { changed: true } });
  expect(parameter.version).toBe(4);
  expect(await enrolled.versions()).toEqual({ loaded: 2, current: 4 });
});

// TECH-5206: systemd restarts serve after a crash on the host's copy from its last install, not on the
// parameter now. A change made in AWS before the crash must still show, and only one serve lacks.
test("serve restarted on an older installed copy has that copy's version, and one that differs only in repositories has the parameter's", async () => {
  const { call, parameter } = await serve();
  const installed = { config: CONFIG, version: 1 };
  const restarted = async (copy: { config: unknown; version: number | undefined }) => {
    const logs: string[] = [];
    const started = await enrolledIn(parameter, (line) => logs.push(line), copy);
    const versions = await enrollment({ repositories: [], configs: {}, parameter, version: started.version, reach: async (r) => r, log: () => {} }).versions();
    return { repositories: Object.keys(started.repositories), versions, logs };
  };

  // An approver's `sgt admin repo add`: serve takes repositories from the parameter, so it has all of it.
  await call("POST", "/v1/repositories/add", "grace", { repo: "terros-inc/two" });
  expect(await restarted(installed)).toEqual({ repositories: ["terros-inc/one", "terros-inc/two"], versions: { loaded: 2, current: 2 }, logs: [] });

  // A budget change in AWS, then a crash: serve still runs the installed copy's budget.
  parameter.value = JSON.stringify({ ...JSON.parse(parameter.value), budget: { usd: 20 } });
  parameter.version += 1;
  const stale = await restarted(installed);
  expect(stale.versions).toEqual({ loaded: 1, current: 3 });
  expect(stale.logs).toEqual(["the installation config serve runs is version 1, not the parameter's version 3: `sgt admin restart` installs it"]);
  // A copy installed before install.sh recorded versions is still flagged.
  expect((await restarted({ config: CONFIG, version: undefined })).versions).toEqual({ loaded: 0, current: 3 });

  // Once install.sh has installed the parameter, it is current again.
  expect((await restarted({ config: JSON.parse(parameter.value), version: 3 })).versions).toEqual({ loaded: 3, current: 3 });
});

// TECH-5209: `sgt admin restart` and `update` read the status every 5 seconds for up to 45 minutes. A
// slow or failing AWS must neither run the AWS CLI on every poll nor add a serve.log line to each.
test("the version now is read at most once a while, and a failing read is logged once until one succeeds", async () => {
  const { parameter, enrolled, clock, logs } = await serve();
  const read = parameter.read;
  let reads = 0;
  parameter.read = () => (reads++, read());
  const polls = () => Promise.all([enrolled.versions(), enrolled.versions()]);
  expect(await polls()).toEqual([{ loaded: 1, current: 1 }, { loaded: 1, current: 1 }]);
  clock.ms += VERSION_MS - 1;
  parameter.version += 1;
  expect(await enrolled.versions()).toEqual({ loaded: 1, current: 1 });
  expect(reads).toBe(1);

  parameter.read = () => (reads++, Promise.reject(Object.assign(new Error("Command failed: aws ssm get-parameter --name secret-name"), { stderr: "\nRead timeout on endpoint URL\n" })));
  for (let poll = 0; poll < 3; poll++) {
    clock.ms += VERSION_MS;
    expect(await enrolled.versions()).toEqual({ loaded: 1, current: null });
  }
  expect(reads).toBe(4);
  expect(logs).toEqual(["could not read the installation-config parameter: Read timeout on endpoint URL (logged once until a read succeeds)"]);

  // Once a read succeeds, the next failure is news again.
  parameter.read = read;
  clock.ms += VERSION_MS;
  expect(await enrolled.versions()).toEqual({ loaded: 1, current: 2 });
  parameter.read = () => Promise.reject(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "" }));
  clock.ms += VERSION_MS;
  expect(await enrolled.versions()).toEqual({ loaded: 1, current: null });
  expect(logs.at(-1)).toBe("could not read the installation-config parameter: the AWS CLI took too long and was stopped (logged once until a read succeeds)");
  expect(logs).toHaveLength(2);
});

// The real AWS CLI, stood in for by one that never answers: the read is stopped, not left to hang a status answer.
test("a read of the parameter that takes too long is stopped", async () => {
  const bin = await mkdtemp(join(tmpdir(), "sergeant-fake-aws-"));
  const path = process.env.PATH;
  try {
    await writeFile(join(bin, "aws"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    const started = Date.now();
    await expect(configParameter(InstallationConfig.parse(CONFIG), "sergeant-config", 200).read()).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    process.env.PATH = path;
    await rm(bin, { recursive: true, force: true });
  }
});

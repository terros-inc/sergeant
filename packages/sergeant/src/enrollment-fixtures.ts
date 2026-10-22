import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION, type RepoSlug } from "@terros/sergeant-contracts";
import { apiHandler, type ApiControl } from "./api.ts";
import type { Caller } from "./auth.ts";
import { EnrollmentRefused, enrollment } from "./enrollment.ts";

// The API over an approver's installation-config changes (enrollment.ts) that enrollment.test.ts and
// repo-budget-admin.test.ts drive: a fake parameter, the live list and settings, and a caller per token.

export const callers: Record<string, Caller> = {
  ada: { kind: "linear", user: { id: "u-ada", name: "Ada Example", email: "ada@example.com" }, approver: false },
  grace: { kind: "linear", user: { id: "u-grace", name: "Grace Example", email: "grace@example.com" }, approver: true },
};

export const CONFIG = {
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
export const noRetro = () => ({ target: undefined, validate: async () => undefined });

let server: Server | undefined;
/** Each test's `afterEach`: closes the API server `serve` started. */
export async function closeServer(): Promise<void> {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
}

/** How the fake parameter's write ends: `ok`; `fails`, writing nothing; or `lost`, written but its answer lost. */
export type Write = "ok" | "fails" | "lost";

export async function serve(opts: { writable?: boolean; write?: () => Write } = {}) {
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
  const configs: Record<string, { mergeMethod: "merge" | "squash" | "rebase"; mergePolicy: "sergeant" | "human"; observedChecksFallback: boolean; ciRerunWorkflows: string[]; budget?: { wallMinutes?: number; costUsd?: number } }> = {
    "terros-inc/one": { mergeMethod: "squash", mergePolicy: "human", observedChecksFallback: false, ciRerunWorkflows: [] },
  };
  const logs: string[] = [];
  const clock = { ms: 0 };
  const retro = {
    target: undefined as { projectId: string; teamId: string } | undefined,
    validate: async ({ projectId, teamId }: { projectId: string; teamId: string }) => (projectId === "missing-project" ? "project" as const : teamId === "missing-team" ? "team" as const : undefined),
  };
  const enrolled = enrollment({
    repositories,
    configs,
    parameter: opts.writable === false ? undefined : parameter,
    version: parameter.version,
    // GitHub's own name for the repository; `unreachable` is on no installation.
    reach: async (repo) => (repo.includes("unreachable") ? Promise.reject(new EnrollmentRefused(`the worker GitHub App cannot reach ${repo}`)) : (repo.toLowerCase() as RepoSlug)),
    // The installation's `budget` (CONFIG's $10) with serve's default for the field it leaves unset.
    budget: { wallMinutes: 120, costUsd: CONFIG.budget.usd },
    retro,
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
  /** `body` as a string is sent as is, for JSON that JSON.stringify cannot write (a number like 1e999). */
  const call = (method: string, path: string, as: string, body?: unknown) =>
    new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
      const headers = { [CLI_VERSION_HEADER]: MIN_CLI_VERSION, Authorization: `Bearer ${as}`, ...(body !== undefined && { "Content-Type": "application/json" }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, text }));
      });
      req.on("error", reject);
      req.end(body === undefined || typeof body === "string" ? body : JSON.stringify(body));
    });
  return { call, parameter, repositories, configs, logs, enrolled, clock, retro };
}


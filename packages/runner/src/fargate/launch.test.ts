import { describe, expect, it } from "vitest";
import { startRun, type Launch, type LaunchAws, type LaunchStore } from "./launch.ts";

type Step = "createSecret" | "registerTaskDefinition" | "runTask";
/** How a call fails: ECS/Secrets Manager rejects it, or it takes effect and its answer is lost. */
type Fault = { rejected: string } | { lost: true };

/** An AWS service error as the SDK throws it: its code is its name. */
const awsError = (code: string) => Object.assign(new Error(`${code}: the service said no`), { name: code, $metadata: { httpStatusCode: 400 } });

/** An in-memory AWS honoring what `start` relies on: unique secret names, RunTask's clientToken, startedBy. */
function fakeAws() {
  const secrets = new Map<string, string>();
  const defs = new Set<string>();
  const tasks: { arn: string; clientToken: string; startedBy: string; def: string }[] = [];
  const faults: Partial<Record<Step, Fault>> = {};
  let revision = 0;
  /** Applies `effect` unless the call is rejected; a lost answer takes effect, then throws. */
  const call = <T>(step: Step, effect: () => T): T => {
    const f = faults[step];
    delete faults[step];
    if (f && "rejected" in f) throw awsError(f.rejected);
    const out = effect();
    if (f) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    return out;
  };
  const aws: LaunchAws = {
    createSecret: async (name, body) =>
      call("createSecret", () => {
        if (secrets.has(name)) throw awsError("ResourceExistsException");
        secrets.set(name, body);
        return `arn:secret:${name}`;
      }),
    putSecretValue: async (name, body) => {
      if (!secrets.has(name)) throw awsError("ResourceNotFoundException");
      secrets.set(name, body);
      return `arn:secret:${name}`;
    },
    deleteSecret: async (name) => {
      if (!secrets.delete(name)) throw awsError("ResourceNotFoundException");
    },
    registerTaskDefinition: async () =>
      call("registerTaskDefinition", () => {
        const arn = `arn:taskdef:${++revision}`;
        defs.add(arn);
        return arn;
      }),
    deregisterTaskDefinition: async (arn) => void defs.delete(arn),
    runTask: async (r) =>
      call("runTask", () => {
        const same = tasks.find((t) => t.clientToken === r.clientToken);
        if (same) return { taskArn: same.arn };
        const arn = `arn:task:${tasks.length + 1}`;
        tasks.push({ arn, clientToken: r.clientToken, startedBy: r.startedBy, def: r.taskDefinitionArn });
        return { taskArn: arn };
      }),
    findTask: async (startedBy) => tasks.find((t) => t.startedBy === startedBy)?.arn,
  };
  return { aws, secrets, defs, tasks, faults };
}

function memoryStore(): LaunchStore & { launch?: Launch } {
  const s: LaunchStore & { launch?: Launch } = {
    read: async () => s.launch && structuredClone(s.launch),
    write: async (l) => void (s.launch = structuredClone(l)),
    remove: async () => void delete s.launch,
  };
  return s;
}

const run = { runId: "run_1", adapter: "claude-code-local" as const, model: "m" };
const input = {
  ...run,
  secretString: async () => '{"GH_TOKEN":"t"}',
  taskDefinition: (l: { secretArn: string }) => ({ secretArn: l.secretArn }),
};

describe("startRun", () => {
  it.each([
    ["create-secret is rejected", "createSecret", { rejected: "LimitExceededException" }],
    ["create-secret's answer is lost", "createSecret", { lost: true }],
    ["register-task-definition is rejected", "registerTaskDefinition", { rejected: "ClientException" }],
    ["register-task-definition's answer is lost", "registerTaskDefinition", { lost: true }],
    ["run-task is rejected", "runTask", { rejected: "InvalidParameterException" }],
  ] as const)("strands no credentials when %s, and a rerun starts one task", async (_, step, fault) => {
    const f = fakeAws();
    const store = memoryStore();
    f.faults[step] = fault;
    await expect(startRun(input, f.aws, store)).rejects.toThrow();
    expect([...f.secrets.keys()]).toEqual([]);
    expect(f.tasks).toEqual([]);
    expect(store.launch).toBeUndefined();
    // Only a lost register answer can leave a definition, and it holds a reference to a deleted secret, no value.
    expect(f.defs.size).toBe("lost" in fault && step === "registerTaskDefinition" ? 1 : 0);

    const { taskArn } = await startRun(input, f.aws, store);
    expect(f.tasks.map((t) => t.arn)).toEqual([taskArn]);
    expect(store.launch?.taskArn).toBe(taskArn);
  });

  it("strands no credentials when run-task answers with failures and no task", async () => {
    const f = fakeAws();
    const store = memoryStore();
    f.aws.runTask = async () => ({ failures: [{ reason: "RESOURCE:ENI" }] });
    await expect(startRun(input, f.aws, store)).rejects.toThrow(/started nothing/);
    expect(f.secrets.size + f.defs.size).toBe(0);
    expect(store.launch).toBeUndefined();
  });

  it("adopts the run's secret when an earlier start created it but recorded no ARN", async () => {
    const f = fakeAws();
    const store = memoryStore();
    f.secrets.set("sergeant/runs/run_1", "stale");
    store.launch = { ...run, nonce: "n", clientToken: "c", secretName: "sergeant/runs/run_1", launchedAt: "t" };
    await startRun(input, f.aws, store);
    expect([...f.secrets]).toEqual([["sergeant/runs/run_1", '{"GH_TOKEN":"t"}']]);
    expect(f.tasks).toHaveLength(1);
  });

  it("keeps the secret and definition after a lost run-task answer, and a rerun finds the task by startedBy", async () => {
    const f = fakeAws();
    const store = memoryStore();
    f.faults.runTask = { lost: true };
    await expect(startRun(input, f.aws, store)).rejects.toThrow(/outcome is unknown/);
    expect(f.tasks).toHaveLength(1);
    expect(f.secrets.size).toBe(1);
    expect(f.defs.size).toBe(1);
    expect(store.launch?.taskArn).toBeUndefined();

    const runTask = f.aws.runTask;
    f.aws.runTask = async () => expect.fail("found by startedBy, so RunTask is not sent again");
    expect(await startRun(input, f.aws, store)).toEqual({ taskArn: "arn:task:1", already: true });
    f.aws.runTask = runTask;
    expect(store.launch?.taskArn).toBe("arn:task:1");
  });

  it("retries a lost run-task with the same client token, so a missed lookup starts no second task", async () => {
    const f = fakeAws();
    const store = memoryStore();
    f.faults.runTask = { lost: true };
    await expect(startRun(input, f.aws, store)).rejects.toThrow(/outcome is unknown/);
    f.aws.findTask = async () => undefined; // the lookup has not caught up yet
    expect((await startRun(input, f.aws, store)).taskArn).toBe("arn:task:1");
    expect(f.tasks).toHaveLength(1);
  });

  it("answers an already launched run without any AWS call", async () => {
    const store = memoryStore();
    store.launch = { ...run, nonce: "n", clientToken: "c", secretName: "s", launchedAt: "t", taskArn: "arn:task:9" };
    const none = new Proxy({}, { get: () => () => expect.fail("no AWS call") }) as LaunchAws;
    expect(await startRun(input, none, store)).toEqual({ taskArn: "arn:task:9", already: true });
  });
});

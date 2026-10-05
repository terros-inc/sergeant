import { randomBytes } from "node:crypto";
import type { Adapter } from "../agents.ts";

// A Fargate run's start (TECH-5231's fix, TECH-5237), resumable at each of its three external effects
// (the run's secret, its task definition, its task). The run's record (`launch.json`) names each effect
// before it can exist, so a resumed start adopts it, and a failure that is definitely before the task
// started deletes the secret and the definition, so no credentials are stranded.
// docs/spikes/tech-5231-fargate.md §4.

/** The AWS calls a start makes; `aws.ts` implements them with the AWS SDK, the tests with a fake. */
export type LaunchAws = {
  /** Returns the secret's ARN. */
  createSecret(name: string, secretString: string): Promise<string>;
  /** Replaces the value of an existing secret; returns its ARN. */
  putSecretValue(name: string, secretString: string): Promise<string>;
  deleteSecret(nameOrArn: string): Promise<void>;
  /** Returns the new revision's ARN. */
  registerTaskDefinition(def: unknown): Promise<string>;
  deregisterTaskDefinition(arn: string): Promise<void>;
  runTask(r: { taskDefinitionArn: string; clientToken: string; startedBy: string }): Promise<{ taskArn?: string | undefined; failures?: unknown }>;
  /** A task, running or stopped, that RunTask started with this `startedBy`. */
  findTask(startedBy: string): Promise<string | undefined>;
};

export type LaunchStore = { read(): Promise<Launch | undefined>; write(l: Launch): Promise<void>; remove(): Promise<void> };

export type Launch = {
  runId: string;
  adapter: Adapter;
  model: string;
  nonce: string;
  /** Kept for the life of the record, so a retried RunTask is the same idempotent request. */
  clientToken: string;
  /** Recorded before the secret is created. */
  secretName: string;
  secretArn?: string;
  taskDefinitionArn?: string;
  /** Set before RunTask is called: from then on only a lookup can say whether a task exists. */
  runTaskSentAt?: string;
  taskArn?: string;
  launchedAt: string;
};

export type StartInput = Pick<Launch, "runId" | "adapter" | "model">;

/** Each run's secret is named under this prefix, the only one the execution role can read. */
export const SECRET_PREFIX = "sergeant/runs/";

/** An AWS service error's code (the SDK's error `name`); undefined for a network or other failure. */
export const awsErrorCode = (e: unknown) => {
  const err = e as { name?: string; $metadata?: unknown } | undefined;
  return err?.$metadata !== undefined && err.name ? err.name : undefined;
};

/** RunTask errors that mean ECS rejected the request, so no task was started. Anything else is ambiguous. */
const RUN_TASK_REJECTED = new Set([
  "AccessDeniedException", "BlockedException", "ClientException", "ClusterNotFoundException", "InvalidParameterException",
  "PlatformTaskDefinitionIncompatibilityException", "PlatformUnknownException", "UnsupportedFeatureException",
]);

/**
 * Deletes what a start that never got a task made: the secret, by name since a CreateSecret whose
 * answer was lost may have made it without a recorded ARN, then the definition, then the record.
 */
export async function discard(l: Launch, aws: LaunchAws, store: LaunchStore) {
  await aws.deleteSecret(l.secretName).catch((err: unknown) => {
    if (awsErrorCode(err) !== "ResourceNotFoundException") throw err;
  });
  const { secretArn: _deleted, ...rest } = l;
  await store.write(rest);
  if (l.taskDefinitionArn) await aws.deregisterTaskDefinition(l.taskDefinitionArn);
  await store.remove();
}

const token = () => randomBytes(12).toString("hex");

/**
 * Starts the run's task, or resumes an earlier `start` that failed part way. Returns the task's ARN.
 * `secretString` is read only when the secret is (re)written; `taskDefinition` builds the definition
 * from the recorded secret ARN and nonce.
 */
export async function startRun(
  i: StartInput & { secretString: (adapter: Adapter) => Promise<string>; taskDefinition: (l: Launch & { secretArn: string }) => unknown },
  aws: LaunchAws,
  store: LaunchStore,
): Promise<{ taskArn: string; already: boolean }> {
  let l = await store.read();
  if (l?.taskArn) return { taskArn: l.taskArn, already: true };
  const save = async (patch: Partial<Launch>) => {
    l = { ...(l as Launch), ...patch };
    await store.write(l);
  };
  if (!l) {
    const { runId, adapter, model } = i;
    l = { runId, adapter, model, nonce: token(), clientToken: token(), secretName: `${SECRET_PREFIX}${runId}`, launchedAt: new Date().toISOString() };
    await store.write(l);
  }

  // Definitely before any task: on a failure, delete what exists and forget the record.
  const abandon = async (e: unknown): Promise<never> => {
    await discard(l as Launch, aws, store);
    throw e;
  };

  try {
    if (!l.secretArn) {
      const body = await i.secretString(l.adapter);
      const name = l.secretName;
      // Exists: an earlier `start` created it and lost the answer. It is this run's, so take it over.
      const arn = await aws.createSecret(name, body).catch((e: unknown) => {
        if (awsErrorCode(e) !== "ResourceExistsException") throw e;
        return aws.putSecretValue(name, body);
      });
      await save({ secretArn: arn });
    }
    if (!l.taskDefinitionArn) {
      await save({ taskDefinitionArn: await aws.registerTaskDefinition(i.taskDefinition(l as Launch & { secretArn: string })) });
    }
  } catch (e) {
    return abandon(e);
  }

  // An earlier RunTask whose answer was lost: its task, if any, carries this run's startedBy.
  if (l.runTaskSentAt) {
    const found = await aws.findTask(l.runId);
    if (found) {
      await save({ taskArn: found });
      return { taskArn: found, already: true };
    }
  }
  await save({ runTaskSentAt: new Date().toISOString() });
  let ran: Awaited<ReturnType<LaunchAws["runTask"]>>;
  try {
    ran = await aws.runTask({ taskDefinitionArn: l.taskDefinitionArn as string, clientToken: l.clientToken, startedBy: l.runId });
  } catch (e) {
    if (RUN_TASK_REJECTED.has(awsErrorCode(e) ?? "")) return abandon(e);
    throw new Error(`RunTask's outcome is unknown; the run's secret and task definition are kept. The run's status looks the task up or retries it: ${(e as Error).message}`);
  }
  if (!ran.taskArn) return abandon(new Error(`run-task started nothing: ${JSON.stringify(ran.failures)}`));
  await save({ taskArn: ran.taskArn });
  return { taskArn: ran.taskArn, already: false };
}

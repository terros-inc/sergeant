import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { CreateSecretCommand, DeleteSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { FargateClients } from "./aws.ts";

// In-memory ECS, Secrets Manager, and CloudWatch Logs behind the SDK clients' `send`, for the
// Fargate runner's tests. Each AWS error is thrown as the SDK throws it: its code is its name.

export const serviceError = (name: string) => Object.assign(new Error(`${name}: the service said no`), { name, $metadata: { httpStatusCode: 400 } });

type Task = { arn: string; def: string; clientToken: string; startedBy: string; lastStatus: string; stopCode?: string; exitCode?: number; stoppedAt?: Date };

export function fakeAws() {
  const secrets = new Map<string, string>();
  const defs = new Map<string, Record<string, unknown>>();
  const tasks: Task[] = [];
  const logs = new Map<string, string[]>();
  /** Every command sent, by name, with its input. */
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  /** Commands that fail once, by name: a rejection, or an answer lost after the effect. */
  const faults = new Map<string, "lost" | Error>();
  let revision = 0;

  const effect = (name: string, input: Record<string, unknown>): unknown => {
    if (name === CreateSecretCommand.name) {
      const id = input.Name as string;
      if (secrets.has(id)) throw serviceError("ResourceExistsException");
      secrets.set(id, input.SecretString as string);
      return { ARN: `arn:aws:secretsmanager:us-west-2:1:secret:${id}-AbCdEf` };
    }
    if (name === PutSecretValueCommand.name) {
      const id = input.SecretId as string;
      if (!secrets.has(id)) throw serviceError("ResourceNotFoundException");
      secrets.set(id, input.SecretString as string);
      return { ARN: `arn:aws:secretsmanager:us-west-2:1:secret:${id}-AbCdEf` };
    }
    if (name === DeleteSecretCommand.name) {
      if (!secrets.delete(input.SecretId as string)) throw serviceError("ResourceNotFoundException");
      return {};
    }
    if (name === RegisterTaskDefinitionCommand.name) {
      const arn = `arn:aws:ecs:us-west-2:1:task-definition/${input.family as string}:${++revision}`;
      defs.set(arn, input);
      return { taskDefinition: { taskDefinitionArn: arn } };
    }
    if (name === DeregisterTaskDefinitionCommand.name) {
      defs.delete(input.taskDefinition as string);
      return {};
    }
    if (name === RunTaskCommand.name) {
      const same = tasks.find((t) => t.clientToken === input.clientToken);
      if (same) return { tasks: [{ taskArn: same.arn }] };
      const arn = `arn:aws:ecs:us-west-2:1:task/sergeant-v2-runs/task${tasks.length + 1}`;
      tasks.push({ arn, def: input.taskDefinition as string, clientToken: input.clientToken as string, startedBy: input.startedBy as string, lastStatus: "PROVISIONING" });
      return { tasks: [{ taskArn: arn }], failures: [] };
    }
    if (name === ListTasksCommand.name) {
      const found = tasks.filter((t) => t.startedBy === input.startedBy && (input.desiredStatus === "STOPPED") === (t.lastStatus === "STOPPED"));
      return { taskArns: found.map((t) => t.arn) };
    }
    if (name === DescribeTasksCommand.name) {
      const t = tasks.find((x) => x.arn === (input.tasks as string[])[0]);
      if (!t) return { tasks: [], failures: [{ reason: "MISSING" }] };
      return { tasks: [{ lastStatus: t.lastStatus, stopCode: t.stopCode, stoppedAt: t.stoppedAt, containers: [{ name: "worker", exitCode: t.exitCode }] }], failures: [] };
    }
    if (name === StopTaskCommand.name) {
      const t = tasks.find((x) => x.arn === input.task);
      if (t && t.lastStatus !== "STOPPED") Object.assign(t, { lastStatus: "DEACTIVATING", stopCode: "UserInitiated" });
      return {};
    }
    if (name === GetLogEventsCommand.name) {
      const lines = logs.get(input.logStreamName as string);
      if (!lines) throw serviceError("ResourceNotFoundException");
      // One page, then the same token back: the end of the stream.
      return input.nextToken ? { events: [], nextForwardToken: "f1" } : { events: lines.map((message) => ({ message })), nextForwardToken: "f1" };
    }
    throw new Error(`unexpected ${name}`);
  };

  const send = async (cmd: { constructor: { name: string }; input: unknown }) => {
    const name = cmd.constructor.name;
    const input = cmd.input as Record<string, unknown>;
    sent.push({ name, input });
    const fault = faults.get(name);
    faults.delete(name);
    if (fault instanceof Error) throw fault;
    const out = effect(name, input);
    if (fault === "lost") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    return out;
  };
  const clients = { ecs: { send }, secrets: { send }, logs: { send } } as unknown as FargateClients;

  /** Ends the task with `exitCode`, its stream holding `lines`. */
  const stopTask = (arn: string, exitCode: number | undefined, lines: string[] | undefined, at = new Date()) => {
    const t = tasks.find((x) => x.arn === arn);
    if (!t) throw new Error(`no task ${arn}`);
    Object.assign(t, { lastStatus: "STOPPED", exitCode, stoppedAt: at });
    if (lines) logs.set(`run/worker/${arn.split("/").pop()}`, lines);
  };
  return { secrets, defs, tasks, logs, sent, faults, clients, stopTask };
}

/** What the task prints between its markers. */
export const frame = (kind: "REPORT" | "RESULT", nonce: string, text: string) => [
  `SERGEANT-${kind}-BEGIN ${nonce}`,
  ...(Buffer.from(text).toString("base64").match(/.{1,76}/g) ?? []),
  `SERGEANT-${kind}-END ${nonce}`,
];

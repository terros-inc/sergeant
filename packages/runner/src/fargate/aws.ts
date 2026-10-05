import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type RegisterTaskDefinitionCommandInput,
} from "@aws-sdk/client-ecs";
import { CreateSecretCommand, DeleteSecretCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { awsErrorCode, type LaunchAws } from "./launch.ts";
import { logStream, type DescribeTasks } from "./task.ts";

/**
 * Where worker tasks run: what Terraform made (`deploy/terraform/fargate.tf`, its SSM parameter) and
 * the image install.sh pushed for the installed commit, written by install.sh to
 * `/etc/sergeant/fargate-runner.json`. Identifiers only; nothing here is secret.
 */
export const FargateSettings = z.strictObject({
  region: z.string().min(1),
  cluster: z.string().min(1),
  /** Public subnets: a task needs a public IP for GitHub and the model APIs, and has no ingress. */
  subnets: z.array(z.string().min(1)).min(1),
  securityGroup: z.string().min(1),
  executionRoleArn: z.string().min(1),
  logGroup: z.string().min(1),
  /** Each run registers its own revision of this family, deregistered as the run is collected. */
  taskFamily: z.string().min(1),
  /** `<repository URL>:<commit>`, the runner image the host built and pushed at install. */
  image: z.string().min(1),
  cpu: z.string().default("2048"),
  memory: z.string().default("8192"),
});
export type FargateSettings = z.infer<typeof FargateSettings>;

/** The SDK clients the runner calls; each needs only `send`, so tests pass fakes. */
export type FargateClients = {
  ecs: Pick<ECSClient, "send">;
  secrets: Pick<SecretsManagerClient, "send">;
  logs: Pick<CloudWatchLogsClient, "send">;
};

/** Clients on the host's instance role, through the SDK's default credential chain. */
export const fargateClients = (region: string): FargateClients => ({
  ecs: new ECSClient({ region }),
  secrets: new SecretsManagerClient({ region }),
  logs: new CloudWatchLogsClient({ region }),
});

/** The calls a run makes, on `clients` in `s`'s cluster. */
export function fargateAws(s: FargateSettings, clients: FargateClients) {
  const { ecs, secrets, logs } = clients;
  const launch: LaunchAws = {
    async createSecret(name, secretString) {
      const out = await secrets.send(new CreateSecretCommand({ Name: name, SecretString: secretString, Description: "A Sergeant run's brief and credentials; deleted as the run is collected." }));
      return out.ARN ?? fail("CreateSecret returned no ARN");
    },
    async putSecretValue(name, secretString) {
      const out = await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: secretString }));
      return out.ARN ?? fail("PutSecretValue returned no ARN");
    },
    async deleteSecret(id) {
      await secrets.send(new DeleteSecretCommand({ SecretId: id, ForceDeleteWithoutRecovery: true }));
    },
    async registerTaskDefinition(def) {
      const out = await ecs.send(new RegisterTaskDefinitionCommand(def as RegisterTaskDefinitionCommandInput));
      return out.taskDefinition?.taskDefinitionArn ?? fail("RegisterTaskDefinition returned no ARN");
    },
    async deregisterTaskDefinition(arn) {
      await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
    },
    async runTask(r) {
      const out = await ecs.send(
        new RunTaskCommand({
          cluster: s.cluster,
          launchType: "FARGATE",
          taskDefinition: r.taskDefinitionArn,
          networkConfiguration: { awsvpcConfiguration: { subnets: s.subnets, securityGroups: [s.securityGroup], assignPublicIp: "ENABLED" } },
          startedBy: r.startedBy,
          clientToken: r.clientToken,
        }),
      );
      return { taskArn: out.tasks?.[0]?.taskArn, failures: out.failures };
    },
    async findTask(startedBy) {
      for (const desiredStatus of ["RUNNING", "STOPPED"] as const) {
        const out = await ecs.send(new ListTasksCommand({ cluster: s.cluster, startedBy, desiredStatus }));
        if (out.taskArns?.[0]) return out.taskArns[0];
      }
      return undefined;
    },
  };
  return {
    launch,
    describe: async (taskArn: string): Promise<DescribeTasks> => ecs.send(new DescribeTasksCommand({ cluster: s.cluster, tasks: [taskArn] })),
    stop: async (taskArn: string) => void (await ecs.send(new StopTaskCommand({ cluster: s.cluster, task: taskArn, reason: "sergeant cancel" }))),
    /** Every line of the task's log stream, oldest first; none when the task never logged (an image pull failed, say). */
    async logLines(taskArn: string): Promise<string[]> {
      const lines: string[] = [];
      let token: string | undefined;
      for (;;) {
        const page = await logs
          .send(new GetLogEventsCommand({ logGroupName: s.logGroup, logStreamName: logStream(taskArn), startFromHead: true, ...(token && { nextToken: token }) }))
          .catch((e: unknown) => {
            if (awsErrorCode(e) === "ResourceNotFoundException") return undefined;
            throw e;
          });
        if (!page) return lines;
        lines.push(...(page.events ?? []).map((e) => e.message ?? ""));
        if (!page.nextForwardToken || page.nextForwardToken === token) return lines;
        token = page.nextForwardToken;
      }
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

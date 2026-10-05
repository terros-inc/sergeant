// TECH-5231 spike, never run by CI: renders the normal worker brief (`workerBrief`) for the Fargate
// spike's `cli.ts start --brief`. From packages/runner, with the run's GH_TOKEN exported:
//
//   node src/fargate-spike/brief.ts <spec.json> > brief.md
//
// `spec.json` is a worker RunSpec without its `role`: { runId, owner, repositories, objective,
// conversation, context? }; docs/spikes/tech-5231-fargate.md §5 has one. As the runner does, it lists
// each repository's `sergeant/*` branches, here with `git ls-remote` and the token, so nothing is cloned.
import { readFile } from "node:fs/promises";
import { Conversation, RepoSlug, RunId, type RunSpec } from "@terros/sergeant-contracts";
import { z } from "zod";
import { workerBrief } from "../brief.ts";
import { execOk, TOKEN_CREDENTIAL } from "../exec.ts";

const Spec = z.object({
  runId: RunId,
  owner: z.object({ id: z.string().min(1), name: z.string() }),
  repositories: z.array(RepoSlug).min(1),
  objective: z.string().min(1),
  conversation: Conversation,
  context: z.object({ pullRequests: z.array(z.any()), runs: z.array(z.any()) }).default({ pullRequests: [], runs: [] }),
});

const file = process.argv[2];
if (!file) throw new Error("usage: brief.ts <spec.json>");
const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");
const spec = { ...Spec.parse(JSON.parse(await readFile(file, "utf8"))), role: "worker" } as Extract<RunSpec, { role: "worker" }>;

const existing: string[] = [];
for (const repo of spec.repositories) {
  const out = await execOk("git", [...TOKEN_CREDENTIAL, "ls-remote", "--heads", `https://github.com/${repo}.git`, "refs/heads/sergeant/*"], {
    env: { ...process.env, SERGEANT_RUN_GITHUB_TOKEN: token },
  });
  existing.push(...out.split("\n").filter(Boolean).map((l) => `${repo}: ${l.split("refs/heads/")[1]}`));
}
process.stdout.write(workerBrief(spec, existing));

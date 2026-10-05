import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderChoice, ReviewReport, RunAccount, RunRecord, type RunId } from "@terros/sergeant-contracts";
import { z } from "zod";
import { ADAPTERS } from "./agents.ts";

// What a run leaves in its directory under the runner's root: `run.json` written at launch, and the
// final `record.json` and `report.md` written as it ends.

export const RunMeta = z.object({
  runId: z.string(),
  role: z.enum(["worker", "reviewer"]),
  /** Absent in a run started before TECH-5009, which was Claude Code's. */
  adapter: z.enum(ADAPTERS).default("claude-code-local"),
  model: z.string(),
  repositories: z.array(z.string()),
  /** The Docker container's name; for a Fargate run, its task's container name. */
  container: z.string(),
  /** Set for a run on ECS Fargate (TECH-5237), whose task and secret are in its `launch.json`. */
  backend: z.literal("fargate").optional(),
  startedAt: z.string(),
  /** The issue text the run started from; every record of the run carries it (M13). */
  issueRevision: z.string().optional(),
  /** The provider chosen from quota and the readings behind it (TECH-5117); every record of the run carries it. */
  providerChoice: ProviderChoice.optional(),
  /** The task owner's model account it runs on and why (TECH-5179); every record of the run carries them. */
  account: RunAccount.optional(),
  accountReason: z.string().optional(),
  /** The task owner's Linear user id, whose accounts the run's is among (TECH-5213). */
  ownerId: z.string().optional(),
});
export type RunMeta = z.infer<typeof RunMeta>;
export const recorded = ({ issueRevision, providerChoice, account, accountReason }: RunMeta) => ({
  ...(issueRevision !== undefined && { issueRevision }),
  ...(providerChoice && { providerChoice }),
  ...(account && { account, ...(accountReason && { accountReason }) }),
});

/** The run directories under `root`, and the records and launch facts read back from them. */
export function runFiles(root: string) {
  const paths = (runId: string) => {
    const dir = join(root, runId);
    return { dir, workspace: join(dir, "workspace"), meta: join(dir, "run.json"), record: join(dir, "record.json") };
  };
  const readMeta = async (runId: RunId) => RunMeta.parse(JSON.parse(await readFile(paths(runId).meta, "utf8")));
  const readRecord = async (runId: RunId) => {
    try {
      const record = JSON.parse(await readFile(paths(runId).record, "utf8"));
      // run.json is authoritative for launch-time facts. Keep serving them even for a terminal
      // record written without the newer optional fields (for example, across a host update). They
      // are extra detail only: a missing or unreadable run.json leaves the record as written.
      const meta = await readMeta(runId).catch(() => undefined);
      return RunRecord.parse({ ...record, ...(meta && recorded(meta)) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  /**
   * Earlier runs naming these PRs: the worker reports are the implementer's claims a reviewer checks,
   * and earlier reviews are the findings it checks were addressed (06 §2). The latest such worker's
   * adapter is the one a reviewer should not share (TECH-5117).
   */
  async function priorReports(subjects: { repo: string; number: number }[]) {
    const names = (pr: { repo: string; number: number }) => subjects.some((s) => s.repo === pr.repo && s.number === pr.number);
    const claims: string[] = [];
    const reviews: ReviewReport[] = [];
    let worker: RunMeta | undefined;
    for (const runId of await readdir(root)) {
      const record = await readRecord(runId).catch(() => undefined);
      if (!record?.report) continue;
      if (record.role === "reviewer") {
        if (record.report.reviewed.some(names)) reviews.push(record.report);
      } else if (record.report.pullRequests.some(names)) {
        claims.push(await readFile(join(paths(runId).dir, "report.md"), "utf8"));
        const meta = await readMeta(runId).catch(() => undefined);
        if (meta && (!worker || meta.startedAt > worker.startedAt)) worker = meta;
      }
    }
    return { claims, reviews, workerAdapter: worker?.adapter };
  }

  return { paths, readMeta, readRecord, priorReports };
}

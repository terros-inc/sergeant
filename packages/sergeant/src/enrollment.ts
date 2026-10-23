import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RepoSlug, safeJson, type MergePolicy, type RepositoryAuditRateChange, type RepositoryAuditRateRequest, type RepositoryBudget, type RepositoryBudgetChange, type RepositoryBudgetRequest, type RepositoryChange, type RetroTarget, type RetroTargetChange, type WorkerProfile } from "@terros/sergeant-contracts";
import type { GitHubApp } from "@terros/sergeant-github";
import { z } from "zod";
import { DEFAULT_BUDGET, type BudgetWindow } from "./budget.ts";
import { InstallationConfig, repoBudget, run } from "./config.ts";

// Enrolling and removing repositories (TECH-5193), setting the retro target (TECH-5838), and setting a
// repository's own budget (TECH-6606), with an approver's own Linear login, with no AWS
// session and no host update. The installation-config SSM parameter is the only record: each change
// rewrites it, the one parameter the host's role may write (deploy/terraform), changing only its
// `repositories` or `retro` and naming who made the change in the new version's description. `serve`
// takes its `repositories` and `retro` from it at startup (serve.ts), so no restart can bring back an
// older list or retro target (TECH-5940). The
// running service takes a change in place: every loop, the API, webhooks, and the GitHub port read the
// same live list and settings. A change the parameter already has (a retry after a write whose answer
// was lost, say) writes nothing and brings the live list up to it. The installation's own `budget`,
// secret references, approvers, and the release channel stay AWS-only. Of them only the budget is ever
// in an answer (`sgt repo list` shows the window it and each repository's own give), never in a log.
//
// TECH-5205: serve keeps the parameter's version it has, the one it started with and then each version
// its own change wrote directly over the one it had, so `sgt admin status` can say when someone changed the
// parameter in AWS since, which only a restart rereads.
//
// TECH-5209: `sgt admin restart` and `update` poll that status every 5 seconds for up to 45 minutes, so
// the version now is read at most once every VERSION_MS, every read is cut off after READ_TIMEOUT_MS,
// and a failing read is logged once, when it starts failing, not on every poll.
//
// TECH-5206: serve runs the host's copy of the parameter from its last install, which systemd may
// restart after a crash long after the parameter changed. So serve starts with the parameter's version
// only when that copy matches it apart from `repositories` and `retro`, which serve takes from the
// parameter anyway; otherwise it has the version install.sh recorded with the copy.

/** How long `sgt admin status` may show the parameter's version now from an earlier read. */
export const VERSION_MS = 30_000;
/** How long a read of the parameter may take before the AWS CLI is stopped and the read fails. */
export const READ_TIMEOUT_MS = 10_000;

type RepoConfig = InstallationConfig["repositories"][string];
export type MergeMethod = RepoConfig["mergeMethod"];
/** `read` gives the value and its version; `write` resolves with the version it stored. */
export type ConfigParameter = {
  read: () => Promise<{ value: string; version: number }>;
  write: (value: string, description: string) => Promise<number>;
};

/** A change refused for a reason the caller can act on. */
export class EnrollmentRefused extends Error {}

/**
 * The parameter's `repositories` and `retro` (undefined when it has none: retros are off), validated
 * with the rest of it, and the version `serve` has: the parameter's when `installed`, the host's copy
 * serve runs, matches it but for those two; else the version installed with that copy, 0 when none was recorded.
 */
export async function enrolledIn(
  parameter: ConfigParameter,
  log: (line: string) => void,
  installed?: { config: unknown; version: number | undefined },
): Promise<{ repositories: InstallationConfig["repositories"]; retro: RetroTarget | undefined; version: number }> {
  const { config, version } = await readConfig(parameter, log);
  const { repositories, retro } = InstallationConfig.parse(config);
  const rest = (c: object) => ({ ...c, repositories: {}, retro: undefined });
  if (!installed || isDeepStrictEqual(rest(installed.config as object), rest(config))) return { repositories, retro, version };
  const loaded = installed.version ?? 0;
  log(`the installation config serve runs is version ${loaded}, not the parameter's version ${version}: \`sgt admin restart\` installs it`);
  return { repositories, retro, version: loaded };
}

/** The parameter's raw JSON, valid as an installation config, and its version. A failure's message never quotes it. */
async function readConfig(parameter: ConfigParameter, log: (line: string) => void): Promise<{ config: { repositories: Record<string, unknown>; retro?: RetroTarget }; version: number }> {
  const { value, version } = await aws(parameter.read(), "read", log);
  const config = safeJson(value);
  if (!InstallationConfig.safeParse(config).success) throw new Error("the installation-config parameter is not a valid installation config: fix it in AWS first");
  return { config: config as { repositories: Record<string, unknown>; retro?: RetroTarget }, version };
}

/** An AWS CLI call whose failure is logged with only the CLI's own stderr: the error's message would quote its arguments. */
async function aws<T>(call: Promise<T>, what: "read" | "write", log: (line: string) => void): Promise<T> {
  return call.catch((e: { stderr?: unknown; killed?: unknown }) => {
    log(`could not ${what} the installation-config parameter: ${why(e)}`);
    // A failed write may still have been stored: only a retry, which takes what the parameter has, can tell.
    throw new Error(
      what === "read"
        ? "Sergeant could not read its installation-config parameter (serve.log says why); nothing changed"
        : "Sergeant could not confirm its write of the installation-config parameter (serve.log says why): retry, and it takes whatever the parameter has",
    );
  });
}

/** The AWS CLI's last line of error output, or that it was stopped for taking too long. */
function why(e: { stderr?: unknown; killed?: unknown }): string {
  if (e.killed === true) return "the AWS CLI took too long and was stopped";
  const stderr = typeof e.stderr === "string" ? e.stderr.trim().split("\n").at(-1)?.slice(0, 300) : undefined;
  return stderr || "no error output";
}

export type Enrollment = ReturnType<typeof enrollment>;

export function enrollment(opts: {
  /** The live list every loop, the API, and webhooks read. */
  repositories: RepoSlug[];
  /** The live settings the GitHub port reads (config.ts `connect`). */
  configs: Record<string, RepoConfig>;
  /** The installation-config parameter; absent, the list cannot change here. */
  parameter: ConfigParameter | undefined;
  /** The parameter's version serve started with (`enrolledIn`). */
  version?: number | undefined;
  /** The repository's own `owner/name` once both GitHub Apps reach it; throws `EnrollmentRefused` otherwise. */
  reach: (repo: RepoSlug) => Promise<RepoSlug>;
  /** The installation's `budget` with its defaults: the window a repository's own budget changes field by field. */
  budget?: BudgetWindow;
  /** Live retro target and validation in this installation's Linear workspace. */
  retro: { target: RetroTarget | undefined; validate: (target: RetroTarget) => Promise<"project" | "team" | undefined> };
  log: (line: string) => void;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const retro = opts.retro;
  // One change at a time, so two cannot overwrite each other's read-modify-write.
  let changes: Promise<unknown> = Promise.resolve();
  let loaded = opts.version;
  // The parameter's version now, as last read (or being read), and whether reads are failing.
  let current: { at: number; version: Promise<number | null> } | undefined;
  let failing = false;
  const keyOf = (repositories: object, repo: string) => Object.keys(repositories).find((r) => r.toLowerCase() === repo.toLowerCase());

  /**
   * Reads the parameter and applies `edit` to its `repositories`: a description of the change, or
   * undefined when the parameter already has it. Writes a change, then brings the live list up to the parameter.
   */
  function change(edit: (config: { repositories: Record<string, unknown>; retro?: RetroTarget }) => string | undefined): Promise<boolean> {
    const parameter = opts.parameter;
    if (!parameter) return Promise.reject(new EnrollmentRefused("this Sergeant cannot change its installation config: serve runs without --config-parameter"));
    const done = changes.then(async () => {
      const { config, version } = await readConfig(parameter, opts.log);
      const what = edit(config);
      const next = InstallationConfig.parse(config).repositories;
      const nextRetro = InstallationConfig.parse(config).retro;
      if (what) {
        const written = await aws(parameter.write(JSON.stringify(config, null, 2), what), "write", opts.log);
        // Over a version serve does not have, the write carries that version's other changes, which serve still lacks.
        // TECH-5208: one landing past the version after the one read went over a write serve never saw.
        if (version === loaded && written === version + 1) loaded = written;
        current = undefined;
      }
      for (const r of Object.keys(opts.configs)) delete opts.configs[r];
      Object.assign(opts.configs, next);
      opts.repositories.splice(0, opts.repositories.length, ...Object.keys(next));
      retro.target = nextRetro;
      if (what) opts.log(`${what}: the installation-config parameter and the running service have it`);
      return what !== undefined;
    });
    changes = done.catch(() => {});
    return done;
  }

  /** A repository's own budget, and the window it gives a task working only there. */
  const budgets = (settings: RepoConfig) => {
    const ownBudget = repoBudget(settings) ?? {};
    return { budget: { ...(opts.budget ?? DEFAULT_BUDGET), ...ownBudget }, ownBudget };
  };

  return {
    /** The parameter's version serve has and its version now (contracts' AdminStatus `config`); null without the parameter. */
    async versions(): Promise<{ loaded: number; current: number | null } | null> {
      const parameter = opts.parameter;
      if (!parameter || loaded === undefined) return null;
      if (!current || now() - current.at >= VERSION_MS) {
        const version = parameter.read().then(
          (r) => ((failing = false), r.version),
          (e: { stderr?: unknown; killed?: unknown }) => {
            if (!failing) opts.log(`could not read the installation-config parameter: ${why(e)} (logged once until a read succeeds)`);
            failing = true;
            return null;
          },
        );
        current = { at: now(), version };
      }
      return { loaded, current: await current.version };
    },

    list: () =>
      Object.entries(opts.configs).map(([repo, c]) => ({
        repo,
        mergeMethod: c.mergeMethod,
        mergePolicy: c.mergePolicy,
        workerProfile: c.workerProfile,
        ...budgets(c),
        ...(c.mergedAuditSampleRate && { mergedAuditSampleRate: c.mergedAuditSampleRate }),
      })),

    retroTarget: () => retro.target,

    async setRetro(target: RetroTarget, by: string): Promise<RetroTargetChange> {
      const invalid = await retro.validate(target);
      if (invalid) throw new EnrollmentRefused(`Linear ${invalid} not found in this Sergeant's workspace: ${target[`${invalid}Id`]}`);
      const changed = await change((config) => {
        if (isDeepStrictEqual(config.retro, target)) return undefined;
        config.retro = target;
        return `${by} set the retro target to project ${target.projectId}, team ${target.teamId}`;
      });
      return { changed, retro: retro.target ?? null };
    },

    async disableRetro(by: string): Promise<RetroTargetChange> {
      const changed = await change((config) => {
        if (!config.retro) return undefined;
        delete config.retro;
        return `${by} turned retros off`;
      });
      return { changed, retro: retro.target ?? null };
    },

    /**
     * Enrolls `repo` once both GitHub Apps reach it, `human`-merged unless `mergePolicy` says otherwise
     * (TECH-5244). One already enrolled stays as it is, except that a `mergePolicy` given sets its policy.
     */
    async add(repo: RepoSlug, mergeMethod: MergeMethod, mergePolicy: MergePolicy | undefined, workerProfile: WorkerProfile | undefined, by: string): Promise<RepositoryChange> {
      let own = await opts.reach(repo);
      const changed = await change(({ repositories: current }) => {
        const enrolled = keyOf(current, own);
        if (enrolled) {
          own = enrolled;
          const settings = current[enrolled] as { mergePolicy?: MergePolicy; workerProfile?: WorkerProfile };
          const policyChanged = mergePolicy !== undefined && mergePolicy !== (settings.mergePolicy ?? "human");
          const profileChanged = workerProfile !== undefined && workerProfile !== (settings.workerProfile ?? "base");
          if (!policyChanged && !profileChanged) return undefined;
          if (mergePolicy !== undefined) settings.mergePolicy = mergePolicy;
          if (workerProfile !== undefined) settings.workerProfile = workerProfile;
          return `${by} updated ${own}'s enrollment settings`;
        }
        current[own] = { mergeMethod, mergePolicy: mergePolicy ?? "human", workerProfile: workerProfile ?? "base" };
        return `${by} enrolled ${own} (${mergeMethod}, merged by ${mergePolicy ?? "human"}, ${workerProfile ?? "base"} worker)`;
      });
      return { repo: own, changed, repositories: [...opts.repositories] };
    },

    /**
     * TECH-6606: sets or clears (`"default"`) each field the request gives of an enrolled repository's own
     * budget; a field left out stays as it is. Only that repository's `budget` changes, and with no
     * field left it goes. The live settings, which task loops read when a window opens, take it at once.
     */
    async setBudget({ repo, ...fields }: RepositoryBudgetRequest, by: string): Promise<RepositoryBudgetChange> {
      let own = repo;
      const changed = await change(({ repositories: current }) => {
        const enrolled = keyOf(current, repo);
        if (!enrolled) throw new EnrollmentRefused(`${repo} is not enrolled: \`sgt repo list\` shows the enrolled repositories`);
        own = enrolled;
        const settings = current[enrolled] as { budget?: RepositoryBudget };
        const before = settings.budget ?? {};
        const after: RepositoryBudget = { ...before };
        for (const field of ["wallMinutes", "costUsd"] as const) {
          const value = fields[field];
          if (value === "default") delete after[field];
          else if (value !== undefined) after[field] = value;
        }
        if (isDeepStrictEqual(before, after)) return undefined;
        if (Object.keys(after).length === 0) delete settings.budget;
        else settings.budget = after;
        return `${by} set ${enrolled}'s budget: ${budgetText(after)}`;
      });
      const settings = opts.configs[own];
      if (!settings) throw new EnrollmentRefused(`${own} is not enrolled`);
      const { budget, ownBudget } = budgets(settings);
      return { repo: own, changed, ownBudget, budget };
    },

    /**
     * TECH-6617: sets the fraction of an enrolled repository's merged PRs the daily merged-PR audit draws;
     * 0 removes the key, so absent stays the only "off". The merged-PR audit reads it live at its next pass.
     */
    async setAuditRate({ repo, mergedAuditSampleRate: rate }: RepositoryAuditRateRequest, by: string): Promise<RepositoryAuditRateChange> {
      let own = repo;
      const changed = await change(({ repositories: current }) => {
        const enrolled = keyOf(current, repo);
        if (!enrolled) throw new EnrollmentRefused(`${repo} is not enrolled: \`sgt repo list\` shows the enrolled repositories`);
        own = enrolled;
        const settings = current[enrolled] as { mergedAuditSampleRate?: number };
        if ((settings.mergedAuditSampleRate ?? 0) === rate) return undefined;
        if (rate === 0) delete settings.mergedAuditSampleRate;
        else settings.mergedAuditSampleRate = rate;
        return `${by} set ${enrolled}'s merged-PR audit rate to ${rate}`;
      });
      return { repo: own, changed, mergedAuditSampleRate: opts.configs[own]?.mergedAuditSampleRate ?? 0 };
    },

    /** Removes `repo` from the enrolled list; one not enrolled stays so. */
    async remove(repo: RepoSlug, by: string): Promise<RepositoryChange> {
      let removed = repo;
      const changed = await change(({ repositories: current }) => {
        const enrolled = keyOf(current, repo);
        if (!enrolled) return undefined;
        delete current[enrolled];
        removed = enrolled;
        return `${by} removed ${enrolled}`;
      });
      return { repo: removed, changed, repositories: [...opts.repositories] };
    },
  };
}

/**
 * Both GitHub Apps must reach a repository: each mints a metadata-only token for it. An App's token is
 * minted by repository name within its one installation, so the name GitHub returns must match the
 * owner too: `elsewhere/app` must not enroll the installation's own `app`.
 */
export function appsReach(apps: Record<string, Pick<GitHubApp, "mint">>): (repo: RepoSlug) => Promise<RepoSlug> {
  return async (repo) => {
    const found = await Promise.all(
      Object.entries(apps).map(async ([name, app]) => {
        const token = await app.mint({ repositories: [repo], permissions: { metadata: "read" } }).catch((e: Error) => {
          throw new EnrollmentRefused(`the ${name} GitHub App cannot reach ${repo}: ${e.message}`);
        });
        const own = token.repositories.find((r) => r.toLowerCase() === repo.toLowerCase());
        if (!own) throw new EnrollmentRefused(`the ${name} GitHub App cannot reach ${repo}: its installation is on another owner`);
        return RepoSlug.parse(own);
      }),
    );
    return found[0] ?? repo;
  };
}

/**
 * The installation-config SSM parameter, read and written with the host's role. The value goes to the
 * AWS CLI in a private temporary file, never on its command line.
 */
export function configParameter(config: InstallationConfig, name: string, readTimeoutMs = READ_TIMEOUT_MS): ConfigParameter {
  const { awsRegion, awsProfile } = config.secrets;
  // Only a read is cut off: a write stopped midway may still be stored, and only a retry could tell.
  const aws = (args: string[], timeout = 0) => run("aws", ["ssm", ...args, "--name", name, "--region", awsRegion, ...(awsProfile ? ["--profile", awsProfile] : [])], { timeout });
  return {
    read: async () => ParameterAnswer.parse(safeJson((await aws(["get-parameter", "--query", "Parameter.{value: Value, version: Version}", "--output", "json"], readTimeoutMs)).stdout)),
    write: async (value, description) => {
      const dir = await mkdtemp(join(tmpdir(), "sergeant-config-"));
      const file = join(dir, "value");
      try {
        await writeFile(file, value, { mode: 0o600 });
        return z.number().int().parse(safeJson((await aws(["put-parameter", "--overwrite", "--value", `file://${file}`, "--description", description, "--query", "Version", "--output", "json"])).stdout));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

const ParameterAnswer = z.object({ value: z.string(), version: z.number().int() });

/** A repository's own budget as a parameter version's description says it. */
const budgetText = (own: RepositoryBudget) => (["wallMinutes", "costUsd"] as const).map((f) => `${f} ${own[f] ?? "the installation's"}`).join(", ");

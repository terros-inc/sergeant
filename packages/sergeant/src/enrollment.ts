import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, safeJson, type RepositoryChange } from "@terros/sergeant-contracts";
import type { GitHubApp } from "@terros/sergeant-github";
import { z } from "zod";
import { InstallationConfig, run } from "./config.ts";

// Enrolling and removing repositories with an approver's own Linear login (TECH-5193), with no AWS
// session and no host update. The installation-config SSM parameter is the only record: each change
// rewrites it, the one parameter the host's role may write (deploy/terraform), changing only its
// `repositories` and naming who made the change in the new version's description, and `serve` takes
// its `repositories` from it at startup (serve.ts), so no restart can bring back an older list. The
// running service takes a change in place: every loop, the API, webhooks, and the GitHub port read the
// same live list and settings. A change the parameter already has (a retry after a write whose answer
// was lost, say) writes nothing and brings the live list up to it. Budgets, secret references,
// approvers, and the release channel stay AWS-only, and none of them is ever in an answer or a log.
//
// TECH-5205: serve keeps the parameter's version it has, the one it started with and then each version
// its own change wrote over the one it had, so `sgt admin status` can say when someone changed the
// parameter in AWS since, which only a restart rereads.
//
// TECH-5209: `sgt admin restart` and `update` poll that status every 5 seconds for up to 45 minutes, so
// the version now is read at most once every VERSION_MS, every read is cut off after READ_TIMEOUT_MS,
// and a failing read is logged once, when it starts failing, not on every poll.

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

/** The parameter's `repositories`, validated with the rest of it, and its version: what `serve` starts with. */
export async function enrolledIn(parameter: ConfigParameter, log: (line: string) => void): Promise<{ repositories: InstallationConfig["repositories"]; version: number }> {
  const { config, version } = await readConfig(parameter, log);
  return { repositories: InstallationConfig.parse(config).repositories, version };
}

/** The parameter's raw JSON, valid as an installation config, and its version. A failure's message never quotes it. */
async function readConfig(parameter: ConfigParameter, log: (line: string) => void): Promise<{ config: { repositories: Record<string, unknown> }; version: number }> {
  const { value, version } = await aws(parameter.read(), "read", log);
  const config = safeJson(value);
  if (!InstallationConfig.safeParse(config).success) throw new Error("the installation-config parameter is not a valid installation config: fix it in AWS first");
  return { config: config as { repositories: Record<string, unknown> }, version };
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
  log: (line: string) => void;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
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
  function change(edit: (repositories: Record<string, unknown>) => string | undefined): Promise<boolean> {
    const parameter = opts.parameter;
    if (!parameter) return Promise.reject(new EnrollmentRefused("this Sergeant cannot change its enrolled repositories: serve runs without --config-parameter"));
    const done = changes.then(async () => {
      const { config, version } = await readConfig(parameter, opts.log);
      const what = edit(config.repositories);
      const next = InstallationConfig.parse(config).repositories;
      if (what) {
        const written = await aws(parameter.write(JSON.stringify(config, null, 2), what), "write", opts.log);
        // Over a version serve does not have, the write carries that version's other changes, which serve still lacks.
        if (version === loaded) loaded = written;
        current = undefined;
      }
      for (const r of Object.keys(opts.configs)) delete opts.configs[r];
      Object.assign(opts.configs, next);
      opts.repositories.splice(0, opts.repositories.length, ...Object.keys(next));
      if (what) opts.log(`${what}: the installation-config parameter and the running service have it`);
      return what !== undefined;
    });
    changes = done.catch(() => {});
    return done;
  }

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

    list: () => Object.entries(opts.configs).map(([repo, c]) => ({ repo, mergeMethod: c.mergeMethod })),

    /** Enrolls `repo` once both GitHub Apps reach it; one already enrolled stays as it is. */
    async add(repo: RepoSlug, mergeMethod: MergeMethod, by: string): Promise<RepositoryChange> {
      let own = await opts.reach(repo);
      const changed = await change((current) => {
        const enrolled = keyOf(current, own);
        if (enrolled) {
          own = enrolled;
          return undefined;
        }
        current[own] = { mergeMethod };
        return `${by} enrolled ${own} (${mergeMethod})`;
      });
      return { repo: own, changed, repositories: [...opts.repositories] };
    },

    /** Removes `repo` from the enrolled list; one not enrolled stays so. */
    async remove(repo: RepoSlug, by: string): Promise<RepositoryChange> {
      let removed = repo;
      const changed = await change((current) => {
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

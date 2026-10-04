import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, safeJson, type RepositoryChange } from "@terros/sergeant-contracts";
import type { GitHubApp } from "@terros/sergeant-github";
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

type RepoConfig = InstallationConfig["repositories"][string];
export type MergeMethod = RepoConfig["mergeMethod"];
export type ConfigParameter = { read: () => Promise<string>; write: (value: string, description: string) => Promise<void> };

/** A change refused for a reason the caller can act on. */
export class EnrollmentRefused extends Error {}

/** The parameter's `repositories`, validated with the rest of it; what `serve` starts with. */
export async function enrolledIn(parameter: ConfigParameter, log: (line: string) => void): Promise<InstallationConfig["repositories"]> {
  return InstallationConfig.parse(await readConfig(parameter, log)).repositories;
}

/** The parameter's raw JSON, valid as an installation config. A failure's message never quotes it. */
async function readConfig(parameter: ConfigParameter, log: (line: string) => void): Promise<{ repositories: Record<string, unknown> }> {
  const config = safeJson(await aws(parameter.read(), "read", log));
  if (!InstallationConfig.safeParse(config).success) throw new Error("the installation-config parameter is not a valid installation config: fix it in AWS first");
  return config as { repositories: Record<string, unknown> };
}

/** An AWS CLI call whose failure is logged with only the CLI's own stderr: the error's message would quote its arguments. */
async function aws<T>(call: Promise<T>, what: "read" | "write", log: (line: string) => void): Promise<T> {
  return call.catch((e: { stderr?: unknown }) => {
    const stderr = typeof e.stderr === "string" ? e.stderr.trim().split("\n").at(-1)?.slice(0, 300) : undefined;
    log(`could not ${what} the installation-config parameter: ${stderr || "no error output"}`);
    // A failed write may still have been stored: only a retry, which takes what the parameter has, can tell.
    throw new Error(
      what === "read"
        ? "Sergeant could not read its installation-config parameter (serve.log says why); nothing changed"
        : "Sergeant could not confirm its write of the installation-config parameter (serve.log says why): retry, and it takes whatever the parameter has",
    );
  });
}

export type Enrollment = ReturnType<typeof enrollment>;

export function enrollment(opts: {
  /** The live list every loop, the API, and webhooks read. */
  repositories: RepoSlug[];
  /** The live settings the GitHub port reads (config.ts `connect`). */
  configs: Record<string, RepoConfig>;
  /** The installation-config parameter; absent, the list cannot change here. */
  parameter: ConfigParameter | undefined;
  /** The repository's own `owner/name` once both GitHub Apps reach it; throws `EnrollmentRefused` otherwise. */
  reach: (repo: RepoSlug) => Promise<RepoSlug>;
  log: (line: string) => void;
}) {
  // One change at a time, so two cannot overwrite each other's read-modify-write.
  let changes: Promise<unknown> = Promise.resolve();
  const keyOf = (repositories: object, repo: string) => Object.keys(repositories).find((r) => r.toLowerCase() === repo.toLowerCase());

  /**
   * Reads the parameter and applies `edit` to its `repositories`: a description of the change, or
   * undefined when the parameter already has it. Writes a change, then brings the live list up to the parameter.
   */
  function change(edit: (repositories: Record<string, unknown>) => string | undefined): Promise<boolean> {
    const parameter = opts.parameter;
    if (!parameter) return Promise.reject(new EnrollmentRefused("this Sergeant cannot change its enrolled repositories: serve runs without --config-parameter"));
    const done = changes.then(async () => {
      const config = await readConfig(parameter, opts.log);
      const what = edit(config.repositories);
      const next = InstallationConfig.parse(config).repositories;
      if (what) await aws(parameter.write(JSON.stringify(config, null, 2), what), "write", opts.log);
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
export function configParameter(config: InstallationConfig, name: string): ConfigParameter {
  const { awsRegion, awsProfile } = config.secrets;
  const aws = (args: string[]) => run("aws", ["ssm", ...args, "--name", name, "--region", awsRegion, ...(awsProfile ? ["--profile", awsProfile] : [])]);
  return {
    read: async () => (await aws(["get-parameter", "--query", "Parameter.Value", "--output", "text"])).stdout,
    write: async (value, description) => {
      const dir = await mkdtemp(join(tmpdir(), "sergeant-config-"));
      const file = join(dir, "value");
      try {
        await writeFile(file, value, { mode: 0o600 });
        await aws(["put-parameter", "--overwrite", "--value", `file://${file}`, "--description", description]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

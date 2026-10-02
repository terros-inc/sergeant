import { createSign } from "node:crypto";
import { RepoSlug, type RunGitHubTokens } from "@terros/sergeant-contracts";
import { z } from "zod";

// GitHub App installation tokens (08 §1). The control-plane App reads and merges; the worker App's
// key is used here only to mint one run's token, scoped to that run's repositories (04 §9).

export type GitHubAppOptions = {
  appId: string | number;
  installationId: number;
  /** The App's PEM private key, resolved from a secret reference by the caller. */
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

type Permissions = Record<string, "read" | "write">;
export type InstallationToken = { token: string; expiresAt: string; permissions: Record<string, string>; repositories: string[] };

const tokenResponse = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()).default({}),
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

/** A worker's or reviewer's token can do exactly this, even if the worker App holds more. */
export const RUN_PERMISSIONS: Record<"write" | "read", Permissions> = {
  write: { contents: "write", pull_requests: "write", checks: "read", actions: "read", metadata: "read" },
  read: { contents: "read", pull_requests: "read", metadata: "read" },
};

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export function githubApp(options: GitHubAppOptions) {
  if (!options.privateKey) throw new Error("GitHub App private key is required");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");

  /** The App's own short-lived JWT, good only for minting installation tokens. */
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(options.appId) }),
    )}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(options.privateKey, "base64url")}`;
  };

  return {
    /** The login the App acts as on GitHub (`<slug>[bot]`), so a PR it opened can be recognized (M2). */
    async login(): Promise<string> {
      const res = await fetchFn(`${apiUrl}/app`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${jwt()}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!res.ok) throw new Error(`GitHub App ${options.appId} could not read itself (${res.status})`);
      return `${z.object({ slug: z.string().min(1) }).parse(await res.json()).slug}[bot]`;
    },
    /** An installation token, optionally narrowed to `repositories` (all of one owner) and `permissions`. */
    async mint(scope: { repositories?: RepoSlug[]; permissions?: Permissions } = {}): Promise<InstallationToken> {
      // An empty list would read as "no restriction"; a scoped caller always names its repositories.
      if (scope.repositories?.length === 0) throw new Error("a scoped GitHub token needs at least one repository");
      const names = scope.repositories?.map((r) => RepoSlug.parse(r).split("/")[1]);
      const res = await fetchFn(`${apiUrl}/app/installations/${options.installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt()}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ...(names && { repositories: names }), ...(scope.permissions && { permissions: scope.permissions }) }),
      });
      if (!res.ok) throw new Error(`GitHub App ${options.appId} could not mint an installation token (${res.status})`);
      const parsed = tokenResponse.parse(await res.json());
      return {
        token: parsed.token,
        expiresAt: parsed.expires_at,
        permissions: parsed.permissions,
        repositories: parsed.repositories?.map((r) => r.full_name) ?? [],
      };
    },
  };
}

export type GitHubApp = ReturnType<typeof githubApp>;

/** A token getter for a long-lived caller: re-mints a few minutes before the current token expires. */
export function cachedToken(mint: () => Promise<InstallationToken>, marginMs = 5 * 60_000): () => Promise<string> {
  let current: InstallationToken | undefined;
  return async () => {
    if (!current || Date.parse(current.expiresAt) - Date.now() < marginMs) current = await mint();
    return current.token;
  };
}

/** The runner's credential source: the worker App, scoped to one run's repositories and role. */
export const runTokens =
  (workerApp: GitHubApp): RunGitHubTokens =>
  async ({ repositories, access }) =>
    (await workerApp.mint({ repositories, permissions: RUN_PERMISSIONS[access] })).token;

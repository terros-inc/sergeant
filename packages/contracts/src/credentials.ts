import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// The Linear login `sgt login` saves (TECH-4938), which `sgt` and `sgt-mcp` both send as the caller's
// bearer (TECH-5123). It lives here because client packages may depend only on contracts. The Linear
// token, with its refresh token, is the only credential kept: one per API URL in
// `<XDG_CONFIG_HOME or ~/.config>/sergeant/credentials.json`, readable only by its owner.

export const TOKEN_URL = "https://api.linear.app/oauth/token";

const Credential = z.object({
  clientId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
});
export type Credential = z.infer<typeof Credential>;
const Credentials = z.record(z.string(), Credential);

type Env = Record<string, string | undefined>;

const credentialsFile = (env: Env) => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "sergeant", "credentials.json");

async function readCredentials(env: Env): Promise<z.infer<typeof Credentials>> {
  const raw = await readFile(credentialsFile(env), "utf8").catch(() => undefined);
  return raw === undefined ? {} : Credentials.parse(JSON.parse(raw));
}

export async function loadCredential(env: Env, api: string): Promise<Credential | undefined> {
  return (await readCredentials(env))[api];
}

/** Saves, or with `undefined` forgets, the credential for `api`. */
export async function saveCredential(env: Env, api: string, credential: Credential | undefined): Promise<void> {
  const all = await readCredentials(env);
  if (credential) all[api] = credential;
  else delete all[api];
  const file = credentialsFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // A new file created 0600 then renamed over the old one: writing into an existing file keeps its
  // mode, so the token would land in a file others may read.
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

const TokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().optional() });

/** One request to Linear's token endpoint (a code exchange or a refresh) as the public client `clientId`. */
export async function tokenRequest(fetchFn: typeof fetch, clientId: string, params: Record<string, string>): Promise<Credential> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: clientId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Linear refused the token request (${res.status}): ${text.slice(0, 200)}`);
  const token = TokenResponse.parse(JSON.parse(text));
  return {
    clientId,
    accessToken: token.access_token,
    ...(token.refresh_token && { refreshToken: token.refresh_token }),
    ...(token.expires_in && { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }),
  };
}

/** The access token to send: refreshed (and saved) first when it expires within five minutes; `undefined` when there is none to send. */
export async function currentToken(env: Env, api: string, fetchFn: typeof fetch): Promise<string | undefined> {
  const credential = await loadCredential(env, api);
  if (!credential) return undefined;
  if (!credential.expiresAt || Date.parse(credential.expiresAt) - Date.now() > 5 * 60_000) return credential.accessToken;
  if (!credential.refreshToken) throw new Error("your Linear login expired: run `sgt login` again");
  const fresh = await tokenRequest(fetchFn, credential.clientId, { grant_type: "refresh_token", refresh_token: credential.refreshToken }).catch((e: Error) => {
    throw new Error(`your Linear login could not be renewed (${e.message}): run \`sgt login\` again`);
  });
  await saveCredential(env, api, { refreshToken: credential.refreshToken, ...fresh });
  return fresh.accessToken;
}

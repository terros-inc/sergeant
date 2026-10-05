import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Credential, tokenRequest } from "@terros/sergeant-contracts";

// `sgt login` (TECH-4938): Linear OAuth 2.0 with PKCE, as the human (`actor=user`), against the
// installation's Linear OAuth app, whose public client id the API serves. No client secret is ever on
// a laptop: the PKCE verifier proves this process started the login. The browser comes back to a
// loopback redirect, `http://localhost:4546/callback` (`SGT_LOGIN_PORT` changes the port), which the
// app must list. The resulting Linear token is kept per API URL by contracts' credentials.ts, which
// `sgt-mcp` reads too. The server reads who it is from Linear on every call.

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
/** Enough to read the caller's own user and teams; `sgt` acts in Sergeant, never in Linear. */
const SCOPE = "read";
const DEFAULT_PORT = 4546;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

type Env = Record<string, string | undefined>;

/**
 * Runs the browser login and returns the new credential, unsaved: the caller saves it once the API
 * accepts it. `open` shows the authorize URL to the human.
 */
export async function linearLogin(opts: { clientId: string; env: Env; fetch: typeof fetch; open: (url: string) => void }): Promise<Credential> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const page = (res: ServerResponse, status: number, text: string) =>
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(`${text}\n`);
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") return page(res, 404, "not found");
    // A callback this login did not start (its state differs) ends the login rather than being trusted.
    if (url.searchParams.get("state") !== state) {
      page(res, 400, "This sign-in was not started by this sgt login. Run sgt login again.");
      return settle?.reject(new Error("the browser came back with a different login's state; run `sgt login` again"));
    }
    const got = url.searchParams.get("code");
    if (!got) {
      page(res, 400, `Linear did not sign you in: ${url.searchParams.get("error") ?? "no code"}`);
      return settle?.reject(new Error(`Linear did not sign you in: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code"}`));
    }
    page(res, 200, "Signed in to Sergeant. You can close this tab and return to the terminal.");
    settle?.resolve(got);
  };

  // `localhost` may resolve to either loopback address, so listen on both; IPv6 may be absent.
  const servers: Server[] = [];
  const listen = (host: string, port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer(handler);
      server.once("error", reject);
      server.listen(port, host, () => {
        servers.push(server);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  const port = await listen("127.0.0.1", Number(opts.env.SGT_LOGIN_PORT ?? DEFAULT_PORT)).catch((e: Error) => {
    throw new Error(`cannot listen for the login's redirect on 127.0.0.1 (${e.message}); set SGT_LOGIN_PORT to a free port the Linear app also lists`);
  });
  await listen("::1", port).catch(() => {});
  const redirectUri = `http://localhost:${port}/callback`;
  const timer = setTimeout(() => settle?.reject(new Error("no sign-in within 5 minutes; run `sgt login` again")), LOGIN_TIMEOUT_MS);
  try {
    const authorize = new URL(AUTHORIZE_URL);
    authorize.search = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      actor: "user",
    }).toString();
    opts.open(authorize.toString());
    const got = await code;
    return await tokenRequest(opts.fetch, opts.clientId, { grant_type: "authorization_code", code: got, redirect_uri: redirectUri, code_verifier: verifier });
  } finally {
    clearTimeout(timer);
    // The browser may keep its connection open, which would hold `close` up.
    await Promise.all(servers.map((s) => new Promise((resolve) => (s.close(resolve), s.closeAllConnections()))));
  }
}

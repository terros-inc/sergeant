import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Credential, tokenRequest } from "@terros/sergeant-contracts/credentials";

// `sgt login` (TECH-4938, TECH-6416): Linear OAuth 2.0 with PKCE, as the human (`actor=user`),
// against the installation's Linear OAuth app. The browser normally returns to the loopback redirect.
// On a headless machine the human can instead paste that callback URL (or its code) into sgt; the
// PKCE verifier still proves this process started the exchange, and a URL's state must match it.

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
/** Enough to read the caller's own user and teams; `sgt` acts in Sergeant, never in Linear. */
const SCOPE = "read";
const DEFAULT_PORT = 4546;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

type Env = Record<string, string | undefined>;
type LoginOptions = {
  clientId: string;
  env: Env;
  fetch: typeof fetch;
  paste: boolean;
  show: (url: string) => void;
  warn: (message: string) => void;
  open: (url: string) => boolean | void | Promise<boolean | void>;
  prompt: (message: string, signal: AbortSignal) => Promise<string>;
};

/** Runs the browser or paste login and returns the new credential, unsaved. */
export async function linearLogin(opts: LoginOptions): Promise<Credential> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | undefined;
  const callback = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
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
    const code = url.searchParams.get("code");
    if (!code) {
      page(res, 400, `Linear did not sign you in: ${url.searchParams.get("error") ?? "no code"}`);
      return settle?.reject(new Error(`Linear did not sign you in: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code"}`));
    }
    page(res, 200, "Signed in to Sergeant. You can close this tab and return to the terminal.");
    settle?.resolve(code);
  };

  const configuredPort = Number(opts.env.SGT_LOGIN_PORT ?? DEFAULT_PORT);
  let port = configuredPort;
  const servers: Server[] = [];
  if (!opts.paste) {
    // `localhost` may resolve to either loopback address, so listen on both; IPv6 may be absent.
    port = await listen(handler, servers, "127.0.0.1", configuredPort).catch((error: Error) => {
      opts.warn(`Cannot listen for the login redirect on 127.0.0.1:${configuredPort} (${error.message}); falling back to pasted input. Set SGT_LOGIN_PORT to a free port the Linear app also lists.`);
      return configuredPort;
    });
    if (servers.length) await listen(handler, servers, "::1", port).catch(() => {});
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const authorize = authorizeUrl(opts.clientId, redirectUri, state, verifier);
  opts.show(authorize);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const promptController = new AbortController();
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timer);
    promptController.abort();
    // The browser may keep its connection open, which would hold `close` up.
    await Promise.all(servers.map((server) => new Promise((resolve) => (server.close(resolve), server.closeAllConnections()))));
  };
  try {
    let code: string;
    if (!servers.length) {
      code = await pastedCode(opts.prompt, state, promptController.signal);
    } else {
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, LOGIN_TIMEOUT_MS)));
      const promptNeeded = (async () => {
        const opened = await Promise.race([
          Promise.resolve().then(() => opts.open(authorize)).catch(() => false),
          timeout.then(() => false),
        ]);
        if (opened !== false) await timeout;
        return pastedCode(opts.prompt, state, promptController.signal);
      })();
      // Keep accepting the loopback while fallback input is visible. The winner closes the other path.
      code = await Promise.race([callback, promptNeeded]);
    }
    await cleanup();
    return await tokenRequest(opts.fetch, opts.clientId, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  } finally {
    await cleanup();
  }
}

function authorizeUrl(clientId: string, redirectUri: string, state: string, verifier: string): string {
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    actor: "user",
  }).toString();
  return authorize.toString();
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, servers: Server[], host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(port, host, () => {
      servers.push(server);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function pastedCode(prompt: LoginOptions["prompt"], state: string, signal: AbortSignal): Promise<string> {
  const value = (await prompt("Paste the callback URL or code, then press Enter: ", signal)).trim();
  if (!value) throw new Error("no callback URL or code was pasted; run `sgt login --paste` again");
  return callbackCode(value, state);
}

/** A bare code has no state field; PKCE binds it to this login. Callback URLs must carry our state. */
function callbackCode(value: string, state: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  if (url.searchParams.get("state") !== state) throw new Error("the pasted callback has a different login's state; run `sgt login` again");
  const code = url.searchParams.get("code");
  if (code) return code;
  throw new Error(`Linear did not sign you in: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code"}`);
}

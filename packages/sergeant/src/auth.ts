import type { LinearUser } from "@terros/sergeant-linear";
import type { InstallationConfig } from "./config.ts";

// Who is calling the client API (TECH-4938). A human signs in to `sgt` with their own Linear login
// (`sgt login`: Linear OAuth with PKCE, as themselves) and `sgt` sends that access token as a bearer.
// Every call reads the Linear user the token acts as, with that token, and admits an active user of
// the installation's own Linear workspace, never one of Sergeant's agents, who is in a configured
// team or is a configured approver. Nothing is stored or cached, so revoking the token, deactivating
// the user, or removing them from the team ends their access at their next call. Linear cannot say
// which OAuth app a token was issued to, so another app's token for the same user is that user too;
// that app could already act as them in Linear.
//
// The other caller is an operator on the host itself, trusted only under `serve --trust-loopback`,
// which refuses to start on any but a loopback interface (service.ts).

export type Caller =
  | { kind: "linear"; user: { id: string; name: string; email: string }; approver: boolean }
  | { kind: "loopback"; approver: true };

/** 401: no caller is proven. 403: the caller is proven and may not use the API. */
export class CallerRefused extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

export type Humans = NonNullable<InstallationConfig["humans"]>;

/** Resolves a Linear access token to its caller, or throws `CallerRefused`; any other throw is Linear unavailable. */
export function linearCallers(opts: {
  humans: Humans;
  organizationId: string;
  agentUserIds: string[];
  lookup: (accessToken: string) => Promise<LinearUser | undefined>;
}): (accessToken: string) => Promise<Caller> {
  return async (accessToken) => {
    const user = await opts.lookup(accessToken);
    if (!user) throw new CallerRefused(401, "Linear does not accept this login: sign in again with `sgt login`");
    const who = `${user.name} (${user.email})`;
    if (user.organizationId !== opts.organizationId) throw new CallerRefused(403, `${who} is not in this Sergeant's Linear workspace`);
    if (!user.active) throw new CallerRefused(403, `${who} is not an active Linear user`);
    if (opts.agentUserIds.includes(user.id)) throw new CallerRefused(403, `${who} is one of Sergeant's agents, not a human`);
    const approver = opts.humans.approvers.includes(user.id);
    if (!approver && !user.teamKeys.some((key) => opts.humans.teams.includes(key))) {
      throw new CallerRefused(403, `${who} is in none of this Sergeant's Linear teams (${opts.humans.teams.join(", ")})`);
    }
    return { kind: "linear", user: { id: user.id, name: user.name, email: user.email }, approver };
  };
}

/** How a caller is named in logs and on Linear. */
export const callerName = (caller: Caller) => (caller.kind === "linear" ? caller.user.name : "an operator on the Sergeant host");

export const isLoopbackHost = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host);

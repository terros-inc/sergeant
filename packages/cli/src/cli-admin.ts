import { AdminRequestResponse, AdminStatus } from "@terros/sergeant-contracts";
import { showOutcome, showStatus, staleConfig, waitForOutcome } from "./admin.ts";
import { type Command, type Context, call, client, Failure, print, settle } from "./cli-call.ts";

// `sgt admin status`, `restart`, and `update`: an approver's view of the host and its two actions.

export const adminCommands: Record<string, Command> = {
  "admin status": {
    args: 0,
    run: async (ctx) => {
      const status = await call(ctx, "GET", "/v1/admin/status", AdminStatus);
      print(ctx, status, () => showStatus(status));
    },
  },
  "admin restart": {
    args: 0,
    run: (ctx) => adminRequest(ctx, "restart", {}),
  },
  "admin update": {
    args: 0,
    optional: 1,
    run: (ctx, [ref]) => adminRequest(ctx, "update", ref === undefined ? {} : { ref }),
  },
};

/** Hands the host the request, then waits for and prints its outcome: exit 1 when it failed. */
async function adminRequest(ctx: Context, action: "restart" | "update", body: { ref?: string }): Promise<void> {
  const { request, last } = await call(ctx, "POST", `/v1/admin/${action}`, AdminRequestResponse, body);
  ctx.io.err(`${action}${request.ref ? ` to ${request.ref}` : ""} requested (${request.id}); waiting for the host\n`);
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = () => client(ctx).call("GET", "/v1/admin/status", AdminStatus);
  const outcome = settle(ctx, await waitForOutcome(request, last, read, { sleep, say: (line) => ctx.io.err(`${line}\n`), now: Date.now }));
  // TECH-5205: nothing newer to install, but the installation config changed since serve started: only a restart rereads it.
  const stale = outcome.outcome === "unchanged" ? await read().then((s) => (s.ok ? staleConfig(s.value) : undefined)) : undefined;
  print(ctx, { request, outcome }, () => (stale ? `${showOutcome(outcome)}\n${stale}` : showOutcome(outcome)));
  if (outcome.outcome === "failed") throw new Failure(outcome.message);
}

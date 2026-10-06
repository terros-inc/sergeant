import { AdminRequestResponse, AdminStatus } from "@terros/sergeant-contracts";
import { showOutcome, showStatus, staleConfig, waitForOutcome } from "./admin.ts";
import { answered, type Command, type Context, callAnswer, client, Failure, print, settle } from "./cli-call.ts";

// `sgt admin status`, `restart`, and `update`: an approver's view of the host and its two actions.

export const adminCommands: Record<string, Command> = {
  "admin status": {
    args: 0,
    run: async (ctx) => {
      const { value: status, answer } = await callAnswer(ctx, "GET", "/v1/admin/status", AdminStatus);
      print(ctx, answer, () => showStatus(status));
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

/**
 * Hands the host the request, then waits for and prints its outcome: exit 1 when it failed. `--json`'s
 * request and outcome are as the API sent them, like every other answer (TECH-5224).
 */
async function adminRequest(ctx: Context, action: "restart" | "update", body: { ref?: string }): Promise<void> {
  const requested = await callAnswer(ctx, "POST", `/v1/admin/${action}`, AdminRequestResponse, body);
  const { request, last } = requested.value;
  ctx.io.err(`${action}${request.ref ? ` to ${request.ref}` : ""} requested (${request.id}); waiting for the host\n`);
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let status: unknown;
  const read = async () => {
    const res = answered("GET", "/v1/admin/status", AdminStatus, await client(ctx).request("GET", "/v1/admin/status"));
    if (!res.ok) return res;
    status = res.value.answer;
    return { ok: true as const, value: res.value.value };
  };
  const outcome = settle(ctx, await waitForOutcome(request, last, read, { sleep, say: (line) => ctx.io.err(`${line}\n`), now: Date.now }));
  const sent = { request: (requested.answer as { request: unknown }).request, outcome: (status as { last: unknown }).last };
  // TECH-5205: nothing newer to install, but the installation config changed since serve started: only a restart rereads it.
  const stale = outcome.outcome === "unchanged" ? await read().then((s) => (s.ok ? staleConfig(s.value) : undefined)) : undefined;
  print(ctx, sent, () => (stale ? `${showOutcome(outcome)}\n${stale}` : showOutcome(outcome)));
  if (outcome.outcome === "failed") throw new Failure(outcome.message);
}

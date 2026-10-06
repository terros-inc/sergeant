import type { AdminRequest, AdminResult, AdminStatus, ApiFailure, ApiResult } from "@terros/sergeant-contracts";

// `sgt admin restart` and `sgt admin update` (TECH-5195) hand the host a request and then wait for its
// outcome, reading `GET /v1/admin/status` until the outcome names their request. serve is down for part of
// any restart, so an unreachable API is waited out; any other refusal ends the wait. The host keeps only
// its latest outcome, and records a request running before it stops being pending. So once the request is
// neither pending nor the latest outcome, an outcome other than the one current when it was made (another
// action's, or an automatic update's) replaced its own before it was read: that ends the wait too.

/** Long enough for serve's graceful stop (up to 15 minutes), an install, and a rollback. */
export const WAIT_MINUTES = 45;
const EVERY_MS = 5000;

export async function waitForOutcome(
  request: Pick<AdminRequest, "id" | "action">,
  before: AdminResult | null,
  read: () => Promise<ApiResult<AdminStatus>>,
  io: { sleep: (ms: number) => Promise<void>; say: (line: string) => void; now: () => number },
): Promise<{ ok: true; value: AdminResult } | { ok: false; error: ApiFailure }> {
  const deadline = io.now() + WAIT_MINUTES * 60_000;
  let said = "";
  for (;;) {
    const res = await read();
    let line: string;
    if (res.ok) {
      const { pending, last } = res.value;
      const { id } = request;
      if (last?.id === id && last.outcome !== "running") return { ok: true, value: last };
      if (last?.id === id) line = `running: ${last.message}`;
      else if (pending?.id === id) line = last?.outcome === "running" ? `waiting for the host to finish: ${last.message}` : "waiting for the host to take it";
      else if (last && !(before && last.id === before.id && last.action === before.action && last.startedAt === before.startedAt)) {
        const replaced = `the host took your ${request.action} (${id}), but ${last.action} by ${last.by} replaced its outcome before sgt read it`;
        return { ok: false, error: { code: "conflict", message: `${replaced}: \`sgt admin status\` shows the latest, and the host's autoupdate.log has yours` } };
      } else line = "waiting for the host";
    } else if (res.error.code === "unavailable") {
      line = "serve is restarting";
    } else {
      return res;
    }
    if (line !== said) io.say((said = line));
    if (io.now() >= deadline) {
      return { ok: false, error: { code: "unavailable", message: `no outcome after ${WAIT_MINUTES} minutes; \`sgt admin status\` shows it once the host has one` } };
    }
    await io.sleep(EVERY_MS);
  }
}

export function showOutcome(r: AdminResult): string {
  const line = `${r.outcome}: ${r.message}`;
  return r.output ? `${line}\n\nlast lines of the update's output:\n${r.output}` : line;
}

export function showStatus(s: AdminStatus): string {
  const lines = [`serve    ${s.serve.version}, started ${s.serve.startedAt}`];
  lines.push(s.release ? `release  ${s.release.ref === s.release.sha ? s.release.sha : `${s.release.ref} at ${s.release.sha}`}, installed ${s.release.at}` : "release  unknown");
  if (s.pending) lines.push(`pending  ${s.pending.action}${s.pending.ref ? ` to ${s.pending.ref}` : ""} by ${s.pending.by}, asked ${s.pending.at}`);
  const last = s.last;
  if (last) {
    const when = last.finishedAt ? `${last.startedAt} to ${last.finishedAt}` : `since ${last.startedAt}`;
    lines.push(`last     ${last.action}${last.ref ? ` to ${last.ref}` : ""} by ${last.by} (${when})`, `         ${showOutcome(last)}`);
  } else {
    lines.push("last     no restart or update recorded");
  }
  const config = s.config;
  if (s.runs) lines.push(`runs     ${s.runs.count} in ${gb(s.runs.bytes)}; data volume ${gb(s.runs.volumeFreeBytes)} free of ${gb(s.runs.volumeBytes)}`);
  if (s.github) lines.push(`github   ${githubBudget(s.github)}`);
  if (config) lines.push(`config   ${staleConfig(s) ?? (config.current === null ? `version ${config.loaded}; serve cannot read the parameter now (serve.log says why)` : `version ${config.loaded}, as serve has it`)}`);
  return lines.join("\n");
}

/** TECH-5336: the control-plane App's API calls left this hour, and any rate-limit pause. */
function githubBudget(g: NonNullable<AdminStatus["github"]>): string {
  const left = g.remaining === null ? "API budget unknown" : `${g.remaining}${g.limit === null ? "" : ` of ${g.limit}`} API calls left`;
  const reset = g.resetAt ? `, resets ${g.resetAt}` : "";
  const seen = g.observedAt ? ` (as of ${g.observedAt})` : "";
  return `${left}${reset}${seen}${g.pausedUntil ? `; rate limited, no GitHub calls until ${g.pausedUntil}` : ""}`;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** TECH-5205: what to do when the installation-config parameter changed since serve started; undefined when it did not. */
export function staleConfig(s: AdminStatus): string | undefined {
  const c = s.config;
  if (!c || c.current === null || c.current === c.loaded) return undefined;
  return `version ${c.current} in AWS, but serve has version ${c.loaded}: the installation config changed since serve started, so run \`sgt admin restart\` to reread it`;
}

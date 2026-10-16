import type { ApiBudgetSample, ApiUsage } from "@terros/sergeant-contracts";

// `sgt admin api [--hours N]` (TECH-6208): what spent Sergeant's GitHub and Linear API budgets. Each
// hour's calls per provider with the 304s GitHub does not count, by source and by endpoint (the 10
// busiest; `--json` has all of them and every 5-minute budget sample); GitHub's budget windows with
// the calls serve did not make; each hour's lowest budget; rate-limit pauses and the tasks they
// paused; and low-budget warnings.

const TOP = 10;
const clock = (iso: string) => iso.slice(11, 19) + "Z";
const day = (iso: string) => `${iso.slice(0, 10)} ${clock(iso)}`;

export function showApiUsage(u: ApiUsage, hours: number): string {
  const lines = [`API usage since ${day(u.since)} (${hours} hour${hours === 1 ? "" : "s"}), as serve recorded it`];
  const section = (title: string, rows: string[]) => {
    lines.push("", `${title}:`);
    lines.push(...(rows.length > 0 ? rows.map((r) => `  ${r}`) : ["  none"]));
  };

  section("rate-limit pauses", u.events.map((e) => {
    const ended = e.endedAt ?? e.until;
    const seconds = Math.round((Date.parse(ended) - Date.parse(e.startedAt)) / 1000);
    const span = e.endedAt ? `${day(e.startedAt)} to ${clock(e.endedAt)} (${seconds} s)` : `${day(e.startedAt)}, paused until ${clock(e.until)} (${seconds} s)`;
    const tasks = e.tasks.length > 0 ? `; paused ${e.tasks.length} task${e.tasks.length === 1 ? "" : "s"}: ${e.tasks.join(", ")}` : "; paused no task";
    return `${e.provider} ${e.kind === "linear" ? "" : `${e.kind} `}limit (HTTP ${e.status}) ${span}, ${e.refusals} refused call${e.refusals === 1 ? "" : "s"}${tasks}`;
  }));

  section("low-budget warnings", u.alerts.map((a) => `${day(a.at)} ${a.provider} ${a.resource}: ${a.remaining} of ${a.limit} left, resets ${clock(a.resetAt)}`));

  section("GitHub budget windows (spent: what GitHub's remaining fell by; serve: the calls it counted that GitHub counts)", u.windows.map((w) => {
    const spent = w.firstRemaining - w.lowestRemaining;
    const gap = spent - w.counted;
    return `${w.resource} resetting ${day(w.resetAt)}: ${w.lowestRemaining} of ${w.limit} left at ${clock(w.lastAt)}; from ${clock(w.firstAt)} spent ${spent}, serve ${w.counted}, other ${gap > 0 ? gap : 0}`;
  }));

  section("lowest budget each hour", lowestPerHour(u.samples));

  const hourList = [...new Set([...u.sources.map((c) => c.hour), ...u.endpoints.map((c) => c.hour)])].sort();
  section("calls per hour (304s: answered Not Modified, which GitHub's rate limit does not count)", hourList.flatMap((hour) =>
    (["github", "linear"] as const).flatMap((provider) => {
      const sources = u.sources.filter((c) => c.hour === hour && c.provider === provider);
      if (sources.length === 0) return [];
      const total = sources.reduce((n, c) => n + c.calls, 0);
      const notModified = sources.reduce((n, c) => n + c.notModified, 0);
      const endpoints = u.endpoints.filter((c) => c.hour === hour && c.provider === provider).map((c) => ({ ...c, name: c.endpoint }));
      return [
        `${provider} ${day(hour)}: ${total} calls${provider === "github" ? `, ${notModified} 304s, ${total - notModified} counted` : ""}`,
        `  by source: ${listed(sources.map((c) => ({ ...c, name: c.source })))}`,
        `  by endpoint: ${listed(endpoints)}`,
      ];
    }),
  ));
  return lines.join("\n");
}

/** The busiest first, as the API sorts them: `GET /repos/{o}/{r}/pulls/{n} 812 (304: 400)`. */
function listed(of: { name: string; calls: number; notModified: number }[]): string {
  const shown = of.slice(0, TOP).map((c) => `${c.name} ${c.calls}${c.notModified ? ` (304: ${c.notModified})` : ""}`);
  return shown.join(", ") + (of.length > TOP ? `, and ${of.length - TOP} more` : "");
}

/** Each hour's lowest sample per budget, oldest hour first. */
function lowestPerHour(samples: ApiBudgetSample[]): string[] {
  const lowest = new Map<string, ApiBudgetSample>();
  for (const s of samples) {
    const key = `${s.at.slice(0, 13)} ${s.provider} ${s.resource}`;
    const was = lowest.get(key);
    if (!was || s.remaining < was.remaining) lowest.set(key, s);
  }
  return [...lowest].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => `${s.at.slice(0, 10)} ${s.at.slice(11, 13)}:00:00Z ${s.provider} ${s.resource}: ${s.remaining} of ${s.limit} at ${clock(s.at)}, resets ${clock(s.resetAt)}`);
}

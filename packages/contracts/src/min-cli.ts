// The one rule between `sgt` (or `sgt-mcp`) and the hosted Sergeant API (TECH-5185): there is no
// backward or forward compatibility between them, and people keep their CLI current (`sgt update`).
// `serve` sends on every `/v1` answer the oldest CLI version it supports. A client older than that
// refuses to go on; one whose own minimum is above the server's (or whose server sends none) is newer
// than the server across a breaking change, and warns. Raise MIN_CLI_VERSION in the change that makes
// an older client unable to work with this server (a removed, retyped, or newly required field, a new
// enum value), to that change's version: main's version before it plus one (`sgt --version`). A value
// a few commits low only lets those commits' clients through; a value too high refuses current ones.

export const MIN_CLI_VERSION = "2.1.61";
export const MIN_CLI_HEADER = "Sergeant-Min-Cli-Version";
export const CLI_TOO_OLD = "Your sgt is older than this Sergeant server supports. Run `sgt update`.";

/** Whether version `a` is older than `b`, by MAJOR.MINOR.PATCH (sergeantVersion's form, its `+sha` ignored); unparsable is 0.0.0. */
export function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? []).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

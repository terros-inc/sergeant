import { open } from "node:fs/promises";
import { exportLedger, parseRange } from "./ledger-export.ts";

// TECH-5922: the operator entry point for the read-only ledger export (ledger-export.ts). Run it on the
// Sergeant host, against the same `--state-dir` `serve` uses, from the repository checkout:
//
//   node packages/sergeant/src/ledger-export-cli.ts \
//     --state-dir "$SERGEANT_STATE_DIR" --since 2026-09-29 --until 2026-10-12 \
//     --out sergeant-ledger-2026-09-29_2026-10-12.jsonl
//
// It reads files only, touches no live service, and changes no runtime behaviour. See docs/ledger-export.md.

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const stateDir = flag(argv, "state-dir");
  const since = flag(argv, "since");
  const until = flag(argv, "until");
  const outFile = flag(argv, "out");
  if (!stateDir || !since || !until) {
    err("usage: ledger-export-cli --state-dir <dir> --since YYYY-MM-DD --until YYYY-MM-DD [--out file.jsonl]\n");
    return 2;
  }
  const range = parseRange(since, until);
  const sink = outFile ? await open(outFile, "w") : undefined;
  let count = 0;
  for await (const rec of exportLedger(stateDir, range)) {
    const line = `${JSON.stringify(rec)}\n`;
    if (sink) await sink.write(line);
    else out(line);
    count += 1;
  }
  await sink?.close();
  err(`wrote ${count} record${count === 1 ? "" : "s"}${outFile ? ` to ${outFile}` : ""}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));

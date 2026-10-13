import { readFile } from "node:fs/promises";
import { parseExport, report } from "./budget-analysis.ts";

// TECH-5922: run the budget-window analysis over a ledger export (see docs/ledger-export.md):
//
//   node packages/sergeant/src/budget-analysis-cli.ts --in sergeant-ledger-2026-09-29_2026-10-12.jsonl
//
// Prints the report as JSON to stdout. It reads only the export file.

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const inFile = flag(argv, "in");
  if (!inFile) {
    err("usage: budget-analysis-cli --in <export.jsonl>\n");
    return 2;
  }
  const records = parseExport(await readFile(inFile, "utf8"));
  out(`${JSON.stringify(report(records), null, 2)}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));

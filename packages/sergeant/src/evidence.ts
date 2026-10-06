// Natural-use evidence for a live-check ticket (TECH-5279, evidence-search.ts): searches Sergeant's own
// records for a new path having run in production and prints a citation to paste on the ticket. Reads
// only the local state directory; no credential, no network. From packages/sergeant on the host
// (docs/live-verification.md):
//
//   sudo -u sergeant node src/evidence.ts --match <regex> [--since <ISO time>] [--issue TECH-123]
//                                         [--state-dir /var/lib/sergeant/state] [--limit 10]
//
// Exit code 0 when there is supporting evidence and nothing contrary, 1 otherwise, 2 on a usage error.
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { sergeantVersion } from "@terros/sergeant-contracts/version";
import { citation, searchEvidence } from "./evidence-search.ts";

const { values } = parseArgs({
  options: {
    match: { type: "string" },
    since: { type: "string" },
    issue: { type: "string" },
    "state-dir": { type: "string", default: "/var/lib/sergeant/state" },
    limit: { type: "string", default: "10" },
  },
});
const pattern = values.match ?? fail("--match <regex> is required: text that only the new path writes into a record");
let match: RegExp;
try {
  match = new RegExp(pattern, "i");
} catch (e) {
  fail(`--match is not a regular expression: ${(e as Error).message}`);
}
const since = values.since === undefined ? undefined : new Date(values.since);
if (since && Number.isNaN(since.getTime())) fail("--since must be a date or time, such as 2026-10-06 or 2026-10-06T08:00:00Z");
const limit = Number(values.limit);
if (!(Number.isInteger(limit) && limit > 0)) fail("--limit must be a positive whole number");

// A wrong directory would read as "no evidence", which can close a ticket as stale.
if (!(await stat(values["state-dir"]).catch(() => undefined))?.isDirectory()) fail(`no state directory at ${values["state-dir"]}`);

const query = { match, since: since?.toISOString(), issue: values.issue };
const hits = await searchEvidence(values["state-dir"], query);
const { text, exitCode } = citation(hits, { query, version: sergeantVersion().version, host: hostname(), searchedAt: new Date().toISOString(), limit });
console.log(text);
process.exit(exitCode);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

#!/usr/bin/env node
// Flags customer data headed for a public repository (TECH-5914): Terros IDs (`C.`, `U.`, `Program.`,
// `Account.` and the like), email addresses, phone numbers, and customer names from a denylist that is
// never committed to a public repository. Synthetic placeholders (`C.example`, `user@example.test`,
// 555-01xx numbers) pass. It never prints a denylisted name, only where it was found.
//
//   check-public-data.mjs range <base> <head>       commits in base..head, merges included: messages,
//                                                   author and committer, added lines (binary files
//                                                   too, as text), file paths (renames too)
//   check-public-data.mjs text <label>              stdin, for example a PR title and body or a branch name
//   check-public-data.mjs pre-push <remote> [<url>] as a git pre-push hook: refs on stdin
//
// The denylist is `PUBLIC_DATA_DENYLIST` (one name per line or comma) and/or the file named by
// `PUBLIC_DATA_DENYLIST_FILE`. A name of three or more characters matches in any case; a two-character
// name (`3M`) matches only in its listed case, and a one-character name is a configuration error.
// Exits 1 on a finding, 2 on a usage, configuration or git error. Node only, no
// dependencies: the canonical copy is terros-inc/sergeant `packages/runner/container/`, and other
// public repositories vendor it unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PLACEHOLDER_ID = /example|placeholder|sample|fake|test|dummy/i;
const ID_PREFIXES = ["C", "U", "Program", "Account", "Role", "Group", "Team"];
// A Terros ID, the exact rule: one of ID_PREFIXES, then `.` or `:`, then its key, the whole run of
// letters, digits, `_` and `-` that follows (any length, so short keys and UUIDs too). The prefix must not
// follow a letter, digit, `_` or `.`, and the key must not be followed by `(` (a method call). The key is
// a Terros ID when it is 4 or more characters, names no placeholder (PLACEHOLDER_ID), and either has a
// digit or mixes case with two or more capitals. So keys such as `Qx7Lp2Rk`, `ab12`, `QxLpRkTz` or a
// UUID fail after any prefix, while `C.example`, `Role.manager`, `Team.teamId`, `Role.ADMIN`,
// `Program.Status`, `Account.findById(` and bare SHAs or timestamps (no prefix) pass. An all-lowercase
// or all-capital key with no digit cannot be told from an ordinary property name, so it passes.
const ID = new RegExp(`(?<![\\w.])(?:${ID_PREFIXES.join("|")})[.:]([A-Za-z0-9_-]{4,})(?![\\w-]|\\()`, "g");
const isId = (key) => !PLACEHOLDER_ID.test(key) && (/\d/.test(key) || (/[A-Z].*[A-Z]/.test(key) && /[a-z]/.test(key)));
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
// North American numbers with separators, so digit runs (SHAs, timestamps, IDs) are not numbers.
const PHONE = /(?<![\w.+-])(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?(\d{3})[\s.-](\d{4})(?![\w-])/g;
const E164 = /(?<![\w+])\+\d{10,15}(?!\w)/g;

const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
// Public machine addresses: git's SSH user, no-reply senders, and coding agents' commit identities.
const PLACEHOLDER_ADDRESS = /^(git@github\.com|[^@]*no-?reply@.*|.*@users\.noreply\.github\.com|codex@openai\.com|cursoragent@cursor\.com)$/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The denylisted names, each as a whole-word pattern: case-insensitive, or in its listed case for a two-character name. */
function denylist(env = process.env) {
  const text = [env.PUBLIC_DATA_DENYLIST ?? "", env.PUBLIC_DATA_DENYLIST_FILE ? readFileSync(env.PUBLIC_DATA_DENYLIST_FILE, "utf8") : ""].join("\n");
  const names = new Set(text.split(/[\n,]/).map((n) => n.trim()).filter(Boolean));
  if ([...names].some((n) => n.length < 2)) throw new Error("a denylist entry is a single character; remove it");
  // A name's words may be joined by a space, `-`, `_`, `.`, or nothing, as in a branch name or file path.
  return [...names].map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${n.split(/\s+/).map(escape).join("[\\s_.-]*")}(?![\\p{L}\\p{N}])`, n.length < 3 ? "u" : "iu"));
}

/** The kinds of customer data in one line of text; never the denylisted name itself. */
function findings(line, names) {
  const found = [];
  for (const m of line.matchAll(ID)) if (isId(m[1])) found.push("Terros ID");
  for (const m of line.matchAll(EMAIL)) if (!PLACEHOLDER_DOMAIN.test(m[1]) && !PLACEHOLDER_ADDRESS.test(m[0])) found.push("email address");
  for (const m of line.matchAll(PHONE)) if (!(m[1] === "555" && m[2].startsWith("01"))) found.push("phone number");
  for (const m of line.matchAll(E164)) if (!/^\+1\d{3}55501\d\d$/.test(m[0])) found.push("phone number");
  if (names.some((name) => name.test(line))) found.push("denylisted customer name");
  return [...new Set(found)];
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Findings in `text`, each `<where>:<line>: <kind>`. */
function scanText(text, where, names) {
  return text.split("\n").flatMap((line, i) => findings(line, names).map((kind) => `${where}:${i + 1}: ${kind}`));
}

/** A file path fit to print: one that itself holds customer data is not printed. */
const shown = (file, names) => (findings(file, names).length ? "(a file path with customer data)" : file);

/** Findings in commits: each message, author and committer, each added or renamed file path, and each
 * added line. Binary files are read as text (`--text`), so a `.gitattributes` `-diff` or `binary` mark
 * hides nothing; compressed formats (PDF, zip, images) still are not decoded. A merge commit's content
 * is what it adds beyond git's own merge of its parents (`--remerge-diff`): a conflict resolution or an
 * evil merge. Its parents' commits are in the same range, or already on the remote. */
function scanCommits(shas, names) {
  const out = [];
  for (const sha of shas) {
    const short = sha.slice(0, 12);
    out.push(...scanText(git("log", "-1", "--format=%B", sha), `commit ${short} message`, names));
    // An author or committer address is a person's own, so only the other kinds count there.
    const identity = git("log", "-1", "--format=%an <%ae>%n%cn <%ce>", sha);
    out.push(...scanText(identity, `commit ${short} author/committer`, names).filter((f) => !f.endsWith(": email address")));
    const merge = git("rev-list", "--no-walk", "--parents", sha).trim().split(" ").length > 2;
    const show = (...args) => git("-c", "core.quotePath=false", "show", "--format=", "--no-color", "--no-ext-diff", "--diff-filter=d", ...(merge ? ["--remerge-diff"] : []), ...args, sha);
    // Every path the commit adds, changes or renames to, an empty or rename-only file included.
    for (const file of show("--name-only", "--no-renames", "-z").split("\0").filter(Boolean)) {
      out.push(...findings(file, names).map((kind) => `commit ${short} ${shown(file, names)} (file path): ${kind}`));
    }
    // Added lines. A `+++ ` line is a file header only between hunks: inside one it is an added line
    // that starts with `++ `, so the parser counts each hunk's lines from its `@@` header.
    let file = "";
    let line = 0;
    let oldLeft = 0;
    let newLeft = 0;
    for (const l of show("--text", "--unified=0").split("\n")) {
      if (oldLeft > 0 || newLeft > 0) {
        if (l.startsWith("+")) {
          out.push(...findings(l.slice(1), names).map((kind) => `commit ${short} ${shown(file, names)}:${line}: ${kind}`));
          line++;
          newLeft--;
        } else if (l.startsWith("-")) oldLeft--;
        else if (l.startsWith(" ")) {
          line++;
          oldLeft--;
          newLeft--;
        }
      } else if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
      else if (l.startsWith("@@ ")) {
        const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (!m) throw new Error(`commit ${short}: unexpected hunk header`);
        oldLeft = Number(m[1] ?? 1);
        line = Number(m[2]);
        newLeft = Number(m[3] ?? 1);
      }
    }
  }
  return out;
}

const commitsIn = (...revs) => git("rev-list", ...revs).split("\n").filter(Boolean);

function prePush(remote, input, names) {
  const out = [];
  for (const ref of input.split("\n").filter(Boolean)) {
    const [, localSha, remoteRef] = ref.split(" ");
    if (!localSha || /^0+$/.test(localSha)) continue; // a deletion
    out.push(...scanText(remoteRef.replace(/^refs\/heads\//, ""), "branch name", names));
    // Whatever the remote does not have yet, whether the branch is new or rebased.
    out.push(...scanCommits(commitsIn(localSha, "--not", `--remotes=${remote}`), names));
  }
  return out;
}

function main([mode, ...args]) {
  const names = denylist();
  const stdin = () => readFileSync(0, "utf8");
  let out;
  if (mode === "range" && args.length === 2) out = scanCommits(commitsIn(`${args[0]}..${args[1]}`), names);
  else if (mode === "text" && args.length === 1) out = scanText(stdin(), args[0], names);
  else if (mode === "pre-push" && args.length >= 1) out = prePush(args[0], stdin(), names);
  else {
    console.error("usage: check-public-data.mjs range <base> <head> | text <label> | pre-push <remote> [<url>]");
    return 2;
  }
  if (!names.length) console.error("public-data-check: no customer-name denylist (PUBLIC_DATA_DENYLIST); checking IDs, emails and phone numbers only");
  if (!out.length) return 0;
  console.error(`public-data-check: customer data in a public repository:\n${out.map((f) => `  ${f}`).join("\n")}
Replace it with synthetic placeholders (C.example, user@example.test, 555-0100, "Acme Solar") and describe
a real case generically. For a commit, amend or rebase it; a pushed PR stays public record (TECH-5914).`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`public-data-check: ${e.message}`);
  process.exitCode = 2;
}

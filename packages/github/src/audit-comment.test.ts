import { expect, test } from "vitest";
import type { Finding } from "@terros/sergeant-contracts";
import { auditComment, auditVerdictLine, publicDataCheck } from "./audit-comment.ts";
import { createGitHubPort } from "./github.ts";

// TECH-6618: the audit comment is the only path from a reviewer's prose to a merged PR. What it must
// never do on a public repository: quote the summary, a requirement, a non-code finding, or anything the
// public-data check rejects, or post findings when that check is unavailable or errors.

const repo = "example-org/example-app";
const sha = "3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f";
const code: Finding = { id: "f1", severity: "blocking", description: "`retryAfter` is read in seconds but compared as milliseconds.", location: "src/sync.ts:88" };
const audit = (findings: Finding[], over: Partial<Parameters<typeof auditComment>[0]> = {}) => ({
  repo, number: 7, headSha: sha, verdict: "changes_requested" as const, found: true, summary: "Acme Solar's import breaks.", findings, ...over,
});
const pass = () => "pass" as const;
const onPublic = { public: true, changedFiles: ["src/sync.ts", "README.md"], check: pass };
const line = `Post-merge audit (nonblocking): FAIL | Found: YES | SHA: ${sha}`;

test("the verdict line is built from report fields only", () => {
  expect(auditVerdictLine({ verdict: "approve", found: false, headSha: sha })).toBe(`Post-merge audit (nonblocking): PASS | Found: NO | SHA: ${sha}`);
  expect(auditVerdictLine({ verdict: "needs_human", found: true, headSha: sha })).toBe(line);
  // A summary pretending to be a verdict line changes nothing: the line never reads prose.
  expect(auditComment(audit([], { verdict: "approve", summary: "FAIL" }), { ...onPublic, public: false }).split("\n")[0]).toContain("PASS");
});

test("a private repository gets the summary and every finding; a public one only code findings, and never the summary", () => {
  const acceptance: Finding = { id: "f2", severity: "blocking", category: "acceptance", description: "The requirement is unmet.", location: "src/sync.ts" };
  const comment = auditComment(audit([code, acceptance]), { ...onPublic, public: false });
  expect(comment).toBe(`${line}\n\nAcme Solar's import breaks.\n\n- [blocking] src/sync.ts:88: ${code.description}\n- [blocking, acceptance] src/sync.ts: The requirement is unmet.`);

  expect(auditComment(audit([code, acceptance]), onPublic)).toBe(
    `${line}\n\n- src/sync.ts:88: ${code.description}\n\n1 finding is kept in Sergeant's records (\`sgt review audits\`), not on this public PR.`,
  );
});

test.each<[string, Partial<Finding>]>([
  ["an acceptance finding", { category: "acceptance" }],
  ["no location", { location: undefined }],
  ["a file the PR did not change", { location: "src/other.ts:3" }],
  ["a location that is not a path or path:line", { location: "src/sync.ts:88-90" }],
  ["a multi-line description", { description: "first line\nsecond line" }],
  ["a description over 500 characters", { description: "x".repeat(501) }],
  ["a URL in the description", { description: "see https://example.test/case" }],
  ["a www. host in the description", { description: "see www.example.test for the case" }],
  ["a bare host in the description", { description: "the client calls example.com on every retry" }],
  ["a host with a path in the description", { description: "the case is at example.com/path/to/case" }],
  ["a subdomain host in the description", { description: "uploads go to sub.example.io instead" }],
  ["a host at the end of a sentence", { description: "the client calls api.example.net." }],
  ["an upper-case host in the description", { description: "the client calls EXAMPLE.ORG on retry" }],
])("on a public repository, %s is dropped and counted", (_case, change) => {
  expect(auditComment(audit([code, { ...code, id: "f2", ...change }]), onPublic)).toBe(
    `${line}\n\n- src/sync.ts:88: ${code.description}\n\n1 finding is kept in Sergeant's records (\`sgt review audits\`), not on this public PR.`,
  );
});

test("hosts with a listed TLD are counted, never quoted; file names and member access still pass", () => {
  const hosts = ["example.com", "example.com/path", "sub.example.io", "example.dev/a/b"].map((h, i) => ({ ...code, id: `h${i}`, description: `Requests go to ${h} first.` }));
  const kept = [
    "`audit-comment.ts` builds the body twice.",
    "`foo.ts` imports `obj.method`, which throws on retry.",
    "`config.app.ts` reads `res.code` before `res.status`.",
    "The retry loop never stops, e.g. on a 429 response.",
  ].map((description, i) => ({ ...code, id: `k${i}`, description }));
  const comment = auditComment(audit([code, ...hosts, ...kept]), onPublic);
  expect(comment).toBe(
    [line, "", ...[code, ...kept].map((f) => `- src/sync.ts:88: ${f.description}`), "", "4 findings are kept in Sergeant's records (`sgt review audits`), not on this public PR."].join("\n"),
  );
  expect(comment).not.toMatch(/example\.(com|io|dev)/);
});

test("a bare changed path and a 500-character description pass the structural rules", () => {
  const long = { ...code, id: "f2", location: "README.md", description: "y".repeat(500) };
  expect(auditComment(audit([long]), onPublic)).toBe(`${line}\n\n- README.md: ${"y".repeat(500)}`);
});

test("the denylist check drops only the finding it rejects, and counts it", () => {
  const check = publicDataCheck("Acme Solar", "audit comment");
  const named = { ...code, id: "f2", description: "Acme-Solar rows are skipped by the importer." };
  const id = { ...code, id: "f3", description: `Logs ${["C", "Ab12"].join(".")} in the error.` };
  expect(auditComment(audit([code, named, id]), { ...onPublic, check })).toBe(
    `${line}\n\n- src/sync.ts:88: ${code.description}\n\n2 findings are kept in Sergeant's records (\`sgt review audits\`), not on this public PR.`,
  );
});

test.each<[string, Parameters<typeof auditComment>[1]["check"]]>([
  ["no denylist", undefined],
  ["a check error", () => "error"],
  ["a whole comment the check rejects", (text) => (text.includes("\n\n- ") ? "fail" : "pass")],
  ["a check error on the whole comment", (text) => (text.includes("\n\n- ") ? "error" : "pass")],
  ["a check that rejects the whole comment for its count", (text) => (text.includes("kept in Sergeant's records") ? "fail" : "pass")],
])("with %s, a public PR gets the verdict line only, with no count of what it dropped", (_case, check) => {
  // The second finding fails the structural rules, so a working check would leave a count beside the line.
  expect(auditComment(audit([code, { ...code, id: "f2", location: undefined }]), { ...onPublic, check })).toBe(line);
});

test("the adapter posts once per head, and an unreadable visibility counts as public", async () => {
  const posted: string[] = [];
  const comments: unknown[] = [{ id: 1, body: "Unrelated", user: { login: "someone", type: "User" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/c/1" }];
  const github = createGitHubPort({ token: async () => "test", appId: 42, publicDataDenylist: "Acme Solar", repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input, init) => {
    const path = String(input).replace("https://api.github.com", "").replace(/\?.*$/, "");
    if (path === `/repos/${repo}`) return Response.json({ message: "Not Found" }, { status: 404 });
    if (path === `/repos/${repo}/pulls/7/files`) return Response.json([{ filename: "src/sync.ts" }]);
    if (path === `/repos/${repo}/issues/7/comments` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)).body as string;
      posted.push(body);
      const made = { id: 9, body, user: { login: "sergeant[bot]", type: "Bot" }, performed_via_github_app: { id: 42 }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/c/9" };
      comments.push(made);
      return Response.json(made, { status: 201 });
    }
    if (path === `/repos/${repo}/issues/7/comments`) return Response.json(comments);
    throw new Error(`unexpected ${path}`);
  }});
  expect(await github.postAuditComment?.(audit([code]))).toEqual({ id: 9 });
  expect(await github.postAuditComment?.(audit([code]))).toEqual({ id: 9 });
  expect(posted).toEqual([`${line}\n\n- src/sync.ts:88: ${code.description}`]);
});

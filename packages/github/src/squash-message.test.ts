import { expect, test } from "vitest";
import { isAgentIdentity, squashMessage } from "./squash-message.ts";

const builtBy = "Built by Sergeant (worker: Claude, review: Codex)";
const base = { number: 12, title: "TECH-9: do the thing", issueIdentifier: "TECH-9", closesIssue: true, builtBy, commits: [] };

// TECH-5085: whatever the branch commits carry (a `--no-verify` or an API commit no hook saw), an
// agent must never become a GitHub contributor through the squash commit, and a human must stay one.
test("an agent's co-author trailer never reaches the squash message; a human's moves to the trailer block", () => {
  const { commit_title, commit_message } = squashMessage({
    ...base,
    body: "Does the thing.\r\n\r\nCo-authored-by: Claude <noreply@anthropic.com>\r\nCo-authored-by: Devin Smith <devin@terros.com>\r\nFixes TECH-9",
    commits: [
      { message: "wip\n\nCo-authored-by: Codex <codex@openai.com>", author: { name: "Ada Human", email: "ada@terros.com", login: "ada" } },
      { message: "more\n\nCo-authored-by: Grace Hopper <grace@terros.com>\nco-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>" },
      { message: "again", author: { name: "Ada Human", email: "ADA@terros.com" } },
      { message: "by an agent", author: { name: "Claude", email: "noreply@anthropic.com" } },
      { message: "by an App", author: { name: "Sergeant", email: "1+sergeant-worker[bot]@users.noreply.github.com", login: "sergeant-worker[bot]" } },
    ],
  });
  expect(commit_title).toBe("TECH-9: do the thing (#12)");
  expect(commit_message).toBe(
    [
      "Does the thing.",
      "",
      "Fixes TECH-9",
      "",
      builtBy,
      "",
      "Co-authored-by: Devin Smith <devin@terros.com>",
      "Co-authored-by: Ada Human <ada@terros.com>",
      "Co-authored-by: Grace Hopper <grace@terros.com>",
      "",
    ].join("\n"),
  );
});

// f2 on #156: a human whose name is an agent's word stays a co-author; an agent is known by its identity.
test("agents are told apart from humans by identity, never by name", () => {
  for (const human of [
    { email: "devin.smith@terros.com" },
    { email: "devin.lee@example.com", login: "devinlee" },
    { email: "claude.bernard@example.com" },
    { email: "12345+claude-bernard@users.noreply.github.com" },
  ]) expect(isAgentIdentity(human)).toBe(false);
  for (const agent of [
    { email: "noreply@anthropic.com" },
    { email: "Codex@OpenAI.com" },
    { email: "cursoragent@cursor.com" },
    { email: "41898282+github-actions[bot]@users.noreply.github.com" },
    { email: "chatgpt-codex-connector[bot]@users.noreply.github.com" },
    { email: "198982749+Copilot@users.noreply.github.com" },
    { email: "ada@terros.com", login: "devin-ai-integration[bot]" },
  ]) expect(isAgentIdentity(agent)).toBe(true);

  const { commit_message } = squashMessage({
    ...base,
    body: "Paired.\n\nCo-authored-by: Claude Shannon-Smith <claude.s@example.com>",
    commits: [
      { message: "a", author: { name: "Devin Lee", email: "devin.lee@example.com", login: "devinlee" } },
      { message: "b", author: { name: "Claude Bernard", email: "claude.bernard@example.com" } },
    ],
  });
  expect(commit_message).toContain(
    "Co-authored-by: Claude Shannon-Smith <claude.s@example.com>\nCo-authored-by: Devin Lee <devin.lee@example.com>\nCo-authored-by: Claude Bernard <claude.bernard@example.com>\n",
  );
});

// f1 on #156: whether the squash commit closes the issue is the worker's closesIssue (Gate M9's), never
// a re-reading of the body, so a Part-of PR can never close its issue through its squash commit.
test("a Part-of PR's squash commit never carries a closing word for the issue, whatever its body says", () => {
  const partOf = { ...base, closesIssue: false };
  const closing = /\b(clos(e[sd]?|ing)|fix(e[sd]|ing)?|resolv(e[sd]?|ing)|complet(e[sd]?|ing))\b[\s:*_[(<]*(\S*\/)?TECH-9\b/i;
  for (const body of [
    "",
    "- Part of TECH-9",
    "**Part of TECH-9**",
    "This is part of TECH-9, step one.",
    "Part of [TECH-9](https://linear.app/terros/issue/TECH-9/do-the-thing)",
    "Part of https://linear.app/terros/issue/TECH-9/do-the-thing",
    "Fixes TECH-9",
    "closes: [TECH-9](https://linear.app/terros/issue/TECH-9/x)",
    "This resolves **TECH-9**.",
    "Fixes https://linear.app/terros/issue/tech-9/do-the-thing",
    "Fixes TECH-8, TECH-9",
  ]) {
    const { commit_title, commit_message } = squashMessage({ ...partOf, body, title: "Fixes TECH-9: step one" });
    expect(commit_message, body).not.toMatch(closing);
    expect(commit_title).toBe("Part of TECH-9: step one (#12)");
    expect(commit_message, body).toMatch(/part of\W+(\S*\/)?TECH-9/i);
  }
  expect(squashMessage({ ...partOf, body: "" }).commit_message).toBe(`Part of TECH-9\n\n${builtBy}\n`);
  expect(squashMessage({ ...partOf, body: "Step one.\n\nPart of TECH-9" }).commit_message).toBe(`Step one.\n\nPart of TECH-9\n\n${builtBy}\n`);
  // Another issue's closing word is not this issue's, and stays.
  expect(squashMessage({ ...partOf, body: "Fixes TECH-90" }).commit_message).toBe(`Fixes TECH-90\n\nPart of TECH-9\n\n${builtBy}\n`);
});

test("a closing PR's squash commit says Fixes once, with or without a body", () => {
  expect(squashMessage({ ...base, body: "" }).commit_message).toBe(`Fixes TECH-9\n\n${builtBy}\n`);
  expect(squashMessage({ ...base, body: "Done.\n\nCloses TECH-9" }).commit_message).toBe(`Done.\n\nCloses TECH-9\n\n${builtBy}\n`);
  // Naming the issue in prose, or another issue's Fixes, is not a closing reference to it.
  expect(squashMessage({ ...base, body: "TECH-9 — the thing.\nFixes TECH-90" }).commit_message).toContain("\n\nFixes TECH-9\n\n");
});

// f1 on #193: a branch commit written with CRLF line endings keeps its human co-author, as it did before
// the linear-time parse; its agent co-author is still dropped.
test("a CRLF commit message's human co-author stays and its agent co-author is dropped", () => {
  const { commit_message } = squashMessage({
    ...base,
    body: "Does the thing.",
    commits: [{ message: "wip\r\n\r\nCo-authored-by: Grace Hopper <grace@terros.com>\r\nCo-authored-by: Claude <noreply@anthropic.com>\r\n" }],
  });
  expect(commit_message).toBe(["Does the thing.", "", "Fixes TECH-9", "", builtBy, "", "Co-authored-by: Grace Hopper <grace@terros.com>", ""].join("\n"));
});

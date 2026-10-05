import { expect, test } from "vitest";
import { squashMessage, stripAgentCoAuthors } from "./squash-message.ts";

const builtBy = "Built by Sergeant (worker: Claude, review: Codex)";
const base = { number: 12, title: "TECH-9: do the thing", issueIdentifier: "TECH-9", builtBy, commits: [] };

// TECH-5085: whatever the branch commits carry (a `--no-verify` or an API commit no hook saw), an
// agent must never become a GitHub contributor through the squash commit, and a human must stay one.
test("an agent's co-author trailer never reaches the squash message; a human's does", () => {
  const { commit_title, commit_message } = squashMessage({
    ...base,
    body: "Does the thing.\r\n\r\nCo-authored-by: Claude <noreply@anthropic.com>\r\nFixes TECH-9",
    commits: [
      { message: "wip\n\nCo-authored-by: Codex <codex@openai.com>", author: { name: "Ada Human", email: "ada@terros.com" } },
      { message: "more\n\nCo-authored-by: Grace Hopper <grace@terros.com>\nco-authored-by: GPT via ChatGPT <bot@chatgpt.com>" },
      { message: "again", author: { name: "Ada Human", email: "ADA@terros.com" } },
      { message: "by an agent", author: { name: "Claude", email: "noreply@anthropic.com" } },
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
      "Co-authored-by: Ada Human <ada@terros.com>",
      "Co-authored-by: Grace Hopper <grace@terros.com>",
      "",
    ].join("\n"),
  );
});

test("adds Fixes for the issue unless the body already says how it relates, and works with no body", () => {
  expect(squashMessage({ ...base, body: "" }).commit_message).toBe(`Fixes TECH-9\n\n${builtBy}\n`);
  expect(squashMessage({ ...base, body: "Step one.\n\nPart of TECH-9" }).commit_message).toBe(`Step one.\n\nPart of TECH-9\n\n${builtBy}\n`);
  // Naming the issue in prose is not a closing line, and another issue's Fixes is not this one's.
  expect(squashMessage({ ...base, body: "TECH-9 — the thing.\nFixes TECH-90" }).commit_message).toContain("\n\nFixes TECH-9\n\n");
});

test("a human's co-author line in the body stays as written", () => {
  const body = "Paired.\n\nCo-authored-by: Claude Shannon-Smith <claude.s@example.com>\nCo-authored-by: Ada Human <ada@terros.com>";
  // A person whose name matches an agent's is the accepted cost of matching by name, as the owner decided.
  expect(stripAgentCoAuthors(body)).toBe("Paired.\n\nCo-authored-by: Ada Human <ada@terros.com>");
  expect(stripAgentCoAuthors("Claude wrote this paragraph.")).toBe("Claude wrote this paragraph.");
});

import { expect, test } from "vitest";
import { redactSecrets } from "./redact.ts";

// TECH-5254 review: an `sk-` key after `_`, and a quoted token value holding a space or comma, left
// credential material in a stored `reportError`.
test.each([
  ["OPENAI_API_KEY_sk-proj-abc123", "OPENAI_API_KEY_sk-[redacted]"],
  ["x_sk-abc12345", "x_sk-[redacted]"],
  ['{"refresh_token":"abc def"}', '{"refresh_token":"[redacted]"}'],
  ['{"refresh_token":"abc,def"}', '{"refresh_token":"[redacted]"}'],
])("redacts %s whole", (text, redacted) => {
  expect(redactSecrets(text)).toBe(redacted);
  expect(redactSecrets(redacted)).toBe(redacted);
});

test("a quoted token value is redacted to its closing quote, an unquoted one to the next separator", () => {
  expect(redactSecrets('{\\"access_token\\":\\"abc def\\",\\"x\\":1}')).toBe('{\\"access_token\\":\\"[redacted]\\",\\"x\\":1}');
  expect(redactSecrets("{'id_token': 'a\\'b c'}")).toBe("{'id_token': '[redacted]'}");
  expect(redactSecrets("refresh_token=abc&x=1; next")).toBe("refresh_token=[redacted]&x=1; next");
  expect(redactSecrets("a task-runner sk-")).toBe("a task-runner sk-");
});

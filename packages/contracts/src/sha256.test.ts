import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { sha256 } from "./sha256.ts";

test("matches node:crypto, so every stored conversation revision and comment id stays the same", () => {
  // Lengths around the 55/56/64-byte padding boundaries, multi-block input, and non-ASCII text.
  const inputs = ["", "abc", "é漢😀", ...[55, 56, 63, 64, 65, 119, 120, 1000].map((n) => "x".repeat(n)), JSON.stringify(["T", "d\n", [["c1", "2026", "b"]]])];
  for (const text of inputs) expect(sha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
});

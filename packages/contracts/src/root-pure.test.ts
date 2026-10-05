import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The package root must run outside Node (a browser client), so nothing it reaches may import a
// Node built-in (TECH-5028). Node-only code is exported from a subpath instead: ./version, ./credentials.
test("the package root imports nothing but zod and its own files, so no Node built-in", () => {
  const seen = new Set<string>();
  const external: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      if (spec!.startsWith("./")) visit(spec!);
      else if (spec !== "zod") external.push(`${file}: ${spec}`);
    }
  };
  visit("./index.ts");
  expect(external).toEqual([]);
  expect(seen.size).toBeGreaterThan(10);
});

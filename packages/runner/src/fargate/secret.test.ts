import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { runSecret, SECRET_LIMIT_BYTES } from "./secret.ts";
import { TASK_SCRIPT } from "./task.ts";

const unzip = (gz: string) => gunzipSync(Buffer.from(gz, "base64")).toString();

it("leaves out the largest files until the secret fits, naming each in the brief as not downloaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sergeant-secret-test-"));
  await writeFile(join(dir, "01-log.txt"), "small log");
  await writeFile(join(dir, "02-shot.png"), Buffer.alloc(60_000));
  const file = (name: string, bytes: number) => ({ name, url: `https://uploads.linear.app/${name}`, title: name, bytes, contentType: "text/plain" });
  const { secretString, attachments } = await runSecret({
    attachments: { files: [file("01-log.txt", 9), file("02-shot.png", 60_000)], skipped: [] },
    dir,
    brief: (files) => `# Brief\n${files}`,
    credentials: { GH_TOKEN: "t" },
  });
  const secret = JSON.parse(secretString);
  expect(attachments).toBe(true);
  expect(secret.SERGEANT_ATTACHMENTS).toBe(`01-log.txt ${Buffer.from("small log").toString("base64")}`);
  expect(unzip(secret.SERGEANT_BRIEF_GZ)).toMatch(/02-shot\.png.*not downloaded: too large for a Fargate run's 64 KiB secret/);
});

// TECH-6462: a long task's 64,468-byte brief with its credentials came to 66,225 bytes, so its worker
// could not start. The design docs stand in for a brief: real Markdown prose, which compresses about
// as well as a brief's reports and PR feedback.
it("fits a brief near 64 KB in the secret, and the task writes it back byte for byte", async () => {
  const docs = join(import.meta.dirname, "../../../../docs/design");
  const prose = Buffer.concat(await Promise.all((await readdir(docs)).filter((f) => f.endsWith(".md")).sort().map((f) => readFile(join(docs, f)))));
  const brief = prose.subarray(0, 64_468).toString("utf8");
  const credentials = { GH_TOKEN: `ghs_${"a".repeat(36)}`, GH_READ_TOKEN: `ghs_${"b".repeat(36)}`, CLAUDE_CODE_OAUTH_TOKEN: "c".repeat(108), PUBLIC_DATA_DENYLIST: "d".repeat(1_500) };
  expect(Buffer.byteLength(JSON.stringify({ SERGEANT_BRIEF: brief, ...credentials }))).toBeGreaterThan(SECRET_LIMIT_BYTES);

  const { secretString } = await runSecret({ attachments: { files: [], skipped: [] }, dir: tmpdir(), brief: () => brief, credentials });
  expect(Buffer.byteLength(secretString)).toBeLessThan(SECRET_LIMIT_BYTES / 2 + 4_096);

  // The task script's own line, with the real `base64` and `gzip`, writing to a temporary directory.
  const out = await mkdtemp(join(tmpdir(), "sergeant-secret-test-"));
  const line = TASK_SCRIPT.split("\n").find((l) => l.includes("> /workspace/sergeant-brief.md"));
  execFileSync("sh", ["-c", line!.replace("/workspace/", `${out}/`)], { env: { PATH: process.env.PATH, SERGEANT_BRIEF_GZ: JSON.parse(secretString).SERGEANT_BRIEF_GZ } });
  expect(await readFile(join(out, "sergeant-brief.md"), "utf8")).toBe(brief);
});

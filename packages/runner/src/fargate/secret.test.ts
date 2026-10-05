import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSecret } from "./secret.ts";

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
  expect(secret.SERGEANT_BRIEF).toMatch(/02-shot\.png.*not downloaded: too large for a Fargate run's 64 KiB secret/);
});

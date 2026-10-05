import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderAttachments, type Attachments } from "../attachments.ts";

/** Secrets Manager's limit on a secret's value, in bytes. */
export const SECRET_LIMIT_BYTES = 65_536;

/**
 * The run's one secret: its brief, the issue's files, and its two credentials, as JSON keys the task
 * definition references. The files ride in the secret only while it stays within Secrets Manager's
 * 64 KiB: the largest are left out, each named in the brief as not downloaded, until it fits. A brief
 * that does not fit even without them throws, and nothing is created (there is no S3 transport).
 */
export async function runSecret(i: {
  attachments: Attachments;
  /** Where `fetchAttachments` wrote the files. */
  dir: string;
  brief: (files: string) => string;
  credentials: Record<string, string>;
}): Promise<{ secretString: string; attachments: boolean }> {
  const data = new Map(await Promise.all(i.attachments.files.map(async (f) => [f.name, (await readFile(join(i.dir, f.name))).toString("base64")] as const)));
  const files = [...i.attachments.files];
  const skipped = [...i.attachments.skipped];
  for (;;) {
    const brief = i.brief(renderAttachments({ files, skipped }));
    const encoded = files.map((f) => `${f.name} ${data.get(f.name)}`).join("\n");
    const secretString = JSON.stringify({ SERGEANT_BRIEF: brief, ...(files.length && { SERGEANT_ATTACHMENTS: encoded }), ...i.credentials });
    const bytes = Buffer.byteLength(secretString);
    if (bytes <= SECRET_LIMIT_BYTES) return { secretString, attachments: files.length > 0 };
    const largest = files.reduce<(typeof files)[number] | undefined>((a, f) => (!a || f.bytes > a.bytes ? f : a), undefined);
    if (!largest) {
      throw new Error(
        `the run's brief is ${Buffer.byteLength(brief)} bytes: with its credentials, its secret would be ${bytes} bytes, over Secrets Manager's ${SECRET_LIMIT_BYTES}-byte limit, so the worker cannot start on Fargate`,
      );
    }
    files.splice(files.indexOf(largest), 1);
    skipped.push({ url: largest.url, title: largest.title, reason: `too large for a Fargate run's ${SECRET_LIMIT_BYTES / 1024} KiB secret` });
  }
}

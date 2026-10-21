import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Docker is not available where workers and CI's unit tests run, so this reads the Dockerfiles as text to
// catch a root-only step that runs as the worker user: the Android image inherits `USER node` from the
// base image, and an install into /opt there could not build (TECH-5840).
const DIR = join(import.meta.dirname, "..", "container");

/** Each RUN of the final stage with the user it runs as; `from` is the user the stage starts as. */
function runs(file: string, from: string) {
  const lines = readFileSync(join(DIR, file), "utf8").replace(/\\\n/g, " ").split("\n");
  const finalStage = lines.slice(lines.findLastIndex((line) => /^FROM\s/.test(line)));
  let user = from;
  const result: { user: string; command: string }[] = [];
  for (const line of finalStage) {
    const directive = /^(USER|RUN)\s+(.*)$/.exec(line);
    if (directive?.[1] === "USER") user = directive[2]?.trim() ?? user;
    if (directive?.[1] === "RUN") result.push({ user, command: directive[2] ?? "" });
  }
  return { result, finalUser: user };
}

// Steps that install into system directories (apt packages, global npm packages, unpacked tools, the
// Android SDK) or create and hand over root-owned directories; none can run as node.
const ROOT_ONLY = /apt-get|npm install -g|install -d|unzip|chown|sdkmanager "/;

test.each([
  // node:24 starts as root; the Android image starts FROM the base image, which ends as node.
  { file: "Dockerfile", from: "root" },
  { file: "Dockerfile.android", from: "node" },
])("$file runs each root-only step as root and leaves the worker as node", ({ file, from }) => {
  const { result, finalUser } = runs(file, from);
  const rootOnly = result.filter((run) => ROOT_ONLY.test(run.command));
  expect(rootOnly.length).toBeGreaterThan(0);
  for (const run of rootOnly) expect({ user: run.user, command: run.command }).toEqual({ user: "root", command: run.command });
  expect(finalUser).toBe("node");
});

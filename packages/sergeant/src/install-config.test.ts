import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

// deploy/host/install-config.sh against stub `aws` and `docker` (TECH-5273): the new config is
// installed only once the Fargate image it needs is pushed, so a failed install leaves the previous one.

const script = join(import.meta.dirname, "../../../deploy/host/install-config.sh");
const example = join(import.meta.dirname, "../../../deploy/host/installation.example.json");

// `aws ssm get-parameter` answers the config parameter with $STUB_CONFIG (version 8), and the Fargate
// one with $STUB_FARGATE when it is set; `docker push` fails when $STUB_PUSH is `fail`.
const aws = `#!/usr/bin/env bash
name=; while [ $# -gt 0 ]; do [ "$1" = --name ] && name=$2; shift; done
case "$name" in
  /sergeant/v2/config) jq -n --rawfile v "$STUB_CONFIG" '{value: $v, version: 8}' ;;
  /sergeant/v2/fargate-runner) [ -n "\${STUB_FARGATE:-}" ] && echo "$STUB_FARGATE" ;;
  *) echo stub-password ;;
esac
`;
const docker = `#!/usr/bin/env bash
[ "$1" = login ] && cat >/dev/null
[ "$1" = push ] && [ "\${STUB_PUSH:-}" = fail ] && exit 1
exit 0
`;
const fargate = JSON.stringify({ repositoryUrl: "123.dkr.ecr.us-west-2.amazonaws.com/sergeant-v2-runner", cluster: "sergeant-v2-runs" });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-config-"));
  await mkdir(join(dir, "bin"));
  await mkdir(join(dir, "etc"));
  await writeFile(join(dir, "bin/aws"), aws);
  await writeFile(join(dir, "bin/docker"), docker);
  await chmod(join(dir, "bin/aws"), 0o755);
  await chmod(join(dir, "bin/docker"), 0o755);
  // The previous installation: local workers, version 7, and the last image pushed.
  await writeFile(join(dir, "etc/installation.json"), "previous\n");
  await writeFile(join(dir, "etc/installation.json.version"), "7\n");
  await writeFile(join(dir, "etc/fargate-runner.json"), "previous image\n");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function install(workerBackend: "local" | "fargate", stub: { fargate?: string; push: "ok" | "fail" }) {
  const config = { ...JSON.parse(await readFile(example, "utf8")), runners: { workerBackend } };
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  const env = {
    ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, AWS_REGION: "us-west-2",
    SERGEANT_CONFIG_PARAMETER: "/sergeant/v2/config", STUB_CONFIG: join(dir, "config.json"), STUB_FARGATE: stub.fargate ?? "", STUB_PUSH: stub.push,
  };
  const exit = await promisify(execFile)(script, [join(dir, "etc")], { env }).then(() => 0, (e: { code: number }) => e.code);
  const read = (f: string) => readFile(join(dir, "etc", f), "utf8");
  return { exit, config: await read("installation.json"), version: await read("installation.json.version"), fargate: await read("fargate-runner.json") };
}

test("a failed push with a Fargate config fails the install and leaves the previous installation", { timeout: 20_000 }, async () => {
  expect(await install("fargate", { fargate, push: "fail" })).toEqual({ exit: 1, config: "previous\n", version: "7\n", fargate: "previous image\n" });
  // No Fargate resources at all is the same: the image it needs is not there.
  expect(await install("fargate", { push: "ok" })).toMatchObject({ exit: 1, config: "previous\n", version: "7\n" });
});

test("a Fargate config is installed once its image is pushed; a local one whether or not it is", { timeout: 20_000 }, async () => {
  const pushed = await install("fargate", { fargate, push: "ok" });
  expect(pushed).toMatchObject({ exit: 0, version: "8\n" });
  expect(JSON.parse(pushed.config).runners).toEqual({ workerBackend: "fargate" });
  expect(JSON.parse(pushed.fargate)).toEqual({ cluster: "sergeant-v2-runs", image: expect.stringMatching(/^123\.dkr\.ecr\.us-west-2\.amazonaws\.com\/sergeant-v2-runner:[0-9a-f]{40}$/) });

  await writeFile(join(dir, "etc/fargate-runner.json"), "previous image\n");
  expect(await install("local", { fargate, push: "fail" })).toMatchObject({ exit: 0, version: "8\n", fargate: "previous image\n" });
});

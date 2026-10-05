import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { issueRevision, NoModelAccount } from "@terros/sergeant-contracts";
import { containerRunner } from "./runner.ts";
import { annClaude, fakeHost, GH, REPORT, spec, started, TOKEN } from "./runner-fixtures.ts";


// The container is the hard boundary between runs and the operator's personal and control-plane
// credentials. A generic environment pass-through let any caller add a personal GH_TOKEN, AWS, or
// Linear keys. A worker's only GitHub credential is its worker-App token, scoped to its run's
// repositories. Commits are the installation's human identity: the captain forbids an agent author.
test("only the model token, the run's scoped worker-App token, and the human git identity enter", async () => {
  const { host, minted } = await started({ modelEnv: { GH_TOKEN: "ghp_x" }, env: { AWS_PROFILE: "lifeDev" } });

  expect(minted).toEqual([{ repositories: ["o/canary"], access: "write" }]);
  const run = host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  const passed = run?.args.flatMap((a, i, all) => (a === "--env" || a === "-e" ? [all[i + 1]] : [])) ?? [];
  expect(passed).toEqual([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "GIT_AUTHOR_NAME=Ada Example",
    "GIT_AUTHOR_EMAIL=ada@example.com",
    "GIT_COMMITTER_NAME=Ada Example",
    "GIT_COMMITTER_EMAIL=ada@example.com",
  ]);
  expect(run?.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, GH_TOKEN: GH });
  // No token on any command line, including the host clone, which reads it from its environment.
  expect(host.calls.flatMap((c) => c.args).join(" ")).not.toMatch(new RegExp(`${TOKEN}|${GH}`));
  const clone = host.calls.find((c) => c.cmd === "git" && c.args.includes("clone"));
  expect(clone?.opts.env?.SERGEANT_RUN_GITHUB_TOKEN).toBe(GH);
});

// `canceled` is terminal: once stored, status stops asking Docker and nothing retries the stop. If
// it were stored while Docker failed, the model would keep working with its token, unseen.
test("cancel stays retryable until Docker confirms the container stopped", async () => {
  const { runner, host } = await started();

  host.docker.reachable = false;
  await expect(runner.cancel("run_t1")).rejects.toThrow(/not confirmed/);
  host.docker.reachable = true;
  expect((await runner.status("run_t1")).status).toBe("running");

  await runner.cancel("run_t1");
  // Every record of the run names the issue text it started from, which M13 checks (TECH-5034).
  expect(await runner.status("run_t1")).toMatchObject({ status: "canceled", issueRevision: issueRevision(spec.conversation.issue) });
});

// Unknown is not death (04 §6, captain). Reading a Docker outage as "gone" would fail a worker
// that is still running and let reasoning start a second one beside it.
test("status is unavailable, not failed, while Docker cannot answer", async () => {
  const { runner, host } = await started();

  host.docker.reachable = false;
  await expect(runner.status("run_t1")).rejects.toThrow(/unavailable/);
  host.docker.reachable = true;
  expect((await runner.status("run_t1")).status).toBe("running");
});

// TECH-4994: a screenshot pasted into the description and a log attached to the issue reach the run
// as read-only files the brief names; the Linear token stays on the host; an oversized file is
// skipped with a note, never fatal.
test("gives the run the issue's files read-only, fetched on the host, skipping oversized ones", async () => {
  const shot = "https://uploads.linear.app/org/a/shot";
  const log = "https://uploads.linear.app/org/b/app.log";
  const huge = "https://files.example.com/huge.bin";
  const fetchedWithToken: string[] = [];
  const conversation = {
    ...spec.conversation,
    issue: {
      ...spec.conversation.issue,
      description: `It breaks:\n\n![image.png](${shot})`,
      attachments: [
        { id: "a1", title: "app.log", source: "upload", url: log, updatedAt: "2026-10-02T06:00:00.000Z" },
        { id: "a2", title: "huge.bin", source: null, url: huge, updatedAt: "2026-10-02T06:00:00.000Z" },
      ],
    },
  };
  const host = fakeHost();
  const rootDir = await mkdtemp(join(tmpdir(), "sergeant-runner-test-"));
  const runner = containerRunner({
    rootDir,
    models: { worker: { "claude-code-local": "sonnet", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    accounts: async () => [annClaude],
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => GH,
    exec: host.exec,
    attachmentLimits: { perFileBytes: 1024, perTaskBytes: 4096 },
    fetchUpload: async (url) => {
      fetchedWithToken.push(url);
      return url === shot ? new Response(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "image/png" } }) : new Response("ERROR boom\n");
    },
    fetchLink: async () => new Response(new Uint8Array(2048), { headers: { "content-type": "application/octet-stream" } }),
  });
  await runner.start({ ...spec, conversation });

  expect(fetchedWithToken).toEqual([log, shot]);
  const files = join(rootDir, "run_t1", "attachments");
  expect(await readFile(join(files, "01-app.log"), "utf8")).toBe("ERROR boom\n");
  expect((await readFile(join(files, "02-shot.png"))).length).toBe(2);
  const run = host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  expect(run?.args).toContain(`${files}:/workspace/.sergeant/attachments:ro`);
  const brief = await readFile(join(rootDir, "run_t1", "workspace", "sergeant-brief.md"), "utf8");
  expect(brief).toContain("`/workspace/.sergeant/attachments/02-shot.png` — image/png");
  expect(brief).toContain(`${huge} ("huge.bin") — not downloaded: over the`);
});


// TECH-5070: a stop cancels a run whose status it could not read, then reads it again for the PRs its
// worker reported, which Linear may not link yet. A worker that already exited with its report, or
// wrote it before it was stopped, keeps it through the cancel, or its PR would stay open.
test("a canceled run keeps the report its worker wrote, and a run that wrote none has no report", async () => {
  const reporting = REPORT.replace('"pullRequests": []', '"pullRequests": [{ "repo": "o/canary", "number": 9, "url": "https://github.com/o/canary/pull/9", "headSha": "' + "a".repeat(40) + '", "closesIssue": true, "review": { "required": true, "reason": "r" } }]');
  const { runner, host, rootDir } = await started();
  await writeFile(join(rootDir, "run_t1", "workspace", "sergeant-report.md"), reporting);
  host.docker.running = false;
  host.docker.reachable = false;
  await expect(runner.status("run_t1")).rejects.toThrow(/unavailable/);
  host.docker.reachable = true;

  await runner.cancel("run_t1");
  const canceled = await runner.status("run_t1");
  expect(canceled).toMatchObject({ status: "canceled", report: { pullRequests: [{ repo: "o/canary", number: 9 }] } });
  expect(await runner.report?.("run_t1")).toBe(reporting);

  const silent = await started();
  await silent.runner.cancel("run_t1");
  expect(await silent.runner.status("run_t1")).toMatchObject({ status: "canceled", report: null });
  expect((await silent.runner.status("run_t1")).reportError).toBeUndefined();
});

// TECH-5179: a task's runs spend only its owner's quota. The account comes from the owner's own
// registrations, and an owner with none starts nothing: no clone, no container, no run to cancel.
test("a run uses only its task owner's account, and an owner with none starts nothing", async () => {
  const bob = await started({}, { ...spec, owner: { id: "bob", name: "Bob" } });
  const run = bob.host.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
  expect(run?.opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-bob");
  expect(await bob.runner.status("run_t1")).toMatchObject({ account: { id: "person:bob:claude-code-local", group: "registered" } });

  const carol = { id: "carol", name: "Carol" };
  const refused = await started({}, { ...spec, owner: carol }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(NoModelAccount);
  expect(refused).toMatchObject({ kind: "none_registered", owner: carol });
});

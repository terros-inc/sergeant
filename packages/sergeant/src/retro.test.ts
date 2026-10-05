import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetroAnswer, RetroCase, RetroFeedbackTask, RetroFiledIssue } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { filedIn, runRetro, windowEnd, type RetroDeps } from "./retro.ts";

// TECH-5187: the retro must not become a ticket factory or a cost sink. It runs only when due (about ten
// tasks with new feedback, two weeks with anything new, or a human's ask), reads only its window, checks
// the previous retro's issues, and a failed post retries without a second paid answer or a second issue.

const NOW = new Date("2026-10-20T12:00:00.000Z");
const task = (n: number): RetroFeedbackTask => ({ identifier: `TECH-${n}`, title: `Task ${n}`, url: `https://linear.app/t/issue/TECH-${n}`, feedback: ["**Sergeant feedback:** CI was slow"] });
const issue = (id: string, type: string, createdAt = "2026-10-10T00:00:00.000Z"): RetroFiledIssue => ({
  identifier: id,
  title: id,
  url: `https://linear.app/t/issue/${id}`,
  createdAt,
  state: { name: type, type },
});
const ANSWER: RetroAnswer = {
  lastTime: "The previous retro's CI-cache issue is done and slow CI stopped recurring.",
  themes: [{ title: "Workers rerun the full suite", evidence: ["TECH-1", "TECH-2"], recommendation: "Say in the worker rules to run the narrowest check." }],
  issues: [{ key: "narrow-checks", kind: "guidance", title: "Workers run the narrowest check", description: "Workers rerun everything.", evidence: ["TECH-1", "TECH-2"] }],
};

function fixture(opts: { last?: { title: string; content: string; createdAt: string } | null; tasks?: number; filed?: RetroFiledIssue[] }) {
  const asked: RetroCase[] = [];
  const reads: { since: string }[] = [];
  const issues = new Map<string, { title: string; description: string; teamId: string; projectId: string }>();
  const documents = new Map<string, { title: string; content: string }>();
  let failPosts = 0;
  const deps: RetroDeps = {
    agentUserId: "sergeant",
    projectId: "project-sergeant",
    teamId: "team-tech",
    reasoning: {
      async retro(input) {
        asked.push(input);
        return { answer: ANSWER, model: "opus", costUsd: 0.4 };
      },
    },
    linear: {
      lastRetro: async () => opts.last ?? null,
      feedbackTasks: async (since) => (reads.push({ since }), Array.from({ length: opts.tasks ?? 0 }, (_, i) => task(i + 1))),
      filedIssues: async () => opts.filed ?? [],
      issues: async (ids) => ids.map((id) => issue(id, id === "TECH-50" ? "completed" : "canceled", "2026-10-01T00:00:00.000Z")),
      fileIssue: async ({ key, ...rest }) => {
        if (!issues.has(key)) issues.set(key, rest);
        const n = [...issues.keys()].indexOf(key) + 100;
        return { identifier: `TECH-${n}`, url: `https://linear.app/t/issue/TECH-${n}` };
      },
      postDocument: async ({ key, title, content }) => {
        if (failPosts-- > 0) throw new Error("Linear documentCreate did not succeed");
        if (!documents.has(key)) documents.set(key, { title, content });
        return { url: "https://linear.app/t/document/retro" };
      },
    },
  };
  return { deps, asked, reads, issues, documents, failNextPosts: (n: number) => (failPosts = n) };
}

const options = async () => ({ stateDir: await mkdtemp(join(tmpdir(), "retro-")), log: () => {}, now: () => NOW });

test("a retro is due at about ten tasks with new feedback, never sooner unless a human asks", async () => {
  const opts = await options();
  const quiet = fixture({ tasks: 9, filed: [issue("TECH-60", "backlog")] });
  expect(await runRetro(opts, quiet.deps, { manual: false })).toBeUndefined();
  expect(quiet.asked).toHaveLength(0);
  // The first retro's window is the last two weeks.
  expect(quiet.reads[0]?.since).toBe("2026-10-06T12:00:00.000Z");

  expect(await runRetro(opts, quiet.deps, { manual: true })).toBe("https://linear.app/t/document/retro");
  expect(quiet.asked).toHaveLength(1);

  const due = fixture({ tasks: 10 });
  expect(await runRetro(await options(), due.deps, { manual: false })).toBeDefined();
  expect(due.asked[0]).toMatchObject({ previous: null, until: NOW.toISOString() });
});

test("two weeks after the last retro it runs on anything new, and not on nothing", async () => {
  const content = "From 2026-10-01T09:00:00.000Z to 2026-10-05T09:00:00.000Z: 10 tasks with Sergeant feedback, 1 issues Sergeant filed.\n\n## Issues filed\n\n- [TECH-50](https://linear.app/t/issue/TECH-50) Cache CI\n- [TECH-51](https://linear.app/t/issue/TECH-51) Lint rule";
  const last = { title: "Sergeant retro 2026-10-05", content, createdAt: "2026-10-05T09:03:00.000Z" };
  const nothing = fixture({ last });
  expect(await runRetro(await options(), nothing.deps, { manual: false })).toBeUndefined();

  const some = fixture({ last, tasks: 2 });
  await runRetro(await options(), some.deps, { manual: false });
  // The window starts where the last one ended, and the previous retro's issues come with their state now.
  expect(some.reads[0]?.since).toBe("2026-10-05T09:00:00.000Z");
  expect(some.asked[0]?.previous?.filed.map((i) => [i.identifier, i.state.type])).toEqual([["TECH-50", "completed"], ["TECH-51", "canceled"]]);

  const recent = fixture({ last: { ...last, createdAt: "2026-10-19T00:00:00.000Z" }, tasks: 2 });
  expect(await runRetro(await options(), recent.deps, { manual: false })).toBeUndefined();
});

test("a failed post is retried with the saved answer: one paid answer, one issue, one document", async () => {
  const opts = await options();
  const f = fixture({ tasks: 12 });
  f.failNextPosts(1);
  await expect(runRetro(opts, f.deps, { manual: false })).rejects.toThrow(/documentCreate/);
  // Later the window is unchanged (no retro posted), but its rolling first-retro start must not move the keys.
  const later = { ...opts, now: () => new Date(NOW.getTime() + 3_600_000) };
  expect(await runRetro(later, f.deps, { manual: false })).toBeDefined();
  expect(f.asked).toHaveLength(1);
  expect([...f.issues.values()]).toEqual([
    expect.objectContaining({ title: "Workers run the narrowest check", teamId: "team-tech", projectId: "project-sergeant", description: expect.stringContaining("**Evidence:** TECH-1, TECH-2") }),
  ]);
  const [doc] = [...f.documents.values()];
  expect(doc?.title).toBe("Sergeant retro 2026-10-20");
  expect(doc?.content).toContain("## Last time\n\nThe previous retro's CI-cache issue is done");
  expect(doc?.content).toContain("**Evidence:** TECH-1, TECH-2");
  // The next retro reads back what this one filed, and where its window ended.
  expect(filedIn(doc?.content ?? "")).toEqual(["TECH-100"]);
  expect(windowEnd(doc?.content ?? "")).toBe(NOW.toISOString());
});

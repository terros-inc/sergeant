import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NoModelAccount, QUESTION_HEADING, type Conversation, type RunnerPort } from "@terros/sergeant-contracts";
import { cleanup, dir, human, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5217: an owner with no model account, or none usable, is asked through the ordinary question
// path, not refused. The wait holds without re-asking, even past the wall-clock window, and their reply
// opens a fresh window (TECH-5059) in which Sergeant tries the launch again. On 2026-10-04 two tasks
// instead burned their whole window on a refusal and could not resume without a manual wake.

afterEach(cleanup);

const ann = { id: "user-ann", name: "Ann" };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function owner() {
  const o = { registered: false, attempts: 0, started: [] as string[] };
  const runner: RunnerPort = {
    start: async (spec) => {
      o.attempts++;
      if (!o.registered) throw new NoModelAccount(ann, "none_registered", [], "Ann has no model account registered for a provider this Sergeant runs");
      o.started.push(spec.runId);
    },
    status: async (id) => (o.started.includes(id) ? { ...worker("running"), runId: id } : Promise.reject(new Error(`no run ${id}`))),
    cancel: async () => {},
  };
  return { o, runner };
}

const stopWhen = async (done: boolean) => done && (await writeFile(join(dir, "STOP"), ""));

test("a missing account asks the owner once and waits, past its window, until they reply; the reply retries the launch in a fresh window", async () => {
  const { o, runner } = owner();
  let turns = 0;
  const reasoner = async () => (turns++, turnOf([start]));

  // Asked once, and nothing more happens however often the loop polls.
  const first = await scenario({ runner, reasoner, onPoll: async (poll, live) => (await stopWhen(poll >= 6), live) });
  const questions = (live: Conversation) => live.agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING));
  expect(turns).toBe(1);
  expect(o.attempts).toBe(1);
  expect(questions(first.live)).toHaveLength(1);
  expect(questions(first.live)[0]?.body).toContain("register or fix a model account (`sgt account register claude|codex --name <name>`), then reply here.");
  expect((await saved()).recentTurns.at(-1)?.outcomes).toEqual([expect.stringMatching(/^start_worker: denied by O2 .*asked Ann/)]);

  // Hours pass with the question open: the window's end asks no budget question and takes no turn.
  const file = join(dir, "state.json");
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), startedAt: ago(240) }));
  await rm(join(dir, "STOP"));
  const waited = await scenario({ runner, reasoner, conversation: first.live, onPoll: async (poll, live) => (await stopWhen(poll >= 4), live) });
  expect(turns).toBe(1);
  expect(waited.live.agentComments).toEqual(first.live.agentComments);
  await rm(join(dir, "STOP"));

  // Ann registers an account and replies: a fresh window from her reply, and the launch is tried again.
  const repliedAt = new Date().toISOString();
  const resumed = await scenario({
    runner,
    reasoner,
    conversation: waited.live,
    onPoll: async (poll, live) => {
      await stopWhen(o.started.length > 0 || poll >= 10);
      if (poll > 1) return live;
      o.registered = true;
      return { ...live, humanComments: [human("c1", repliedAt, "Registered claudeWork.")] };
    },
  });
  expect(o.started).toHaveLength(1);
  expect(turns).toBe(2);
  expect(questions(resumed.live)).toHaveLength(1);
  expect((await saved()).budget.since).toBe(repliedAt);
});

test("an unusable account's question that Linear refuses is asked again until it is posted, and only once", async () => {
  const { runner } = owner();
  let failures = 2;
  let turns = 0;
  const { live } = await scenario({
    runner,
    reasoner: async () => (turns++, turnOf([start])),
    beforePost: () => {
      if (failures-- > 0) throw new Error("Linear unavailable");
    },
    onPoll: async (poll, live) => (await stopWhen(poll >= 8), live),
  });
  expect(failures).toBeLessThan(0);
  expect(turns).toBe(1);
  expect(live.agentComments).toHaveLength(1);
});

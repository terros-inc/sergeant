import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { QUESTION_HEADING, type Conversation } from "@terros/sergeant-contracts";
import { conversation } from "./execute-fixtures.ts";
import { classifyReply, recordBudgetStop, recordReply, stopAgreement } from "./stop-ledger.ts";

// TECH-6021: the agreement data is what a later task uses to authorize automatic extension, so a reply
// must be attributed to the right stop and rule, once, and an accept-as-is ending must count as a stop.

let root = "";
afterEach(() => rm(root, { recursive: true, force: true }));

const asked = (id: string, at: string) => ({ id, createdAt: at, body: `${QUESTION_HEADING}\n\nSergeant stopped this task. Continue?` });
const reply = (id: string, at: string, body: string) => ({ id, author: { id: "u1", name: "Ann" }, createdAt: at, updatedAt: at, body });
const thread = (agent: ReturnType<typeof asked>[], humans: ReturnType<typeof reply>[]): Conversation => ({ ...conversation, agentComments: agent, humanComments: humans });

test("replies are recorded once against their stop, accept-as-is counts as a stop, and agreement is reported per rule", async () => {
  root = await mkdtemp(join(tmpdir(), "sergeant-stops-"));
  const [a, b] = [join(root, "UNF-1"), join(root, "UNF-2")];
  await Promise.all([mkdir(a), mkdir(b)]);

  await recordBudgetStop(a, "UNF-1", "q1", { call: "extend", rule: "2", reason: "only a merge", estimate: "a merge, about 2 min and $1" });
  await recordBudgetStop(a, "UNF-1", "q1", { call: "extend", rule: "2", reason: "only a merge" }); // retried poll: once
  const extended = thread([asked("q1", "2026-10-14T01:00:00.000Z")], [reply("c1", "2026-10-14T01:05:00.000Z", "1")]);
  await recordReply(a, extended);
  await recordReply(a, extended); // seen again: once

  await recordBudgetStop(b, "UNF-2", "q2", { call: "extend", rule: "3", reason: "a first fix cycle" });
  const ambiguous = thread([asked("q2", "2026-10-14T02:00:00.000Z")], [reply("c2", "2026-10-14T02:05:00.000Z", "Hmm, why did the reviewer flag this?")]);
  await recordReply(b, ambiguous);
  await recordReply(b, ambiguous, true); // reasoning took it as accept-as-is

  // A question that is not a budget question records nothing.
  await recordReply(b, thread([asked("q3", "2026-10-14T03:00:00.000Z")], [reply("c3", "2026-10-14T03:01:00.000Z", "stop")]));

  const { rules, stops } = await stopAgreement(root);
  expect(stops.map((s) => [s.task, s.rule, s.call, s.reply])).toEqual([["UNF-1", "2", "extend", "extend"], ["UNF-2", "3", "extend", "stop"]]);
  expect(rules).toEqual([
    { rule: "2", call: "extend", asked: 1, unanswered: 0, extend: 1, stop: 0, other: 0, followed: 1 },
    { rule: "3", call: "extend", asked: 1, unanswered: 0, extend: 0, stop: 1, other: 0, followed: 0 },
  ]);
});

test("a reply is classified by the option it picks or its words; anything else is other", () => {
  const kind = (body: string) => classifyReply({ body });
  expect([kind("1"), kind("Extend."), kind("Yes, continue please")]).toEqual(["extend", "extend", "extend"]);
  expect([kind("2"), kind("Accept as-is"), kind("Stop here.")]).toEqual(["stop", "stop", "stop"]);
  expect([kind("Why did it fail?"), kind("Don't stop, continue")]).toEqual(["other", "other"]);
});

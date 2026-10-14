import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Conversation, type HumanComment, StopEntry, type StopAgreement, type StopReply, type StopRuleAgreement } from "@terros/sergeant-contracts";
import { latestAnswer, latestQuestion } from "./question.ts";
import type { StopRecommendation } from "./stop-rubric.ts";

// TECH-6021: the ledger a stop's case is read from (`turns.jsonl`), and the agreement record each stop
// leaves (`stops.jsonl`, next to it in the task's directory): the rubric's call and rule when the budget
// question is asked, the human's reply as extend, stop, or other when it comes. Only measurement reads
// the record, so losing it changes nothing a task does; a line that does not parse is skipped.

/** This window's turns, their count and the steers (`send_run` done) each run got, from `turns.jsonl`. */
export async function windowTurns(file: string, windowStart: string): Promise<{ turns: number; steers: Record<string, number> }> {
  const since = Date.parse(windowStart);
  const steers: Record<string, number> = {};
  let turns = 0;
  for (const line of await lines(file)) {
    const turn = line as { at?: string; outcomes?: { status?: string; action?: { kind?: string; runId?: string } }[] };
    if (!turn.at || Date.parse(turn.at) < since) continue;
    turns += 1;
    for (const o of turn.outcomes ?? []) {
      if (o.status === "done" && o.action?.kind === "send_run" && o.action.runId) steers[o.action.runId] = (steers[o.action.runId] ?? 0) + 1;
    }
  }
  return { turns, steers };
}

type StopLine = { kind: "stop"; questionId: string; task: string; at: string } & StopRecommendation;
type ReplyLine = { kind: "reply"; questionId: string; reply: StopReply; replyId?: string; at: string; source?: "accept_as_is" };

/** Records the budget question `questionId` with its recommendation, once. */
export async function recordBudgetStop(dir: string, task: string, questionId: string, r: StopRecommendation): Promise<void> {
  const file = join(dir, "stops.jsonl");
  if ((await lines(file)).some((l) => (l as StopLine).kind === "stop" && (l as StopLine).questionId === questionId)) return;
  const line: StopLine = { kind: "stop", questionId, task, at: new Date().toISOString(), ...r };
  await appendFile(file, `${JSON.stringify(line)}\n`);
}

/**
 * Records a human's reply to one of this task's budget questions: the first human comment after
 * Sergeant's latest question, when that question is (or is in the thread of) a recorded budget question.
 * `accepted` records a reply reasoning took as accept-as-is (TECH-5118) as a stop, whatever its words.
 */
export async function recordReply(dir: string, conversation: Conversation, accepted = false): Promise<void> {
  const asked = latestQuestion(conversation);
  const reply = latestAnswer(conversation);
  if (!asked || !reply) return;
  const file = join(dir, "stops.jsonl");
  const recorded = (await lines(file)) as (StopLine | ReplyLine)[];
  const questionId = asked.parentId ?? asked.id;
  if (!recorded.some((l) => l.kind === "stop" && l.questionId === questionId)) return;
  const kind: StopReply = accepted ? "stop" : classifyReply(reply);
  if (recorded.some((l) => l.kind === "reply" && l.questionId === questionId && (l.reply === kind || !accepted))) return;
  const line: ReplyLine = { kind: "reply", questionId, reply: kind, replyId: reply.id, at: reply.createdAt, ...(accepted && { source: "accept_as_is" as const }) };
  await appendFile(file, `${JSON.stringify(line)}\n`);
}

/**
 * The reply's kind, by its words: the question's options are `1. Extend` and `2. Accept as-is`, so a
 * reply that picks one, or says extend/continue or stop/accept, is that; anything else, or both, is
 * `other`. Measurement only: reasoning still reads the reply itself (07 §6).
 */
export function classifyReply(reply: Pick<HumanComment, "body">): StopReply {
  const text = reply.body.toLowerCase();
  const extend = /^\s*1\b/.test(text) || /\b(extend|continue|keep going|go ahead|proceed|carry on)\b/.test(text);
  const stop = /^\s*2\b/.test(text) || /\b(stop|accept|as[- ]is|halt)\b/.test(text);
  return extend === stop ? "other" : extend ? "extend" : "stop";
}

/** Every task's stops under `tasksDir`, oldest first, each with its latest recorded reply, and the totals per rule. */
export async function stopAgreement(tasksDir: string): Promise<StopAgreement> {
  const dirs = await readdir(tasksDir).catch(() => []);
  const stops: StopAgreement["stops"] = [];
  for (const dir of dirs.sort()) {
    const recorded = (await lines(join(tasksDir, dir, "stops.jsonl"))) as (StopLine | ReplyLine)[];
    for (const s of recorded.filter((l): l is StopLine => l.kind === "stop")) {
      const reply = recorded.filter((l): l is ReplyLine => l.kind === "reply" && l.questionId === s.questionId).at(-1);
      const entry = StopEntry.safeParse({ task: s.task, at: s.at, rule: s.rule, call: s.call, reason: s.reason, estimate: s.estimate, reply: reply?.reply, repliedAt: reply?.at });
      if (entry.success) stops.push(entry.data);
    }
  }
  stops.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rules = new Map<string, StopRuleAgreement>();
  for (const s of stops) {
    const key = `${s.rule}:${s.call}`;
    const row = rules.get(key) ?? { rule: s.rule, call: s.call, asked: 0, unanswered: 0, extend: 0, stop: 0, other: 0, followed: 0 };
    row.asked += 1;
    if (!s.reply) row.unanswered += 1;
    else {
      row[s.reply] += 1;
      if (s.reply === s.call) row.followed += 1;
    }
    rules.set(key, row);
  }
  return { rules: [...rules.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.call.localeCompare(b.call)), stops };
}

async function lines(file: string): Promise<unknown[]> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return []; // A line torn by a crash mid-append.
    }
  });
}

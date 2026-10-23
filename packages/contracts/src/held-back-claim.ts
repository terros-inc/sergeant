import type { ActionKind } from "./actions.ts";

// TECH-6711: when Q1 holds back the rest of an asking turn, its question must not say any of that
// happened. A list of exact phrasings kept missing new ones ("The worker has started"), so this reads
// each clause for a started, running or done verb form, in any word order and tense, about Sergeant or
// about something a held-back action would do; a clause that asks, proposes or negates is not a claim.

/** What each held-back action is called, so "the fix is underway" counts when a start is held back. */
const NOUNS: Record<ActionKind, string[]> = {
  start_worker: ["worker", "workers", "fix", "fixes", "run", "runs", "job", "jobs"],
  start_reviewer: ["review", "reviews", "reviewer", "reviewers", "run", "runs"],
  send_run: ["message", "worker", "run"],
  merge_pr: ["merge", "pr", "prs", "pull"],
  ask_human: [],
  accept_as_is: ["task"],
  close_issue: ["issue"],
  create_followup: ["follow-up", "follow-ups", "followup", "followups", "ticket"],
  record_blocked_by: ["relation", "dependency", "blocker"],
  update_description: ["description"],
};

/** Verbs Sergeant would act with, in their done form; a clause may open with one ("Merged."). */
const DONE = new Set(
  ("started launched kicked spun merged filed sent queued dispatched triggered created closed recorded updated posted " +
    "begun completed finished ended fixed").split(" "),
);
/** In-progress and finished states, which count only with a subject or a held-back action's noun. */
const STATE = new Set([...DONE, ..."starting launching kicking spinning merging filing sending closing fixing running underway ongoing done complete".split(" ")]);
const FIRST_PERSON = new Set("i i've i'm we we've we're sergeant sergeant's".split(" "));
/** A clause with one of these asks, proposes, conditions or denies rather than claims. */
const NOT_A_CLAIM = new Set(
  ("not no never nothing none neither nor without cannot should shall would could can may might must will i'll we'll it'll i'd we'd " +
    "want wants like prefer propose suggest recommend if once whether unless until need needs require requires ok okay approve let " +
    "blocked pending waiting wait waits hold holds held").split(" "),
);
/** A sentence ending in "?" that opens with one of these is a question about the state, not a claim. */
const ASKS = new Set("is are was were has have had do does did which what who how why where when".split(" "));

/** Whether a question claims that something the held-back actions would do is started, running or done. */
export function claimsHeldBack(question: string, held: ActionKind[]): boolean {
  const nouns = new Set(held.flatMap((kind) => NOUNS[kind]));
  const sentences = question.replace(/[‘’]/g, "'").toLowerCase().match(/[^.!?\n]+[.!?]*/g) ?? [];
  return sentences.some((sentence) => {
    if (sentence.trim().endsWith("?") && ASKS.has(words(sentence)[0] ?? "")) return false;
    return sentence.split(/[,;:()—–]|\s-\s|\b(?:and|but|so|then)\b/).some((clause) => claims(words(clause), nouns));
  });
}

function words(text: string): string[] {
  return text.match(/#\d+|[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [];
}

function claims(clause: string[], nouns: Set<string>): boolean {
  if (clause.some((w) => NOT_A_CLAIM.has(w) || w.endsWith("n't"))) return false;
  return clause.some((w, i) => {
    // "in progress" and "under way" are states only as a pair.
    const state = STATE.has(w) || (w === "progress" && clause[i - 1] === "in") || (w === "way" && clause[i - 1] === "under");
    if (!state) return false;
    if (i === 0) return DONE.has(w);
    return clause.slice(0, i).some((s) => FIRST_PERSON.has(s)) || clause.some((n) => nouns.has(n) || (n.startsWith("#") && nouns.has("pr")));
  });
}

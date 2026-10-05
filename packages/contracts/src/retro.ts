import { z } from "zod";

// The Sergeant retro (TECH-5187): now and then, reasoning reads the Sergeant feedback left on completed
// tasks (TECH-5186) and what became of the issues Sergeant filed, and proposes systemic improvements.
// It reads exactly these two inputs, plus the previous retro to check whether its recommendations held.

const Instant = z.iso.datetime({ offset: true });

/** The label on every issue with a Sergeant feedback comment (TECH-5186); the retro finds them by it. */
export const FEEDBACK_LABEL = "sergeant-feedback";
/** Starts every Sergeant feedback comment. */
export const FEEDBACK_MARKER = "**Sergeant feedback:**";

/** A task with a Sergeant feedback comment posted in the retro's window. */
export const RetroFeedbackTask = z.object({
  identifier: z.string().min(1),
  title: z.string(),
  url: z.url(),
  /** The Sergeant feedback comments' bodies, oldest first. */
  feedback: z.array(z.string()),
});
export type RetroFeedbackTask = z.infer<typeof RetroFeedbackTask>;

/** An issue Sergeant filed, and what became of it: done, canceled, or still waiting. */
export const RetroFiledIssue = z.object({
  identifier: z.string().min(1),
  title: z.string(),
  url: z.url(),
  createdAt: Instant,
  /** The workflow state's name and type (`backlog`, `unstarted`, `started`, `completed`, `canceled`). */
  state: z.object({ name: z.string(), type: z.string() }),
});
export type RetroFiledIssue = z.infer<typeof RetroFiledIssue>;

/** What reasoning reads for one retro. */
export const RetroCase = z.object({
  /** The window: since the previous retro (or two weeks, for the first) until now. */
  since: Instant,
  until: Instant,
  /** The previous retro's document and the issues it filed, as they stand now; null for the first retro. */
  previous: z
    .object({ title: z.string(), createdAt: Instant, content: z.string(), filed: z.array(RetroFiledIssue) })
    .nullable(),
  feedbackTasks: z.array(RetroFeedbackTask),
  /** Issues Sergeant filed in the window: follow-ups, feedback follow-ups, and earlier retro issues. */
  filedIssues: z.array(RetroFiledIssue),
});
export type RetroCase = z.infer<typeof RetroCase>;

/** Task or issue identifiers, as the inputs name them. */
const Evidence = z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, "expected an issue identifier")).min(1);

/** Reasoning's retro. The bar for `issues` is in the prompt; at most three bounds a runaway answer. */
export const RetroAnswer = z.object({
  /** One paragraph: did the previous retro's recommendations happen, and did those themes stop recurring. */
  lastTime: z.string().min(1).max(2_000),
  themes: z
    .array(z.object({ title: z.string().min(1).max(200), evidence: Evidence, recommendation: z.string().min(1).max(1_500) }))
    .max(8),
  issues: z
    .array(
      z.object({
        /** Short, stable name for the idea: the issue's id derives from it, so a retried retro files it once. */
        key: z.string().regex(/^[a-z0-9-]{1,60}$/),
        /** In the issue's preference order: removing complexity first, new machinery last. */
        kind: z.enum(["remove_complexity", "guidance", "docs_or_tooling", "machinery"]),
        title: z.string().min(1).max(200),
        /** Markdown, standalone: the systemic problem, its cost, and the proposed change. */
        description: z.string().min(1).max(6_000),
        evidence: Evidence,
      }),
    )
    .max(3),
});
export type RetroAnswer = z.infer<typeof RetroAnswer>;

/** `POST /v1/retro` (`sgt retro`): a human asks for a retro now; it runs in the background. */
export const RetroRequestResponse = z.object({ requested: z.literal(true) });
export type RetroRequestResponse = z.infer<typeof RetroRequestResponse>;

import { z } from "zod";

// TECH-6021: `GET /v1/stops`, how often humans follow the stop rubric (docs/findings/tech-5922-wall-time-windows.md
// §6). Every budget question Sergeant asks records the rubric's call and rule; the human's reply to it is
// recorded next to it as extend, stop, or other. `sgt stops` prints it per rule.

export const StopCall = z.enum(["extend", "stop", "ask"]);
export const StopReply = z.enum(["extend", "stop", "other"]);
export type StopReply = z.infer<typeof StopReply>;

/** One budget question and, once a human replied, how they replied. */
export const StopEntry = z.object({
  task: z.string(),
  /** When the question was asked. */
  at: z.string(),
  rule: z.enum(["1", "2", "3"]),
  call: StopCall,
  reason: z.string(),
  estimate: z.string().optional(),
  reply: StopReply.optional(),
  repliedAt: z.string().optional(),
});
export type StopEntry = z.infer<typeof StopEntry>;

/**
 * Per rule and call: questions asked, replies by kind, and `followed`, replies that did what the call
 * said (an `ask` call has none to follow).
 */
export const StopRuleAgreement = z.object({
  rule: z.enum(["1", "2", "3"]),
  call: StopCall,
  asked: z.number().int(),
  unanswered: z.number().int(),
  extend: z.number().int(),
  stop: z.number().int(),
  other: z.number().int(),
  followed: z.number().int(),
});
export type StopRuleAgreement = z.infer<typeof StopRuleAgreement>;

export const StopAgreement = z.object({ rules: z.array(StopRuleAgreement), stops: z.array(StopEntry) });
export type StopAgreement = z.infer<typeof StopAgreement>;

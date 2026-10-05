import type { Tokens } from "./agents.ts";

// TECH-5021: a Codex run's cost, estimated from its tokens at OpenAI's published API list price for its
// model, the same "what the API would charge" basis Claude Code reports. Under a ChatGPT plan the real
// spend is sunk; the task budget is a runaway guard, not accounting, so this is deliberately rough:
// standard tier, short context, no cache-write or per-account subscription math.

/** USD per million tokens. `cachedInput` absent: cached input is charged as input. */
export type CodexPrice = { input: number; cachedInput?: number | undefined; output: number };

/**
 * OpenAI's standard-tier text-token list prices (https://developers.openai.com/api/docs/pricing, read
 * 2026-10-05) for the GPT-5 family and later models Codex runs. The config's `codex.prices` adds to or
 * replaces these.
 */
export const CODEX_PRICES: Record<string, CodexPrice> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
};

/**
 * Codex counts cached input within `input` and reasoning within `output`, as OpenAI's usage does, so
 * cached tokens are moved to their own price and reasoning is not charged twice.
 */
export function estimateCodexCost(tokens: Tokens, price: CodexPrice): number {
  const cached = Math.min(tokens.cachedInput, tokens.input);
  return ((tokens.input - cached) * price.input + cached * (price.cachedInput ?? price.input) + tokens.output * price.output) / 1_000_000;
}

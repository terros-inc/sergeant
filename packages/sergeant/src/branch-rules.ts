import { z } from "zod";

// GitHub's "get rules for a branch" response, as the live check reads it. Every active rule names its
// ruleset: the worker-bypass check queries each one, so a rule without an ID must not parse.
export const BranchRules = z.array(
  z.object({ type: z.string(), parameters: z.unknown().optional(), ruleset_id: z.number().int().positive() }),
);

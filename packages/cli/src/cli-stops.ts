import { StopAgreement } from "@terros/sergeant-contracts";
import { type Command, callAnswer, print } from "./cli-call.ts";
import { table } from "./format.ts";

// `sgt stops` (TECH-6021): per stop-rubric rule and call, how humans replied to the budget questions,
// and how many replies followed the recommendation. `--json` adds every stop.

export const stopCommands: Record<string, Command> = {
  stops: {
    args: 0,
    run: async (ctx) => {
      const { value: { rules }, answer } = await callAnswer(ctx, "GET", "/v1/stops", StopAgreement);
      print(ctx, answer, () => {
        if (rules.length === 0) return "no budget stops recorded";
        const rows = rules.map((r) => {
          const replied = r.asked - r.unanswered;
          const followed = r.call === "ask" ? "-" : `${r.followed}/${replied}${replied ? ` (${Math.round((100 * r.followed) / replied)}%)` : ""}`;
          return [`rule ${r.rule}`, r.call, `${r.asked} asked`, `${r.unanswered} unanswered`, `extend ${r.extend}`, `stop ${r.stop}`, `other ${r.other}`, `followed ${followed}`];
        });
        return table(rows);
      });
    },
  },
};

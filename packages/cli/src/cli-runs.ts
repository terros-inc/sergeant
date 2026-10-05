import { CancelRunResponse, RunDetail, RunList } from "@terros/sergeant-contracts";
import { type Command, call, callAnswer, path, print, request } from "./cli-call.ts";
import { runRow, showRun, table } from "./format.ts";

// `sgt run …`: a task's runs, one run's detail and raw report, and canceling one.

export const runCommands: Record<string, Command> = {
  "run list": {
    args: 0,
    flags: ["task"],
    run: async (ctx) => {
      const query = ctx.flags.task ? `?task=${path(ctx.flags.task)}` : "";
      const { runs } = await call(ctx, "GET", `/v1/runs${query}`, RunList);
      print(ctx, { runs }, () => (runs.length ? table(runs.map(runRow)) : "no runs"));
    },
  },
  "run show": {
    args: 1,
    run: async (ctx, [runId]) => {
      const { value: detail, answer } = await callAnswer(ctx, "GET", `/v1/runs/${path(runId)}`, RunDetail);
      print(ctx, answer, () => showRun(detail));
    },
  },
  "run report": {
    args: 1,
    run: async (ctx, [runId]) => {
      const markdown = await request(ctx, "GET", `/v1/runs/${path(runId)}/report`);
      ctx.io.out(ctx.json ? `${JSON.stringify({ report: markdown })}\n` : markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    },
  },
  "run cancel": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [runId]) => {
      const res = await call(ctx, "POST", `/v1/runs/${path(runId)}/cancel`, CancelRunResponse, { reason: ctx.flags.reason });
      print(ctx, res, () => `${res.runId} (${res.task}) ${res.status === "canceled" ? "canceled" : `already ${res.status}`}`);
    },
  },
};

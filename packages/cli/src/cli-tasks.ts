import { randomUUID } from "node:crypto";
import { CancelTaskResponse, TaskDetail, TaskList, WakeResponse } from "@terros/sergeant-contracts";
import { type Command, call, path, print, Usage } from "./cli-call.ts";
import { showTask, table, taskRow } from "./format.ts";

// `sgt task …`: the tasks Sergeant knows, and waking or canceling one.

export const taskCommands: Record<string, Command> = {
  "task list": {
    args: 0,
    run: async (ctx) => {
      const { tasks } = await call(ctx, "GET", "/v1/tasks", TaskList);
      print(ctx, { tasks }, () => (tasks.length ? table(tasks.map(taskRow)) : "no tasks"));
    },
  },
  "task show": {
    args: 1,
    run: async (ctx, [ref]) => {
      const detail = await call(ctx, "GET", `/v1/tasks/${path(ref)}`, TaskDetail);
      print(ctx, detail, () => showTask(detail));
    },
  },
  "task wake": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [ref]) => {
      const res = await call(ctx, "POST", `/v1/tasks/${path(ref)}/wake`, WakeResponse, { reason: ctx.flags.reason });
      const said = {
        active: "its loop polls now and takes a turn once nothing holds it (a running run, an open question, an exhausted budget)",
        admitted: "its loop started and takes a turn",
        queued: "every task slot is busy; it starts and takes a turn at the next free slot",
      }[res.woke];
      print(ctx, res, () => `${res.ref} woken: ${said}`);
    },
  },
  "task cancel": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [ref]) => {
      if (!ctx.flags.reason?.trim()) throw new Usage("task cancel needs --reason");
      const res = await call(ctx, "POST", `/v1/tasks/${path(ref)}/cancel`, CancelTaskResponse, { reason: ctx.flags.reason, requestId: randomUUID() });
      print(ctx, res, () => {
        const delegation = res.undelegated ? "Sergeant's delegation is removed" : "Sergeant was already not delegated";
        if (res.stopping.length > 0) {
          return `${res.ref} canceling: ${delegation}; not yet confirmed stopped, Sergeant keeps canceling: ${res.stopping.join(", ")} (sgt run list --task ${res.ref}). Its open PRs are closed once they stop.`;
        }
        const prs = res.closedPullRequests;
        const closed = prs.length === 0 ? ["no open worker PR to close"] : prs.map((p) => `closed ${p.repo}#${p.number}  ${p.url}`);
        return [`${res.ref} canceled: ${delegation} and no run of it is running`, ...closed].join("\n");
      });
    },
  },
};

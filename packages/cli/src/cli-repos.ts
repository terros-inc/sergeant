import { RepositoryChange, RepositoryList } from "@terros/sergeant-contracts";
import { type Command, call, print } from "./cli-call.ts";
import { table } from "./format.ts";

// `sgt repo list`, any signed-in user's, and an approver's `sgt admin repo add` and `remove`.

export const repoCommands: Record<string, Command> = {
  "repo list": {
    args: 0,
    run: async (ctx) => {
      const { repositories } = await call(ctx, "GET", "/v1/repositories", RepositoryList);
      print(ctx, { repositories }, () => (repositories.length ? table(repositories.map((r) => [r.repo, r.mergeMethod, `merged by ${r.mergePolicy}`])) : "no enrolled repositories"));
    },
  },
  "admin repo add": {
    args: 1,
    flags: ["merge-method", "merge-policy"],
    run: async (ctx, [repo]) => {
      const body = { repo, mergeMethod: ctx.flags["merge-method"], mergePolicy: ctx.flags["merge-policy"] };
      const res = await call(ctx, "POST", "/v1/repositories/add", RepositoryChange, body);
      print(ctx, res, () => `${res.changed ? "enrolled" : "already enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ")}`);
    },
  },
  "admin repo remove": {
    args: 1,
    run: async (ctx, [repo]) => {
      const res = await call(ctx, "POST", "/v1/repositories/remove", RepositoryChange, { repo });
      print(ctx, res, () => `${res.changed ? "removed" : "not enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ") || "none"}`);
    },
  },
};

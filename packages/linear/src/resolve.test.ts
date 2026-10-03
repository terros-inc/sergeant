import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5052: Sergeant collapses its own answered question threads, and must never resolve a human's
// thread or fight a human who already resolved one.
test("resolveThread resolves only Sergeant's unresolved thread, from its top comment", async () => {
  const comments: Record<string, { id: string; parentId: string | null; resolvedAt: string | null; user: { id: string } | null }> = {
    question: { id: "question", parentId: null, resolvedAt: null, user: { id: "sergeant-user" } },
    "follow-up": { id: "follow-up", parentId: "question", resolvedAt: null, user: { id: "sergeant-user" } },
    "human-thread": { id: "human-thread", parentId: null, resolvedAt: null, user: { id: "human" } },
    "bot-thread": { id: "bot-thread", parentId: null, resolvedAt: null, user: null },
  };
  const resolved: string[] = [];
  const linear = createLinearPort({
    apiKey: "test",
    sergeantUserIds: ["sergeant-user"],
    fetch: async (_i, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
      const comment = comments[variables.id];
      if (!query.includes("commentResolve")) return Response.json({ data: { comment: comment ?? null } });
      resolved.push(variables.id);
      if (comment) comment.resolvedAt = "2026-10-03T06:00:00.000Z";
      return Response.json({ data: { commentResolve: { success: true } } });
    },
  });

  // A follow-up asked in the thread resolves the thread's top question; again, it is a no-op.
  expect(await linear.resolveThread?.("follow-up")).toBe("resolved");
  expect(await linear.resolveThread?.("question")).toBe("already_resolved");
  expect(await linear.resolveThread?.("human-thread")).toBe("not_sergeants");
  expect(await linear.resolveThread?.("bot-thread")).toBe("not_sergeants");
  expect(resolved).toEqual(["question"]);
});

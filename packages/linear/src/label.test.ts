import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5186: the retro finds feedback by the `sergeant-feedback` label, which a human provisions. The
// adapter prefers the workspace label, never relabels, and fails on a missing label so the caller retries.
test("addLabel prefers a workspace label, skips an issue that has it, and fails when the label is missing", async () => {
  type Req = { query: string; variables: { labelIds?: string[] } };
  let labels: { id: string; team: { id: string } | null }[] = [];
  const onIssue: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as Req;
    if (query.includes("SergeantIssueLabels")) {
      return Response.json({ data: { issue: { id: "i1", team: { id: "team-1" }, labels: { nodes: onIssue.map((id) => ({ id, name: "Sergeant-Feedback" })) } } } });
    }
    if (query.includes("SergeantLabelsByName")) return Response.json({ data: { issueLabels: { nodes: labels } } });
    onIssue.push(...(variables.labelIds ?? []));
    return Response.json({ data: { issueUpdate: { success: true } } });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });

  await expect(linear.addLabel("UNF-1", "sergeant-feedback")).rejects.toThrow(/no "sergeant-feedback" label/);
  expect(onIssue).toEqual([]);

  labels = [{ id: "team-label", team: { id: "team-1" } }, { id: "workspace-label", team: null }, { id: "other", team: { id: "team-2" } }];
  await linear.addLabel("UNF-1", "sergeant-feedback");
  expect(onIssue).toEqual(["workspace-label"]);
  await linear.addLabel("UNF-1", "sergeant-feedback");
  expect(onIssue).toHaveLength(1);
});

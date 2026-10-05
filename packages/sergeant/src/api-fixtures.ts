import { request } from "node:http";
import { CLI_VERSION_HEADER, type Conversation, MIN_CLI_VERSION, type RunRecord } from "@terros/sergeant-contracts";
import type { ServiceDeps } from "./service.ts";

// The fakes the client API tests (api.test.ts, api-cancel.test.ts) run `serve` over, and their HTTP call.

/** An open Todo issue with no priority, as intake lists it. */
const todo = (identifier: string) => ({ identifier, priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] });

export const agent = { id: "agent-v2", name: "Sergeant" };

export function fakes(runs: RunRecord[] = []) {
  const conversation: Conversation = {
    issue: { id: "i-UNF-1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Fix the login", description: "D", state: "Todo", stateType: "unstarted", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  };
  const comments: { key: string; body: string }[] = [];
  const canceled: string[] = [];
  let turns = 0;
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => (conversation.issue.delegate ? [{ ...todo("UNF-1"), state: { name: conversation.issue.state, type: conversation.issue.stateType } }] : []),
    undelegate: async () => {
      conversation.issue.delegate = null;
    },
    linear: {
      readConversation: async (id) => (id === "UNF-1" ? conversation : Promise.reject(new Error(`no ${id}`))),
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async ({ key, body }) => void comments.push({ key, body }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: {
      start: async () => {},
      status: async (runId) => runs.find((r) => r.runId === runId) ?? Promise.reject(new Error(`no ${runId}`)),
      cancel: async (runId) => {
        canceled.push(runId);
        const run = runs.find((r) => r.runId === runId);
        if (run) run.status = "canceled";
      },
    },
    reasoner: {
      async turn() {
        turns++;
        return { output: { summary: `turn ${turns}: nothing to do yet`, actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, conversation, comments, canceled, turns: () => turns };
}

export function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { [CLI_VERSION_HEADER]: MIN_CLI_VERSION, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

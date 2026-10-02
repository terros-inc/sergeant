import { McpServer } from "@modelcontextprotocol/server";
import { ApiError, RunDetail, RunId, RunList, TaskDetail, TaskList, TaskRef } from "@terros/sergeant-contracts";
import { z } from "zod";

// `sgt-mcp` (TECH-4940): Sergeant for MCP clients such as ChatGPT and Firstmate, the read-only half
// of `sgt`. Like the CLI it is a thin client of the Sergeant API (11 §2): each tool is one GET, its
// answer validated against the API contract and returned unchanged as structured content, so it
// carries exactly what `sgt task show` and `sgt run show` print, with ids and URLs, and no
// transcripts. Every decision and lookup stays the server's, and it sends no POST, so it has no
// mutation authority. It sends no Linear login yet (TECH-4938), so only a `serve --trust-loopback`
// on its own host answers it; it runs there, over stdio.

export const DEFAULT_API = "http://127.0.0.1:8080";

const Health = z.object({ ok: z.boolean() });

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** An MCP server whose tools read the Sergeant API at `api`; connect it to a transport to serve. */
export function sergeantMcp(api: string, fetchFn: typeof globalThis.fetch = globalThis.fetch): McpServer {
  const server = new McpServer({ name: "sergeant", version: "0.0.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  /** One GET; a refusal, an unreachable API, or an answer outside the contract is a tool error. */
  async function get(path: string): Promise<{ ok: true; status: number; text: string } | { ok: false; result: Result }> {
    let res: Response;
    try {
      res = await fetchFn(`${api}${path}`);
    } catch (e) {
      const cause = ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message;
      return { ok: false, result: error("unavailable", `cannot reach the Sergeant API at ${api} (${cause}); is serve running on this host?`) };
    }
    const text = await res.text();
    if (res.ok) return { ok: true, status: res.status, text };
    const refused = ApiError.safeParse(safeJson(text));
    if (refused.success) return { ok: false, result: error(refused.data.error.code, refused.data.error.message) };
    return { ok: false, result: error("unavailable", `GET ${path} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`) };
  }

  async function read<T extends Record<string, unknown>>(path: string, schema: z.ZodType<T>): Promise<Result> {
    const res = await get(path);
    if (!res.ok) return res.result;
    const parsed = schema.safeParse(safeJson(res.text));
    if (!parsed.success) return error("unavailable", `GET ${path} answered outside the API contract: ${parsed.error.issues[0]?.message ?? res.text.slice(0, 200)}`);
    return { content: [{ type: "text", text: JSON.stringify(parsed.data) }], structuredContent: parsed.data };
  }

  server.registerTool(
    "task_list",
    {
      description: "Every task Sergeant knows (a Linear issue delegated to it): status, turn and run counts, last turn summary, merged PR. Like `sgt task list`.",
      outputSchema: TaskList,
      annotations: readOnly,
    },
    () => read("/v1/tasks", TaskList),
  );

  server.registerTool(
    "task_show",
    {
      description:
        "One task, as `sgt task show` shows it: status, the Linear issue (title, state, URL, delegate), budget, its runs, the last 5 turns, filed follow-ups. Use run_show for a run's report.",
      inputSchema: z.object({ ref: TaskRef.describe("Linear issue identifier, e.g. UNF-123") }),
      outputSchema: TaskDetail,
      annotations: readOnly,
    },
    ({ ref }) => read(`/v1/tasks/${encodeURIComponent(ref)}`, TaskDetail),
  );

  server.registerTool(
    "run_list",
    {
      description: "Worker and reviewer runs, of every task or of one: status, role, model, cost, report summary. Like `sgt run list`.",
      inputSchema: z.object({ task: TaskRef.optional().describe("only this task's runs, e.g. UNF-123") }),
      outputSchema: RunList,
      annotations: readOnly,
    },
    ({ task }) => read(`/v1/runs${task ? `?task=${encodeURIComponent(task)}` : ""}`, RunList),
  );

  server.registerTool(
    "run_show",
    {
      description:
        "One run and its parsed report: a worker's outcome, summary, PRs (URL, head SHA, review call), known gaps, follow-ups; a reviewer's verdict and findings. Like `sgt run show`.",
      // No outputSchema: the report's review call is a transform (fails toward review), which JSON
      // Schema cannot express. The answer is still validated against `RunDetail` before it is returned.
      inputSchema: z.object({ run: RunId.describe("run id, e.g. run_…") }),
      annotations: readOnly,
    },
    ({ run }) => read(`/v1/runs/${encodeURIComponent(run)}`, RunDetail),
  );

  server.registerTool(
    "run_report",
    {
      description: "A run's raw Markdown report as the agent wrote it, when run_show's parsed report is not enough. Like `sgt run report`.",
      inputSchema: z.object({ run: RunId.describe("run id, e.g. run_…") }),
      annotations: readOnly,
    },
    async ({ run }) => {
      const res = await get(`/v1/runs/${encodeURIComponent(run)}/report`);
      return res.ok ? { content: [{ type: "text", text: res.text }] } : res.result;
    },
  );

  server.registerTool(
    "health",
    {
      description: "Whether Sergeant's service is healthy (running, not stopping, its latest intake succeeded), and which API this server reads.",
      outputSchema: Health.extend({ api: z.string() }),
      annotations: readOnly,
    },
    async () => {
      // `/health` answers 503 with `{ ok: false }` when unhealthy: that is an answer, not a failure.
      let res: Response;
      try {
        res = await fetchFn(`${api}/health`);
      } catch (e) {
        return error("unavailable", `cannot reach Sergeant at ${api} (${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message})`);
      }
      const parsed = Health.safeParse(safeJson(await res.text()));
      if (!parsed.success) return error("unavailable", `GET /health answered ${res.status} outside its contract`);
      const health = { ok: parsed.data.ok, api };
      return { content: [{ type: "text", text: JSON.stringify(health) }], structuredContent: health };
    },
  );

  return server;
}

function error(code: ApiError["error"]["code"], message: string): Result {
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } } satisfies ApiError) }], isError: true };
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

import { McpServer } from "@modelcontextprotocol/server";
import {
  type ApiError,
  type ApiFailure,
  apiClient,
  RunDetail,
  RunId,
  RunList,
  safeJson,
  sergeantVersion,
  skewWarning,
  TaskDetail,
  TaskList,
  TaskRef,
} from "@terros/sergeant-contracts";
import { z } from "zod";

// `sgt-mcp` (TECH-4940): Sergeant for MCP clients such as ChatGPT and Firstmate, the read-only half
// of `sgt`. Like the CLI it is a thin client of the Sergeant API (11 §2): each tool is one GET, its
// answer validated against the API contract and returned unchanged as structured content, so it
// carries exactly what `sgt task show` and `sgt run show` print, with ids and URLs, and no
// transcripts. Every decision and lookup stays the server's, and it sends no POST, so it has no
// mutation authority. It sends no Linear login yet (TECH-4938), so only a `serve --trust-loopback`
// on its own host answers it; it runs there, over stdio. Version skew (contracts' skew.ts) is told to
// the agent: a differing contract adds a warning to each result, and an older Sergeant's answer that
// lacks fields comes back as text, since it cannot pass the tool's output schema.

export const DEFAULT_API = "http://127.0.0.1:8080";

const Health = z.object({ ok: z.boolean() });

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** An MCP server whose tools read the Sergeant API at `api`; connect it to a transport to serve. */
export function sergeantMcp(api: string, fetchFn: typeof globalThis.fetch = globalThis.fetch): McpServer {
  const { version } = sergeantVersion();
  const server = new McpServer({ name: "sergeant", version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  let skew: string | undefined;
  const client = apiClient({
    api,
    fetch: fetchFn,
    unreachableHint: "; is serve running on this host?",
    onSkew: (theirs) => (skew = `warning: ${skewWarning(api, theirs, version)}`),
  });

  /** One GET, its answer validated against `schema`; a refusal, an unreachable API, or an answer outside the contract is a tool error. */
  async function read<T extends Record<string, unknown>>(path: string, schema: z.ZodType<T>): Promise<Result> {
    skew = undefined;
    const res = await client.call("GET", path, schema);
    const warning = skew === undefined ? [] : [{ type: "text" as const, text: skew }];
    if (!res.ok) return withWarning(error(res.error), warning);
    const text = JSON.stringify(res.value);
    // isError, because a result with an outputSchema must carry structuredContent that matches it,
    // and this answer does not; the data is still in the text.
    if (res.absent) {
      const why = `Sergeant at ${api} is older than this sgt-mcp: its answer lacks ${res.absent.join(", ")}, so it is returned as text, not structured content.`;
      return { content: [{ type: "text", text: why }, { type: "text", text }, ...warning], isError: true };
    }
    return { content: [{ type: "text", text }, ...warning], structuredContent: res.value };
  }

  server.registerTool(
    "task_list",
    {
      description: "Every task Sergeant knows (a Linear issue delegated to it): status, turn and run counts, last turn summary, merged PR, a pending accepted ending. Like `sgt task list`.",
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
      const res = await client.request("GET", `/v1/runs/${encodeURIComponent(run)}/report`);
      return res.ok ? { content: [{ type: "text", text: res.value }] } : error(res.error);
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
        return error({ code: "unavailable", message: `cannot reach Sergeant at ${api} (${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message})` });
      }
      const parsed = Health.safeParse(safeJson(await res.text()));
      if (!parsed.success) return error({ code: "unavailable", message: `GET /health answered ${res.status} outside its contract` });
      const health = { ok: parsed.data.ok, api };
      return { content: [{ type: "text", text: JSON.stringify(health) }], structuredContent: health };
    },
  );

  return server;
}

const withWarning = (result: Result, warning: Result["content"]): Result => ({ ...result, content: [...result.content, ...warning] });

function error(failure: ApiFailure): Result {
  return { content: [{ type: "text", text: JSON.stringify({ error: failure } satisfies ApiError) }], isError: true };
}

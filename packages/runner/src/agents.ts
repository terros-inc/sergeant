import type { RunFailureReason, RunRecord } from "@terros/sergeant-contracts";
import { z } from "zod";

// The agent CLIs a run can use (04 §10, TECH-5009). Each runs in the same container, with the same
// workspace, worker-App token, git identity, and network; only the model CLI and its one credential
// differ. Each script runs inside the container with `sh -c <script> sh <wall> <model> <budget>`.

export const ADAPTERS = ["claude-code-local", "codex-local"] as const;
export type Adapter = (typeof ADAPTERS)[number];

export type Tokens = NonNullable<RunRecord["tokens"]>;

/** What the agent CLI said when it ended, read from the container's stdout. */
export type AgentResult = {
  ok: boolean;
  /** Why it did not succeed, in the CLI's words. */
  detail?: string;
  /** An actionable failure category, without credential or provider error text. */
  failureReason?: RunFailureReason;
  sessionId?: string;
  /** Only a dollar figure the CLI itself reported; never an estimate. */
  costUsd?: number;
  tokens?: Tokens;
  /** Models the CLI says it used; empty when it does not say. */
  models: string[];
};

export type Agent = {
  provider: string;
  /** The model credential's variable: the only one that enters this agent's containers. */
  credentialEnv: string;
  script: string;
  parse(stdout: string, stderr?: string): AgentResult;
};

const PROMPT = "Read /workspace/sergeant-brief.md and do what it says. Your last step is writing /workspace/sergeant-report.md.";

/** The `claude -p` result line; everything else in it is ignored. */
const ClaudeOutput = z.object({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

const claude: Agent = {
  provider: "anthropic/claude-code",
  credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  script: `
wall="$1"; model="$2"; budget="$3"
exec timeout "$wall" claude -p "${PROMPT}" \\
  --output-format json --model "$model" --max-budget-usd "$budget" --permission-mode bypassPermissions
`,
  parse(stdout) {
    const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
    const out = line ? ClaudeOutput.safeParse(JSON.parse(line)).data : undefined;
    return {
      ok: out?.is_error === false,
      ...(out?.subtype && { detail: out.subtype }),
      ...(out?.session_id && { sessionId: out.session_id }),
      ...(out?.total_cost_usd !== undefined && { costUsd: out.total_cost_usd }),
      models: Object.keys(out?.modelUsage ?? {}),
    };
  },
};

/**
 * The `codex exec --json` events read here (checked against Codex CLI 0.160.0 and its SDK's
 * `ThreadEvent` types): the thread id, each turn's token usage, and a failed turn's error. Codex
 * reports no dollar figure and no resolved model, so a Codex run's cost is unknown.
 */
const CodexEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.started"), thread_id: z.string() }),
  z.object({
    type: z.literal("turn.completed"),
    usage: z.object({
      input_tokens: z.number(),
      cached_input_tokens: z.number().default(0),
      output_tokens: z.number(),
      reasoning_output_tokens: z.number().default(0),
    }),
  }),
  z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }) }),
]);

// Verbatim user-facing refresh failures in the pinned Codex 0.160.0 binary. These can be emitted
// before the JSON event stream starts, so stderr is checked only for these specific messages.
const CODEX_REFRESH_FAILURES = [
  "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
  "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
  "Your access token could not be refreshed. Please log out and sign in again.",
] as const;
const CODEX_STRUCTURED_AUTH_FAILURE = /(?:\b401\b|unauthori[sz]ed|authentication failed|invalid[_ -]?grant)/i;
const isCodexRefreshFailure = (text: string) => CODEX_REFRESH_FAILURES.some((message) => text.includes(message));
const CODEX_AUTH_DETAIL = "Codex authentication failed; replace the installation's Codex credential or switch to an OpenAI API key";

/**
 * `CODEX_CREDENTIAL` is the installation's Codex secret: the JSON of a `codex login`'s `auth.json`
 * (a ChatGPT workspace login), or an OpenAI API key. Either way it becomes the container's own
 * `~/.codex/auth.json`, outside the workspace, and the variable is unset before Codex starts.
 * The container is the sandbox, as with Claude Code's bypassPermissions.
 */
export const CODEX_LOGIN = `
case "$CODEX_CREDENTIAL" in
  "{"*) mkdir -p "$HOME/.codex" && (umask 077 && printf '%s' "$CODEX_CREDENTIAL" > "$HOME/.codex/auth.json") ;;
  *) printf '%s' "$CODEX_CREDENTIAL" | codex login --with-api-key > /dev/null ;;
esac || exit 1
unset CODEX_CREDENTIAL
`;

const codex: Agent = {
  provider: "openai/codex",
  credentialEnv: "CODEX_CREDENTIAL",
  // Codex has no spend cap; the wall-time limit is the only backstop (04 §7), and "$3" is unused.
  script: `
wall="$1"; model="$2"
${CODEX_LOGIN}
/home/node/install-codex-commit-msg-hook.sh
exec timeout "$wall" codex exec --json --model "$model" --cd /workspace --skip-git-repo-check \\
  --dangerously-bypass-approvals-and-sandbox "${PROMPT}"
`,
  parse(stdout, stderr = "") {
    let sessionId: string | undefined;
    let tokens: Tokens | undefined;
    let failure: string | undefined;
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const event = CodexEvent.safeParse(json).data;
      if (event?.type === "thread.started") sessionId = event.thread_id;
      else if (event?.type === "turn.failed") failure = event.error.message;
      else if (event?.type === "turn.completed") {
        const u = event.usage;
        const t = tokens ?? { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
        tokens = {
          input: t.input + u.input_tokens,
          cachedInput: t.cachedInput + u.cached_input_tokens,
          output: t.output + u.output_tokens,
          reasoningOutput: t.reasoningOutput + u.reasoning_output_tokens,
        };
        failure = undefined;
      }
    }
    // Structured turn failures are authoritative. Login failures happen before JSON starts and are
    // written to stderr. Never scan successful item text, which could merely discuss a 401.
    const authenticationFailed =
      (failure !== undefined && (isCodexRefreshFailure(failure) || CODEX_STRUCTURED_AUTH_FAILURE.test(failure))) ||
      (tokens === undefined && isCodexRefreshFailure(stderr));
    return {
      ok: tokens !== undefined && failure === undefined,
      // OpenAI's errors quote part of an API key; a run record never holds any of it.
      ...(authenticationFailed
        ? { detail: CODEX_AUTH_DETAIL, failureReason: "authentication" as const }
        : failure !== undefined
          ? { detail: failure.replace(/sk-[\w*.-]+/g, "sk-[redacted]").slice(0, 300) }
          : tokens === undefined && { detail: "no completed turn" }),
      ...(sessionId && { sessionId }),
      ...(tokens && { tokens }),
      models: [],
    };
  },
};

export const AGENTS: Record<Adapter, Agent> = { "claude-code-local": claude, "codex-local": codex };

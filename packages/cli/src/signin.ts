import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Provider } from "@terros/sergeant-contracts";

// `sgt account register` with nothing on stdin (TECH-5196): the provider's own sign-in, on this
// terminal, so its browser login works. Codex logs in to a throwaway CODEX_HOME, never the person's
// ~/.codex, and sgt reads its auth.json and deletes it. `claude setup-token` draws for a terminal,
// has no quiet mode, and prints the token among its prompts (TECH-5202): sgt runs it under a
// pseudo-terminal from the system's own `script` (macOS and Linux, so no dependency), shows its screen
// as it draws, and reads the token from it in memory. Where there is no `script`, or the token cannot
// be read unambiguously, the person pastes it, unechoed. Neither credential is printed beyond what the
// provider's CLI shows, logged, or left on disk by sgt.

const INSTALL: Record<Provider, string> = {
  claude: "Claude Code (https://docs.claude.com/en/docs/claude-code/setup)",
  codex: "the Codex CLI (`npm install -g @openai/codex`)",
};

export type SignInDeps = {
  /** The environment the provider's CLI runs in: PATH finds it. */
  env: Record<string, string | undefined>;
  /** Reads one line from the person without echoing it. */
  askSecret: (prompt: string) => Promise<string>;
  /** Shows the provider's screen while sgt reads it: stderr, so `--json` output stays clean. */
  show?: (chunk: Buffer) => void;
};

/** The credential the provider's own sign-in produced. */
export async function signIn(provider: Provider, deps: SignInDeps): Promise<string> {
  if (provider === "claude") {
    const screen = await setupToken(deps);
    const token = screen === undefined ? undefined : tokenIn(screen);
    if (token) return token;
    const unread = screen === undefined ? "" : "sgt could not read the token from its screen. ";
    return deps.askSecret(`${unread}Paste the token \`claude setup-token\` printed (sk-ant-oat01-…; it is not shown), then press Enter: `);
  }
  const home = await mkdtemp(join(tmpdir(), "sgt-codex-"));
  try {
    await interactive(provider, ["login"], { ...deps.env, CODEX_HOME: home });
    return await readFile(join(home, "auth.json"), "utf8").catch(() => {
      throw new Error("`codex login` finished but wrote no auth.json; sign in with your ChatGPT account, not an API key");
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Runs `claude setup-token` on this terminal: its screen as text when it ran under `script`, else undefined. */
async function setupToken(deps: SignInDeps): Promise<string | undefined> {
  if (!(await onPath("script", deps.env))) {
    await interactive("claude", ["setup-token"], deps.env);
    return undefined;
  }
  // `script` would only say it cannot run it.
  if (!(await onPath("claude", deps.env))) throw notInstalled("claude");
  // BSD `script` takes the command as arguments; util-linux `script` as one shell string, `-e` for its exit status.
  const pty = process.platform === "linux" ? ["-q", "-e", "-c", "claude setup-token", "/dev/null"] : ["-q", "/dev/null", "claude", "setup-token"];
  return interactive("script", pty, deps.env, { as: "claude setup-token", show: deps.show ?? ((chunk) => process.stderr.write(chunk)) });
}

const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]+/g;

/**
 * The one token `claude setup-token` drew, or undefined. Its screen is redrawn, colored, and wrapped
 * at the terminal's width: a token that ends at a line break with more token-like text on the next
 * line may have been wrapped, so it reads as none, and so do two different tokens.
 */
export function tokenIn(screen: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- terminal control sequences are what it removes
  const text = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "").replace(/\r/g, "");
  const found = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    if (/^[ \t]*\n[ \t]*[A-Za-z0-9_-]/.test(text.slice(m.index + m[0].length))) return undefined;
    found.add(m[0]);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Runs `command` on this terminal and resolves when it exits 0. With `read`, its output passes through
 * `read.show`, and it resolves to that output, kept only in memory.
 */
function interactive(command: string, args: string[], env: Record<string, string | undefined>, read?: { as: string; show: (chunk: Buffer) => void }): Promise<string> {
  const named = read?.as ?? `${command} ${args.join(" ")}`;
  // Ctrl-C reaches the child too: let it end the sign-in, so sgt still deletes the throwaway state.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["inherit", read ? "pipe" : "inherit", "inherit"], env });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      read?.show(chunk);
      chunks.push(chunk);
    });
    child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" && isProvider(command) ? notInstalled(command) : e));
    child.on("close", (code, signal) =>
      code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`\`${named}\` ${signal ? `was stopped (${signal})` : `exited ${code}`}; nothing was registered`)),
    );
  }).finally(() => process.off("SIGINT", ignore));
}

const isProvider = (command: string): command is Provider => command === "claude" || command === "codex";
const notInstalled = (provider: Provider) => new Error(`\`${provider}\` is not installed or not on your PATH: install ${INSTALL[provider]}, or pipe the credential to sgt account register`);

/** Whether `command` is an executable on the environment's PATH. */
async function onPath(command: string, env: Record<string, string | undefined>): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await access(join(dir, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/** One line from the terminal, not echoed: raw mode, so the keys typed or pasted are never shown. */
export function askSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = (finish: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      finish();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // A terminal in bracketed-paste mode wraps a paste in ESC[200~ … ESC[201~; the ESCs are dropped below.
        if (ch === "\r" || ch === "\n") return done(() => resolve(value.replace(/\[20[01]~/g, "")));
        if (ch === "\u0003" || ch === "\u0004") return done(() => reject(new Error("canceled; nothing was registered")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

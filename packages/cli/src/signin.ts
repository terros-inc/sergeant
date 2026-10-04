import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@terros/sergeant-contracts";

// `sgt account register` with nothing on stdin (TECH-5196): the provider's own sign-in, on this
// terminal, so its browser login works. Codex logs in to a throwaway CODEX_HOME, never the person's
// ~/.codex, and sgt reads its auth.json and deletes it. `claude setup-token` draws its prompts for a
// terminal and prints the token among them, so sgt does not scrape its output: it asks the person to
// paste the token, without echoing it. Neither credential is printed, logged, or left on disk by sgt.

const INSTALL: Record<Provider, string> = {
  claude: "Claude Code (https://docs.claude.com/en/docs/claude-code/setup)",
  codex: "the Codex CLI (`npm install -g @openai/codex`)",
};

export type SignInDeps = {
  /** The environment the provider's CLI runs in: PATH finds it. */
  env: Record<string, string | undefined>;
  /** Reads one line from the person without echoing it. */
  askSecret: (prompt: string) => Promise<string>;
};

/** The credential the provider's own sign-in produced. */
export async function signIn(provider: Provider, deps: SignInDeps): Promise<string> {
  if (provider === "claude") {
    await interactive(provider, ["setup-token"], deps.env);
    return deps.askSecret("Paste the token `claude setup-token` printed (sk-ant-oat01-…; it is not shown), then press Enter: ");
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

/** Runs the provider's CLI on this terminal; resolves when it exits 0. */
function interactive(provider: Provider, args: string[], env: Record<string, string | undefined>): Promise<void> {
  const command = `${provider} ${args.join(" ")}`;
  // Ctrl-C reaches the child too: let it end the sign-in, so sgt still deletes the throwaway state.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(provider, args, { stdio: "inherit", env });
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error(`\`${provider}\` is not installed or not on your PATH: install ${INSTALL[provider]}, or pipe the credential to sgt account register`) : e),
    );
    child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`\`${command}\` ${signal ? `was stopped (${signal})` : `exited ${code}`}; nothing was registered`))));
  }).finally(() => process.off("SIGINT", ignore));
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

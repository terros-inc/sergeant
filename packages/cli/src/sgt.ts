#!/usr/bin/env node
import { spawn } from "node:child_process";
import { main } from "./cli.ts";
import { terminalPrompt } from "./prompt.ts";
import { askSecret, signIn } from "./signin.ts";

const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  // Best effort: `sgt login` prints the URL too, for a machine with no browser.
  openUrl: (url) =>
    new Promise<boolean>((resolve) => {
      const child = spawn(opener, [url], { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
      child.unref();
    }),
  prompt: terminalPrompt,
  // Standard input only when something is piped to it; a terminal signs in instead (TECH-5196).
  ...(!process.stdin.isTTY && {
    stdin: async () => {
      let text = "";
      for await (const chunk of process.stdin) text += String(chunk);
      return text;
    },
  }),
  signIn: (provider) => signIn(provider, { env: process.env, askSecret }),
});

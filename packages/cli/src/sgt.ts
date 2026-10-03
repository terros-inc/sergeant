#!/usr/bin/env node
import { spawn } from "node:child_process";
import { main } from "./cli.ts";

const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  // Best effort: `sgt login` prints the URL too, for a machine with no browser.
  openUrl: (url) => spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(),
  stdin: async () => {
    if (process.stdin.isTTY) process.stderr.write("Paste the credential, then press Enter and Ctrl-D:\n");
    let text = "";
    for await (const chunk of process.stdin) text += String(chunk);
    return text;
  },
});

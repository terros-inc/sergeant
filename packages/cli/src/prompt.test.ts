import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { terminalPrompt } from "./prompt.ts";

const terminal = () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
};

test("the login prompt rejects when the terminal interrupts or closes it", async () => {
  const interrupted = terminal();
  const interrupt = terminalPrompt("Paste: ", new AbortController().signal, interrupted.input, interrupted.output);
  interrupted.input.write("\x03");
  await expect(interrupt).rejects.toThrow("login prompt interrupted");

  const closed = terminal();
  const close = terminalPrompt("Paste: ", new AbortController().signal, closed.input, closed.output);
  closed.input.end();
  await expect(close).rejects.toThrow("login prompt closed before a callback URL or code was entered");
});

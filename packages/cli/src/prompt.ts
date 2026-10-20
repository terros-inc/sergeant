import { createInterface } from "node:readline";

/** Reads one terminal line, settling on every way readline can finish. */
export function terminalPrompt(
  message: string,
  signal: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException("The login prompt was closed", "AbortError"));

  return new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input, output });
    let settled = false;
    const finish = (result: { answer: string } | { error: Error }, alreadyClosed = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      lines.removeListener("SIGINT", onInterrupt);
      lines.removeListener("close", onClose);
      if (!alreadyClosed) lines.close();
      if ("answer" in result) resolve(result.answer);
      else reject(result.error);
    };
    const onAbort = () => finish({ error: new DOMException("The login prompt was closed", "AbortError") });
    const onInterrupt = () => finish({ error: new Error("login prompt interrupted") });
    const onClose = () => finish({ error: new Error("login prompt closed before a callback URL or code was entered") }, true);

    signal.addEventListener("abort", onAbort, { once: true });
    lines.once("SIGINT", onInterrupt);
    lines.once("close", onClose);
    lines.question(message, (answer) => finish({ answer }));
  });
}

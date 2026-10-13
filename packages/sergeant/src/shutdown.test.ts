import { expect, test, vi } from "vitest";
import { stopBeforeDeadline } from "./shutdown.ts";

test("a graceful stop that stalls reaches its internal deadline", async () => {
  vi.useFakeTimers();
  const stopped = stopBeforeDeadline(() => new Promise(() => {}), 5_000);

  await vi.advanceTimersByTimeAsync(5_000);

  await expect(stopped).resolves.toBe(false);
  vi.useRealTimers();
});

test("a completed graceful stop clears the deadline", async () => {
  await expect(stopBeforeDeadline(async () => {}, 5_000)).resolves.toBe(true);
});

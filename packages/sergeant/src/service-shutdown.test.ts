import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startService, type ServiceDeps } from "./service.ts";

let dir = "";
afterEach(async () => rm(dir, { recursive: true, force: true }));

test("stop closes an active HTTP connection instead of waiting for it forever", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-service-shutdown-test-"));
  const service = await startService(
    { enrolledRepositories: [], stateDir: dir, intakeSeconds: 3_600, port: 0, log: () => {} },
    // No issue can be admitted, so none of the other service ports are reached in this boundary test.
    { delegatedIssues: async () => [] } as unknown as ServiceDeps,
  );
  if (service.port === undefined) throw new Error("service did not listen");
  const socket = connect({ host: "127.0.0.1", port: service.port });
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // An incomplete request remains active, unlike an idle keep-alive, and used to hold server.close().
  socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");

  await service.stop();
  await closed;

  expect(socket.destroyed).toBe(true);
});

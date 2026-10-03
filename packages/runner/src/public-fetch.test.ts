import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { expect, test } from "vitest";
import type { Conversation } from "@terros/sergeant-contracts";
import { reasoningFiles } from "./attachments.ts";
import { fetchPublic, httpsGet, isPublicAddress, type Address, type Get } from "./public-fetch.ts";

// TECH-5036: a human-added link must not let the control plane reach its own internal services or the
// cloud metadata endpoint, by a literal address, a hostname that resolves to one, or a redirect.

test("only public unicast addresses are public", () => {
  const refused = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2001:db8::1",
  ];
  for (const ip of refused) expect(isPublicAddress(ip), ip).toBe(false);
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::6810:84e5", "2a00:1450:4001::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
});

/** A fake network: DNS answers from `dns`, each request answered by `routes` and recorded. */
function network(dns: Record<string, string[]>, routes: Record<string, () => Response>) {
  const requests: { url: string; addresses: string[] }[] = [];
  const resolve = async (host: string): Promise<Address[]> => (dns[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const get: Get = async (url, { addresses }) => {
    requests.push({ url: url.href, addresses: addresses.map((a) => a.address) });
    return routes[url.href]?.() ?? new Response("missing", { status: 404 });
  };
  const fetch = (url: string) => fetchPublic(url, { signal: AbortSignal.timeout(1000), resolve, get });
  return { requests, fetch };
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

test("downloads from a public host, connecting to the address it validated", async () => {
  const net = network({ "files.example.com": ["93.184.215.14"] }, { "https://files.example.com/a.log": () => new Response("ok") });
  expect(await (await net.fetch("https://files.example.com/a.log")).text()).toBe("ok");
  expect(net.requests).toEqual([{ url: "https://files.example.com/a.log", addresses: ["93.184.215.14"] }]);
});

test("refuses literal and resolved non-public addresses before connecting", async () => {
  const net = network({ "metadata.example.com": ["169.254.169.254"], "mixed.example.com": ["93.184.215.14", "10.0.0.5"] }, {});
  await expect(net.fetch("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/not a public address/);
  await expect(net.fetch("https://[fd00:ec2::254]/")).rejects.toThrow(/not a public address/);
  await expect(net.fetch("https://[::ffff:127.0.0.1]/")).rejects.toThrow(/not a public address/);
  await expect(net.fetch("https://0x7f.1/")).rejects.toThrow(/not a public address \(127\.0\.0\.1\)/);
  await expect(net.fetch("https://metadata.example.com/")).rejects.toThrow(/not a public address/);
  await expect(net.fetch("https://mixed.example.com/")).rejects.toThrow(/not a public address \(10\.0\.0\.5\)/);
  expect(net.requests).toEqual([]);
});

test("checks every redirect hop the same way", async () => {
  const net = network(
    { "files.example.com": ["93.184.215.14"], "cdn.example.net": ["2606:4700::6810:84e5"], "internal.example.com": ["127.0.0.1"] },
    {
      "https://files.example.com/ok": redirect("https://cdn.example.net/blob"),
      "https://cdn.example.net/blob": () => new Response("blob"),
      "https://files.example.com/to-internal": redirect("https://internal.example.com/admin"),
      "https://files.example.com/to-metadata": redirect("https://169.254.169.254/latest/"),
      "https://files.example.com/to-http": redirect("http://files.example.com/x"),
      "https://files.example.com/loop": redirect("/loop"),
    },
  );
  expect(await (await net.fetch("https://files.example.com/ok")).text()).toBe("blob");
  expect(net.requests.at(-1)).toEqual({ url: "https://cdn.example.net/blob", addresses: ["2606:4700::6810:84e5"] });
  await expect(net.fetch("https://files.example.com/to-internal")).rejects.toThrow(/internal\.example\.com is not a public address/);
  await expect(net.fetch("https://files.example.com/to-metadata")).rejects.toThrow(/not a public address/);
  await expect(net.fetch("https://files.example.com/to-http")).rejects.toThrow(/not plain HTTPS/);
  await expect(net.fetch("https://files.example.com/loop")).rejects.toThrow(/too many redirects/);
  expect(net.requests.map((r) => r.url)).not.toContain("https://internal.example.com/admin");
});

// The real client must connect to the validated address, not look the hostname up again (a second
// lookup could answer with an internal address). `.invalid` never resolves, so reaching the local
// listener proves the pinned address was used.
test("the HTTPS client connects only to the given address, without its own lookup", async () => {
  const server = createServer((socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connected = once(server, "connection");
  try {
    const { port } = server.address() as AddressInfo;
    const got = httpsGet(new URL(`https://never-resolves.invalid:${port}/`), {
      signal: AbortSignal.timeout(5000),
      addresses: [{ address: "127.0.0.1", family: 4 }],
    });
    await connected;
    await expect(got).rejects.toThrow();
  } finally {
    server.close();
  }
});

// By default a link goes through `fetchPublic`, and a refusal is skipped with a note like any other
// failed download, never fatal.
test("an attachment link to a non-public address is skipped with a note", async () => {
  const url = "https://169.254.169.254/latest/meta-data/iam/security-credentials/";
  const conversation: Conversation = {
    issue: {
      id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo",
      stateType: "unstarted", delegate: null, linkedPullRequests: [],
      attachments: [{ id: "a1", title: "creds", source: "url", url, updatedAt: "2026-10-02T06:00:00.000Z" }],
    },
    humanComments: [],
    agentComments: [],
  };
  const got = await reasoningFiles(conversation, {});
  expect(got.files).toEqual([]);
  expect(got.skipped).toEqual([{ url, title: "creds", reason: "download failed: refused: 169.254.169.254 is not a public address (169.254.169.254)" }]);
});

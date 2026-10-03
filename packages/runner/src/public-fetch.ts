import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/** Fetches a generic link attachment; redirects are followed only to public HTTPS addresses (TECH-5036). */
export type FetchLink = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type Address = { address: string; family: number };
/** Resolves a hostname to every address it has. */
export type Resolve = (hostname: string) => Promise<Address[]>;
/** One HTTPS request, connecting only to `addresses` and never following a redirect. */
export type Get = (url: URL, init: { signal: AbortSignal; addresses: Address[] }) => Promise<Response>;

const MAX_REDIRECTS = 5;

// Not public: this network, private, CGNAT, loopback, link-local (cloud metadata), protocol
// assignments, documentation, benchmarking, 6to4 relay, multicast, reserved and broadcast.
const nonPublicV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicV4.addSubnet(net, prefix, "ipv4");

// IPv6 is public only inside global unicast (2000::/3), which leaves out unspecified, loopback,
// IPv4-mapped and NAT64 forms, ULA (fd00:ec2::254), link-local and multicast; then minus the
// special-purpose, 6to4 and documentation blocks within it.
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
for (const [net, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) nonPublicV6.addSubnet(net, prefix, "ipv6");

/** Whether `ip` is a public unicast address a link may point at. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !nonPublicV4.check(ip, "ipv4");
  if (family === 6) return globalUnicast.check(ip, "ipv6") && !nonPublicV6.check(ip, "ipv6");
  return false;
}

/**
 * GETs a plain HTTPS link, refusing any hop whose host is or resolves to a non-public address, so a
 * link can't reach the host's internal services or cloud metadata. Each hop connects to the
 * addresses it validated, never a second lookup's. Throws on a refusal, like any failed download.
 */
export async function fetchPublic(
  url: string,
  init: { signal: AbortSignal; resolve?: Resolve; get?: Get },
): Promise<Response> {
  const resolve = init.resolve ?? ((host) => dnsLookup(host, { all: true }));
  const get = init.get ?? httpsGet;
  let next = new URL(url);
  for (let hop = 0; ; hop++) {
    if (next.protocol !== "https:" || next.username || next.password) throw new Error("redirected to a link that is not plain HTTPS");
    const host = next.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
    if (addresses.length === 0) throw new Error(`${host} has no address`);
    const refused = addresses.find((a) => !isPublicAddress(a.address));
    if (refused) throw new Error(`refused: ${host} is not a public address (${refused.address})`);
    const res = await get(next, { signal: init.signal, addresses });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    next = new URL(location, next);
  }
}

/** The real `Get`: node's HTTPS client, whose lookup answers with the validated addresses only. */
export const httpsGet: Get = (url, { signal, addresses }) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        lookup: (_host, opts, cb) =>
          opts.all ? cb(null, addresses) : cb(null, addresses[0]!.address, addresses[0]!.family),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const value of [v ?? []].flat()) headers.append(k, value);
        const status = res.statusCode ?? 502;
        const empty = [204, 205, 304].includes(status);
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });

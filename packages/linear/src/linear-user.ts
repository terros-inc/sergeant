import { z } from "zod";

const callerQuery = `
  query SergeantCaller {
    viewer { id name email active organization { id } teams(first: 250) { nodes { key } } }
  }
`;
const callerData = z.object({
  viewer: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    active: z.boolean(),
    organization: z.object({ id: z.string().min(1) }),
    teams: z.object({ nodes: z.array(z.object({ key: z.string() })) }),
  }),
});

export type LinearUser = { id: string; name: string; email: string; active: boolean; organizationId: string; teamKeys: string[] };

/**
 * The Linear user a human's own OAuth access token (`sgt login`) acts as, read with that token;
 * `undefined` when Linear does not accept the token. Throws when Linear cannot answer.
 */
export async function linearUser(accessToken: string, options: { apiUrl?: string; fetch?: typeof globalThis.fetch } = {}): Promise<LinearUser | undefined> {
  const res = await (options.fetch ?? globalThis.fetch)(options.apiUrl ?? "https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: callerQuery }),
  });
  if (res.status === 401) return undefined;
  const body = z
    .object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string(), extensions: z.object({ code: z.string().optional() }).optional() })).optional() })
    .safeParse(await res.json().catch(() => undefined));
  // Linear answers an unknown, expired, or revoked token with an authentication error.
  if (body.success && body.data.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR")) return undefined;
  if (!res.ok || !body.success || body.data.errors?.length) throw new Error(`Linear API request failed (${res.status})`);
  const { viewer } = callerData.parse(body.data.data);
  return { id: viewer.id, name: viewer.name, email: viewer.email, active: viewer.active, organizationId: viewer.organization.id, teamKeys: viewer.teams.nodes.map((t) => t.key) };
}

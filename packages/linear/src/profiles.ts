import type { LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { actor } from "./queries.ts";
import type { FollowupDeps } from "./followup.ts";

// Linear filters users by no profile URL, so the active ones are paged and matched on it.
const usersPageQuery = `query SergeantUsersPage($after: String) { users(first: 250, after: $after) { nodes { id name url } pageInfo { hasNextPage endCursor } } }`;
const usersPage = z.object({
  users: z.object({ nodes: z.array(actor.extend({ url: z.string() })), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }),
});

/** The adapter's `userByProfile` (TECH-6625): whose profile a `linear.reviewerProfiles` URL is. */
export function profileLookup({ request }: Pick<FollowupDeps, "request">): NonNullable<LinearPort["userByProfile"]> {
  return async (profileUrl) => {
    const wanted = profileUrl.toLowerCase();
    let after: string | null = null;
    do {
      const { users }: z.infer<typeof usersPage> = await request(usersPageQuery, { after }, usersPage);
      const user = users.nodes.find((u) => u.url.toLowerCase() === wanted);
      if (user) return { id: user.id, name: user.name };
      after = users.pageInfo.hasNextPage ? users.pageInfo.endCursor : null;
    } while (after);
    return undefined;
  };
}

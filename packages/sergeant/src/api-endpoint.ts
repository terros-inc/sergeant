// TECH-6208: the endpoint an API call is counted under, so an operator sees which calls spend the
// budget: the method and route template of a GitHub REST call (`GET /repos/{o}/{r}/pulls/{n}/reviews`),
// or the GraphQL operation (`query SergeantIssue`, or `mutation markPullRequestReadyForReview` for an
// unnamed one, by its first field). Ids, numbers, shas, branches, and refs never become an endpoint of
// their own, and the query string is dropped.

/** The endpoint `url` with `init` is counted under. */
export function endpointOf(url: URL, init: RequestInit | undefined): string {
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname.endsWith("/graphql")) return operation(init?.body);
  return `${method} ${routeTemplate(url.pathname)}`;
}

/** `/repos/acme/app/pulls/7/reviews` → `/repos/{o}/{r}/pulls/{n}/reviews`. */
export function routeTemplate(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const before = segments[i - 1];
    if (before === "repos" && i === 1) {
      out.push("{o}", "{r}");
      i++;
    } else if (before === "heads" || before === "tags") {
      // A ref's name may hold slashes of its own: it ends the path.
      out.push("{ref}");
      break;
    } else if (before === "branches") out.push("{branch}");
    else if (before === "commits") out.push("{sha}");
    else if (before === "users" || before === "orgs") out.push("{login}");
    else if (/^\d+$/.test(segment)) out.push("{n}");
    else if (/^[a-z][a-z_-]*$/.test(segment)) out.push(segment);
    else out.push("{id}");
  }
  return `/${out.join("/")}`;
}

/** The GraphQL operation a request body names: `query Name`, else `query firstField`. */
function operation(body: RequestInit["body"]): string {
  let query: unknown;
  try {
    query = typeof body === "string" ? (JSON.parse(body) as { query?: unknown }).query : undefined;
  } catch {
    query = undefined;
  }
  if (typeof query !== "string") return "graphql";
  const named = /^\s*(query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(query);
  if (named) return `${named[1]} ${named[2]}`;
  const unnamed = /^\s*(query|mutation|subscription)?\s*(?:\([^)]*\))?\s*\{\s*([A-Za-z_]\w*)/.exec(query);
  return unnamed ? `${unnamed[1] ?? "query"} ${unnamed[2]}` : "graphql";
}

import type { IncomingMessage } from "node:http";
import { AddRepositoryRequest, RemoveRepositoryRequest, type RepositoryChange, type RepositoryList } from "@terros/sergeant-contracts";
import { body, notFound, ok, parse, Refusal, type Reply } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";
import { EnrollmentRefused, type Enrollment } from "./enrollment.ts";

// `/v1/repositories` (TECH-5193): the enrolled repositories, which every signed-in user may list, and an
// approver's change to them (enrollment.ts), with no AWS session.
//
//   GET  /v1/repositories
//   POST /v1/repositories/add      { "repo": "owner/name", "mergeMethod"?: "squash" | "merge" | "rebase", "mergePolicy"?: "sergeant" | "human" }
//   POST /v1/repositories/remove   { "repo": "owner/name" }

export async function repositoriesRoute(
  enrollment: Enrollment | undefined,
  caller: Caller,
  req: IncomingMessage,
  at: { id: string | undefined; verb: string | undefined; pathname: string },
): Promise<Reply> {
  if (!enrollment) throw new Refusal(404, "not_found", "this Sergeant lists no enrolled repositories");
  if (at.id === undefined && req.method === "GET") return ok({ repositories: enrollment.list() } satisfies RepositoryList);
  if (at.verb !== undefined || req.method !== "POST" || (at.id !== "add" && at.id !== "remove")) throw notFound(at.pathname);
  if (!caller.approver) throw new Refusal(403, "forbidden", "only an approver, or an operator on the Sergeant host, enrolls or removes a repository");
  const by = callerName(caller);
  const request = await body(req);
  let change: Promise<RepositoryChange>;
  if (at.id === "add") {
    const { repo, mergeMethod, mergePolicy } = parse(AddRepositoryRequest, request);
    change = enrollment.add(repo, mergeMethod, mergePolicy, by);
  } else {
    change = enrollment.remove(parse(RemoveRepositoryRequest, request).repo, by);
  }
  return ok(
    await change.catch((e: Error) => {
      throw e instanceof EnrollmentRefused ? new Refusal(400, "bad_request", e.message) : new Refusal(503, "unavailable", e.message);
    }),
  );
}

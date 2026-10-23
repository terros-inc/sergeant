import type { IncomingMessage } from "node:http";
import { AddRepositoryRequest, RemoveRepositoryRequest, RepositoryAuditRateRequest, type RepositoryAuditRateChange, RepositoryBudgetRequest, type RepositoryBudgetChange, type RepositoryChange, type RepositoryList } from "@terros/sergeant-contracts";
import { body, notFound, ok, parse, Refusal, type Reply } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";
import { EnrollmentRefused, type Enrollment } from "./enrollment.ts";

// `/v1/repositories` (TECH-5193): the enrolled repositories, which every signed-in user may list, and an
// approver's change to them (enrollment.ts), with no AWS session.
//
//   GET  /v1/repositories
//   POST /v1/repositories/add      { "repo": "owner/name", "mergeMethod"?, "mergePolicy"?, "workerProfile"?: "base" | "android" }
//   POST /v1/repositories/remove   { "repo": "owner/name" }
//   POST /v1/repositories/budget   { "repo": "owner/name", "wallMinutes"?: number | "default", "costUsd"?: number | "default" }   TECH-6606
//   POST /v1/repositories/audit-rate   { "repo": "owner/name", "mergedAuditSampleRate": 0..1 }   TECH-6617

export async function repositoriesRoute(
  enrollment: Enrollment | undefined,
  caller: Caller,
  req: IncomingMessage,
  at: { id: string | undefined; verb: string | undefined; pathname: string },
): Promise<Reply> {
  if (!enrollment) throw new Refusal(404, "not_found", "this Sergeant lists no enrolled repositories");
  if (at.id === undefined && req.method === "GET") return ok({ repositories: enrollment.list() } satisfies RepositoryList);
  if (at.verb !== undefined || req.method !== "POST" || !["add", "remove", "budget", "audit-rate"].includes(at.id ?? "")) throw notFound(at.pathname);
  if (!caller.approver) throw new Refusal(403, "forbidden", "only an approver, or an operator on the Sergeant host, enrolls or removes a repository or sets its budget or audit rate");
  const by = callerName(caller);
  const request = await body(req);
  let change: Promise<RepositoryChange | RepositoryBudgetChange | RepositoryAuditRateChange>;
  if (at.id === "audit-rate") {
    change = enrollment.setAuditRate(parse(RepositoryAuditRateRequest, request), by);
  } else if (at.id === "budget") {
    change = enrollment.setBudget(parse(RepositoryBudgetRequest, request), by);
  } else if (at.id === "add") {
    const { repo, mergeMethod, mergePolicy, workerProfile } = parse(AddRepositoryRequest, request);
    change = enrollment.add(repo, mergeMethod, mergePolicy, workerProfile, by);
  } else {
    change = enrollment.remove(parse(RemoveRepositoryRequest, request).repo, by);
  }
  return ok(
    await change.catch((e: Error) => {
      throw e instanceof EnrollmentRefused ? new Refusal(400, "bad_request", e.message) : new Refusal(503, "unavailable", e.message);
    }),
  );
}

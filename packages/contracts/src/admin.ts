import { z } from "zod";
import { GitHubRateLimit } from "./github.ts";

// `/v1/admin` (TECH-5195): an approver restarts or updates the Sergeant host through `sgt admin`, with no
// AWS access. `serve` never runs a privileged command: it leaves one validated request where the host's
// automatic-update service picks it up (deploy/host/sergeant-autoupdate.sh), which runs the same
// `sergeant-update` an automatic update does and writes the outcome back for `GET /v1/admin/status`.
//
//   GET  /v1/admin/status
//   POST /v1/admin/restart   {}
//   POST /v1/admin/update    { "ref"?: "<branch, tag, or commit on main>" }

/** A git ref the host may be moved to; the host checks it again, and that its commit is on main and green. */
export const AdminRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, "expected a branch, tag, or commit sha")
  .refine((ref) => !ref.includes(".."), "expected a branch, tag, or commit sha");

export const AdminUpdateRequest = z.strictObject({
  /** Omitted: the newest green main commit the installation's release channel would choose (`main` when it has none). */
  ref: AdminRef.optional(),
});

/** What `serve` hands the host: one at a time, named so `sgt` can wait for its outcome. */
export const AdminRequest = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  action: z.enum(["restart", "update"]),
  ref: AdminRef.optional(),
  /** Who asked, as logs and the outcome name them. */
  by: z.string(),
  at: z.string(),
});
export type AdminRequest = z.infer<typeof AdminRequest>;

/**
 * The host's latest restart or update, an approver's or an automatic one, as the host's update service
 * writes it. `unchanged`: nothing needed doing (already there, or no green commit to move to).
 */
export const AdminResult = z.object({
  /** The request's id; absent for an automatic update. */
  id: z.string().optional(),
  action: z.enum(["restart", "update", "automatic"]),
  ref: z.string().optional(),
  by: z.string(),
  outcome: z.enum(["running", "succeeded", "failed", "unchanged"]),
  message: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** The release's commit once it finished. */
  sha: z.string().optional(),
  /** The update's last lines of output, when it failed. */
  output: z.string().optional(),
});
export type AdminResult = z.infer<typeof AdminResult>;

export const AdminStatus = z.object({
  /** This `serve` process: its version and when it started, which is when the host last restarted it. */
  serve: z.object({ version: z.string(), startedAt: z.string() }),
  /** What `sergeant-update` last checked out (`/etc/sergeant/release`), or null when it cannot be read. */
  release: z.object({ ref: z.string(), sha: z.string(), at: z.string() }).nullable(),
  /** A request the host has not taken yet. */
  pending: AdminRequest.nullable(),
  last: AdminResult.nullable(),
  /**
   * The installation-config SSM parameter's version this `serve` has (TECH-5205): the one it started with,
   * moved on by its own `sgt admin repo` changes, which it takes in place. `current`: the parameter's
   * version now, null when serve cannot read it. Different, the parameter changed since serve started
   * and only a restart rereads it. Null when serve runs without the parameter, and absent from a serve
   * older than TECH-5205, which a newer `sgt` reads as null (TECH-5209).
   */
  config: z.object({ loaded: z.number().int(), current: z.number().int().nullable() }).nullable().default(null),
  /**
   * The runs directory (TECH-5229): its run directories, the bytes they take on disk, and the space on
   * the data volume it is on. Null when serve cannot read it, and absent from a serve older than TECH-5229.
   */
  runs: z
    .object({ count: z.number().int(), bytes: z.number(), volumeFreeBytes: z.number(), volumeBytes: z.number() })
    .nullable()
    .default(null),
  /**
   * The control-plane App's GitHub API budget (TECH-5336): what is left, when it resets, and whether
   * Sergeant is pausing GitHub calls for a rate limit. Null before serve's first GitHub response, and
   * absent from a serve older than TECH-5336.
   */
  github: GitHubRateLimit.nullable().default(null),
});
export type AdminStatus = z.infer<typeof AdminStatus>;

/** `last`: the host's outcome when the request was made; any other one but the request's own replaced it. */
export const AdminRequestResponse = z.object({ request: AdminRequest, last: AdminResult.nullable() });
export type AdminRequestResponse = z.infer<typeof AdminRequestResponse>;

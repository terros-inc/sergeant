import type { RunGitHubTokens, RunSpec } from "@terros/sergeant-contracts";
import type { AttachmentLimits, FetchUpload } from "./attachments.ts";
import type { Adapter } from "./agents.ts";
import type { Exec } from "./exec.ts";
import type { FetchLink } from "./public-fetch.ts";

export type Role = RunSpec["role"];
export type Limits = { maxWallSeconds: number; maxCostUsd: number };

export type ContainerRunnerOptions = {
  /** Host directory holding one directory per run: its workspace, metadata, and final record. */
  rootDir: string;
  /** Built from `container/Dockerfile`. */
  image?: string;
  /** The model per role, for that role's adapter; each run is a new agent session in a new container. */
  models: Record<Role, string>;
  /** The agent CLI per role (TECH-5009). A role not named here runs Claude Code. */
  adapters?: Partial<Record<Role, Adapter>>;
  /** The Sergeant Claude worker token, passed only as `CLAUDE_CODE_OAUTH_TOKEN`. */
  claudeOAuthToken: string;
  /** The installation's Codex credential, passed only to Codex containers. */
  codexCredential?: string;
  /** Mints a GitHub token scoped to a run's repositories and access level. */
  githubTokens: RunGitHubTokens;
  /** The human identity enforced for worker commits. */
  gitIdentity: { name: string; email: string };
  limits?: Partial<Record<Role, Limits>>;
  /** Host command runner; injected in tests so no real process is launched. */
  exec?: Exec;
  githubApiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Downloads Linear uploads on the host; the token never reaches the run. */
  fetchUpload?: FetchUpload;
  /** Downloads a generic link attachment; defaults to `fetchPublic`. */
  fetchLink?: FetchLink;
  attachmentLimits?: AttachmentLimits;
};

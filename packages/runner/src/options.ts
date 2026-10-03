import type { RunGitHubTokens, RunSpec } from "@terros/sergeant-contracts";
import type { AttachmentLimits, FetchUpload } from "./attachments.ts";
import type { Adapter } from "./agents.ts";
import type { Exec } from "./exec.ts";
import type { ReadQuota } from "./quota.ts";
import type { FetchLink } from "./public-fetch.ts";

export type Role = RunSpec["role"];
export type Limits = { maxWallSeconds: number; maxCostUsd: number };

export type ContainerRunnerOptions = {
  /** Host directory holding one directory per run: its workspace, metadata, and final record. */
  rootDir: string;
  /** Built from `container/Dockerfile`. */
  image?: string;
  /** The model each role runs on each adapter; each run is a new agent session in a new container. */
  models: Record<Role, Record<Adapter, string>>;
  /**
   * The agent CLI per role (TECH-5009). A role not named here runs Claude Code. With `quota`, this is
   * the fallback when a provider's quota is unknown.
   */
  adapters?: Partial<Record<Role, Adapter>>;
  /**
   * Live quota per provider (TECH-5117). With it and the Codex credential, each launch picks its
   * provider from quota read just before it (`choose.ts`) and records the readings on the run.
   */
  quota?: ReadQuota;
  /**
   * The Sergeant Claude worker token. It enters every Claude Code container, always and only as
   * `CLAUDE_CODE_OAUTH_TOKEN`. There is deliberately no generic environment input.
   */
  claudeOAuthToken: string;
  /**
   * The installation's Codex credential (`auth.json` JSON or an OpenAI API key), required when a role
   * runs `codex-local`. It enters only Codex containers, only as `CODEX_CREDENTIAL`.
   */
  codexCredential?: string;
  /**
   * Mints each run's GitHub token from the worker App, scoped to the run's repositories. A worker's
   * write token is its only GitHub credential and enters its container as `GH_TOKEN`; a reviewer's
   * read-only token is used on the host to check out the PR and never enters its container.
   */
  githubTokens: RunGitHubTokens;
  /**
   * Who a worker's commits are authored and committed as: the installation's human identity, never
   * an agent's. Set through git's environment, which overrides any `user.*` config a run sets.
   */
  gitIdentity: { name: string; email: string };
  limits?: Partial<Record<Role, Limits>>;
  /** Host command runner; injected in tests so no real process is launched. */
  exec?: Exec;
  githubApiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Downloads Linear uploads with the installation's Linear token, here on the host. The files reach
   * a run read-only under `.sergeant/attachments/`; the token never does (TECH-4994).
   */
  fetchUpload?: FetchUpload;
  /** Downloads a generic link attachment; defaults to `fetchPublic`. Injected in tests. */
  fetchLink?: FetchLink;
  attachmentLimits?: AttachmentLimits;
};

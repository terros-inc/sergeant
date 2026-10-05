import type { RunGitHubTokens, RunSpec } from "@terros/sergeant-contracts";
import type { AttachmentLimits, FetchUpload } from "./attachments.ts";
import type { Adapter } from "./agents.ts";
import type { CodexPrice } from "./codex-prices.ts";
import type { Exec } from "./exec.ts";
import type { ModelAccount } from "./accounts.ts";
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
   * The agent CLI per role (TECH-5009): the provider whose account runs first when no account's quota
   * can be read. A role not named here prefers Claude Code.
   */
  adapters?: Partial<Record<Role, Adapter>>;
  /**
   * Live quota per model account (TECH-5117). With it, each launch picks among the task owner's
   * accounts from quota read just before it (`accounts.ts`, `choose.ts`) and records the readings.
   */
  quota?: ReadQuota;
  /**
   * The model accounts a person registered (TECH-5179), read at each launch for the task owner's Linear
   * user id: the only accounts that person's tasks may run on. A Claude account's credential enters
   * only that run's Claude Code container, as `CLAUDE_CODE_OAUTH_TOKEN`; a Codex account's, only its
   * Codex container, as `CODEX_CREDENTIAL`. There is deliberately no generic environment input. A
   * failed read throws, and the start fails: an unreadable list is never taken as an empty one.
   */
  accounts: (ownerId: string) => Promise<ModelAccount[]>;
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
  /**
   * Codex list prices by model, over `CODEX_PRICES` (TECH-5021): a Codex run on a priced model records
   * an estimated cost from its tokens; one on any other model keeps its cost unknown.
   */
  codexPrices?: Record<string, CodexPrice>;
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

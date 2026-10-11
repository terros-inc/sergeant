import type { PullRequestFacts } from "./github.ts";

// TECH-5797: these files define CI execution, including code that can consume job tokens, secrets, or
// declared permissions. A PR changing one is always handed to a human, whatever the repository's
// mergePolicy, and needs an independent review of its exact head first (M15). The Gate, execute, and
// the GitHub adapter's merge call all read this one list.
const PROTECTED_CI_PATHS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.gitlab-ci\.ya?ml$/,
  /(^|\/)Jenkinsfile$/,
];

/** Stands for a PR whose changed files were never read: it counts as changing protected CI. */
export const UNKNOWN_CHANGED_FILES = "(changed files unknown)";

/** The protected CI files a PR changes; fails closed, as one file `UNKNOWN_CHANGED_FILES`, when its file list is unknown. */
export const protectedCiFiles = (pr: Pick<PullRequestFacts, "changedFiles">): string[] =>
  pr.changedFiles ? pr.changedFiles.filter((path) => PROTECTED_CI_PATHS.some((pattern) => pattern.test(path))) : [UNKNOWN_CHANGED_FILES];

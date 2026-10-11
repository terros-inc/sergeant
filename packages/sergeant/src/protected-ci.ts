import type { PullRequestFacts } from "@terros/sergeant-contracts";

// These files define CI execution, including code that can consume job tokens, secrets, or declared
// permissions. A matching PR is always handed to a human, independently of repository mergePolicy.
const PROTECTED_CI_PATHS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.gitlab-ci\.ya?ml$/,
  /(^|\/)Jenkinsfile$/,
];

export const protectedCiFiles = (pr: Pick<PullRequestFacts, "changedFiles">): string[] =>
  (pr.changedFiles ?? []).filter((path) => PROTECTED_CI_PATHS.some((pattern) => pattern.test(path)));

import { expect, test } from "vitest";
import type { HumanPullRequestFeedback, PullRequestFacts, RunSpec } from "@terros/sergeant-contracts";
import { reviewerBrief, type ReviewSubject } from "./brief.ts";

// TECH-4990: a fresh reviewer must see the humans' feedback on the PRs it reviews, or it can approve
// a head that ignores a human's requested change (Gate M8 would then hold the merge, but only after
// a wasted review, and only for a review state, never an inline or plain comment).

const head = "b".repeat(40);
const subject: ReviewSubject = {
  repo: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  baseRef: "main",
  headSha: head,
  title: "Add it",
  body: "Fixes UNF-1",
  path: "/workspace/o/r-pr7",
};
const pr: PullRequestFacts = {
  repo: "o/r",
  number: 7,
  url: subject.url,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: subject.body,
  mergeable: true,
  checks: { sha: head, required: [] },
  humanFeedback: [],
};

const feedback = (f: Partial<HumanPullRequestFeedback> & Pick<HumanPullRequestFeedback, "id" | "kind">): HumanPullRequestFeedback => ({
  author: "ada",
  state: null,
  body: "",
  path: null,
  line: null,
  commitId: null,
  createdAt: "2026-10-03T02:00:00Z",
  updatedAt: "2026-10-03T02:00:00Z",
  url: `${subject.url}#${f.id}`,
  ...f,
});

const spec = (pullRequests: PullRequestFacts[]): Extract<RunSpec, { role: "reviewer" }> => ({
  runId: "run_r1",
  owner: { id: "ann", name: "Ann" },
  role: "reviewer",
  repositories: ["o/r"],
  subject: [{ repo: "o/r", number: 7, headSha: head }],
  pullRequests,
  conversation: {
    issue: {
      id: "i1",
      identifier: "UNF-1",
      url: "https://linear.app/x/issue/UNF-1",
      title: "T",
      description: "D",
      state: "In Progress",
      stateType: "started",
      delegate: null,
      linkedPullRequests: [],
    },
    humanComments: [],
    agentComments: [],
  },
});

test("the reviewer brief lists each human review and comment and asks the reviewer to confirm it was addressed", () => {
  const human = [
    feedback({ id: "review:1", kind: "review", state: "CHANGES_REQUESTED", commitId: "a".repeat(40), body: "Please split this up." }),
    feedback({ id: "review_comment:2", kind: "review_comment", path: "src/x.ts", line: 42, commitId: "a".repeat(40), body: "Off by one here." }),
    feedback({ id: "comment:3", kind: "comment", author: "grace", body: "Also update the docs." }),
  ];
  const brief = reviewerBrief(spec([{ ...pr, humanFeedback: human }]), [subject], []);

  const section = brief.slice(brief.indexOf("## Human reviews and comments on these PRs"), brief.indexOf("## Environment"));
  expect(section).toMatch(/report each request it does not address as a\nblocking finding/);
  expect(section).toContain(`- ${subject.url}, oldest first:`);
  // Author, review state, file:line, and body for each, in order.
  const items = section.split("\n").filter((l) => l.startsWith("    - "));
  expect(items).toEqual([
    `    - ada — review, CHANGES_REQUESTED at \`aaaaaaaaaaaa\` — 2026-10-03T02:00:00Z — ${subject.url}#review:1`,
    `    - ada — inline comment on \`src/x.ts:42\` — 2026-10-03T02:00:00Z — ${subject.url}#review_comment:2`,
    `    - grace — comment — 2026-10-03T02:00:00Z — ${subject.url}#comment:3`,
  ]);
  for (const body of ["Please split this up.", "Off by one here.", "Also update the docs."]) expect(section).toContain(`      > ${body}`);
});

test("a reviewer brief for PRs without human feedback has no human-feedback section", () => {
  const brief = reviewerBrief(spec([pr]), [subject], []);
  expect(brief).not.toContain("Human reviews and comments");
  // The sections around it still join cleanly.
  expect(brief).toContain("Fixes UNF-1\n\n## Environment");
});

test("the reviewer brief distinguishes acceptance findings from ordinary defects", () => {
  const brief = reviewerBrief(spec([pr]), [subject], []);
  expect(brief).toContain('blocking finding with `category: "acceptance"`');
  expect(brief).toContain("Omit `category` from ordinary implementation defects.");
});

import { expect, test } from "vitest";
import type { HumanPullRequestFeedback, PullRequestFacts, RunSpec } from "@terros/sergeant-contracts";
import { reviewerBrief, type ReviewSubject, workerBrief } from "./brief.ts";

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
  mergeable: true, mergeableState: "clean",
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

// TECH-5191: after a handoff or a reopen, earlier work exists that Sergeant's own records may not
// carry. A worker has no Linear access, so the PRs Linear links to the issue reach it only here.
test("the worker brief has the worker find and continue existing work, and lists the issue's linked PRs", () => {
  const base = spec([]);
  const conversation = {
    ...base.conversation,
    issue: { ...base.conversation.issue, linkedPullRequests: [{ repo: "o/r", number: 3 }, { repo: "o/other", number: 9 }] },
  };
  const brief = workerBrief(
    { ...base, role: "worker", objective: "Continue it.", context: { pullRequests: [], runs: [] }, conversation },
    ["o/r: sergeant/unf-1-first-try"],
  );

  expect(brief).toContain(
    "- Pull requests Linear links to this issue:\n  - https://github.com/o/r/pull/3\n  - https://github.com/o/other/pull/9\n",
  );
  const rule = brief.slice(brief.indexOf("3. Before you change anything"), brief.indexOf("\n4. "));
  expect(rule).toContain('`gh pr list --state all --search "UNF-1"`');
  expect(rule).toMatch(/whether earlier\s+feedback was addressed/);
  expect(rule).toMatch(/replacement only for a concrete reason/);
  expect(rule).toMatch(/rather\s+than assuming you start from scratch/);
  // Without linked PRs the list still renders, as "(none)".
  expect(workerBrief({ ...base, role: "worker", objective: "o", context: { pullRequests: [], runs: [] } }, [])).toContain(
    "- Pull requests Linear links to this issue:\n  - (none)\n",
  );
});

// TECH-5167: a PR must not shield its own new design-doc entry from review by calling it settled.
test("reviewer rule 12 counts a trade-off as settled only on the base branch or by a cited owner decision", () => {
  const brief = reviewerBrief(spec([pr]), [subject], []);
  expect(brief).toContain("## Rules (s2-reviewer-rules/7)");
  const rule = brief.slice(brief.indexOf("12. "), brief.indexOf("\n13. "));
  expect(rule).toMatch(/Settled means recorded on the base branch or by an owner decision the issue cites\./);
  expect(rule).toMatch(/A settlement\s+the change itself introduces, such as a new entry under `docs\/design` in this diff, is under\s+review/);
});

// TECH-5278: parallel tasks kept colliding on a moved main and on the same hot files. Every worker
// rebases early and often and may stack PRs; workers and reviewers report the dependencies they see,
// so Sergeant records them as "blocked by" and intake waits.
test("worker and reviewer briefs carry the rebase rule and ask for dependencies in the report", () => {
  const base = spec([]);
  const worker = workerBrief({ ...base, role: "worker", objective: "o", context: { pullRequests: [], runs: [] } }, []);
  expect(worker).toContain("## Rules (s2-worker-rules/9)");
  const rebase = worker.slice(worker.indexOf("14. Rebase early and often."), worker.indexOf("\n15. "));
  expect(rebase).toMatch(/before its first push, before you report a head for\s+review, and whenever the default branch has moved under its open PR/);
  expect(rebase).toMatch(/Resolve conflicts then, as\s+part of the task/);
  expect(rebase).toMatch(/Stacking is allowed/);
  expect(rebase).toMatch(/Once that base merges, retarget your PR to the default branch/);

  const reviewer = reviewerBrief(spec([pr]), [subject], []);
  expect(reviewer).toMatch(/13\. The implementer rebases onto the current base before each review round\./);
  expect(reviewer).toMatch(/A stacked PR, based on another PR's branch, is allowed\./);

  for (const brief of [worker, reviewer]) {
    expect(brief).toMatch(/list it in\s+`dependencies` with its\s+identifier and `why`: `blocked_by` when this issue must wait for\s+it, `blocks` when it must\s+wait for this one/);
    const json = brief.slice(brief.indexOf("```\n{"));
    expect(json).toContain('"dependencies": [{ "issue": "<Linear identifier>", "relation": "blocked_by" | "blocks", "why": "<evidence>" }]');
  }
});

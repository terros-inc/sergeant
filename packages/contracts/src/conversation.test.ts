import { expect, test } from "vitest";
import { conversationRevision, type Conversation } from "./conversation.ts";

// M10 is only as good as this hash: if an edit stopped changing it, a merge could overtake a human's
// edited instruction (L4); if read order changed it, every merge would be refused.

const at = "2026-10-02T06:00:00.000Z";
const comment = (id: string, body: string, updatedAt = at) => ({ id, author: { id: "u1", name: "Human" }, createdAt: at, updatedAt, body });
const base: Conversation = {
  issue: {
    id: "i1",
    identifier: "UNF-1",
    url: "https://linear.app/x/issue/UNF-1",
    title: "T",
    description: "D",
    state: "Todo",
    delegate: null,
    linkedPullRequests: [],
  },
  humanComments: [comment("c1", "first"), comment("c2", "second")],
  agentComments: [],
};

test("changes when humans change what was said, and only then", () => {
  const rev = conversationRevision(base);
  expect(conversationRevision({ ...base, humanComments: [...base.humanComments].reverse() })).toBe(rev);
  expect(conversationRevision({ ...base, issue: { ...base.issue, state: "In Progress" } })).toBe(rev);
  // Sergeant's own question must not count as the human reply that ends its wait (UNF-727).
  expect(conversationRevision({ ...base, agentComments: [{ id: "q1", createdAt: at, body: "**Question for you**" }] })).toBe(rev);

  const changed: Conversation[] = [
    { ...base, issue: { ...base.issue, description: "D2" } },
    { ...base, humanComments: [...base.humanComments, comment("c3", "stop")] },
    { ...base, humanComments: [base.humanComments[0]!] },
    { ...base, humanComments: [comment("c1", "first, edited"), comment("c2", "second")] },
    { ...base, humanComments: [comment("c1", "first", "2026-10-02T07:00:00.000Z"), comment("c2", "second")] },
  ];
  for (const c of changed) expect(conversationRevision(c)).not.toBe(rev);
});

// TECH-4987: human feedback on a task PR is human input too. A new review or comment, an edit, or a
// dismissal must change the revision, so it wakes a turn within one poll and denies a merge decided
// without it (M10); a task with none keeps its Linear-only revision.
test("folds human feedback on the task's PRs into the revision", () => {
  const review: { id: string; updatedAt: string; state: string | null; body: string } = { id: "review:1", updatedAt: at, state: "CHANGES_REQUESTED", body: "remove terros-wiki" };
  const withFeedback = (...humanFeedback: (typeof review)[]) => conversationRevision(base, [{ repo: "o/r", number: 7, humanFeedback }]);
  expect(withFeedback()).toBe(conversationRevision(base));

  const rev = withFeedback(review);
  expect(rev).not.toBe(conversationRevision(base));
  const changed = [
    withFeedback(review, { id: "review_comment:2", updatedAt: at, state: null, body: "not here" }),
    withFeedback({ ...review, state: "DISMISSED" }),
    withFeedback({ ...review, body: "remove terros-wiki everywhere" }),
    withFeedback({ ...review, updatedAt: "2026-10-02T07:00:00.000Z" }),
    conversationRevision(base, [{ repo: "o/r", number: 8, humanFeedback: [review] }]),
  ];
  for (const c of changed) expect(c).not.toBe(rev);
});

import { expect, test } from "vitest";
import type { ActionKind } from "./actions.ts";
import { claimsHeldBack } from "./held-back-claim.ts";

// TECH-6711: a question posted while Q1 holds back these actions must not say any of them happened.
const claims: [string, ActionKind[]][] = [
  ["The worker has started.", ["start_worker"]],
  ["A worker is now running on the fix. Which option do you prefer?", ["start_worker"]],
  ["Started a worker to fix it. Should the second finding be fixed too?", ["start_worker"]],
  ["That's a clear bug, so I’ve started a worker to fix it.", ["start_worker"]],
  ["The fix is underway; should it also cover retries?", ["start_worker"]],
  ["The fix is in progress. Which retention period do you want?", ["start_worker"]],
  ["A fix worker has been kicked off.", ["start_worker"]],
  ["I kicked off a reviewer for #7.", ["start_reviewer"]],
  ["The review is running. Is the scope right?", ["start_reviewer"]],
  ["Merged.", ["merge_pr"]],
  ["I'm merging it now.", ["merge_pr"]],
  ["PR #7 is merged and the next step is yours.", ["merge_pr"]],
  ["We merged the PR, so which follow-up do you want first?", ["merge_pr"]],
  ["I filed the follow-up.", ["create_followup"]],
  ["The follow-up is filed. Which team owns it?", ["create_followup"]],
  ["Sergeant updated the description to match your comment.", ["update_description"]],
];

// Questions that ask about, propose or deny an action, or name a different action's state.
const passes: [string, ActionKind[]][] = [
  ["Should I start a worker to fix it?", ["start_worker"]],
  ["Do you want me to merge PR #7 now, or wait for the review?", ["merge_pr"]],
  ["Once you reply, I'll start the fix worker.", ["start_worker"]],
  ["Has the worker started yet?", ["start_worker"]],
  ["Is the review done?", ["start_reviewer"]],
  ["I have not started a worker; which option should it take?", ["start_worker"]],
  ["The worker hasn't started. Which retention period do you want?", ["start_worker"]],
  ["I recommend merging PR #7. Do you agree?", ["merge_pr"]],
  ["The review is done and found two issues. Which should the fix cover?", ["start_worker"]],
  ["The budget is spent. Extend it by $25, or stop here?", ["start_worker", "merge_pr"]],
];

test.each(claims)("a question claiming a held-back action is refused: %s", (question, held) => {
  expect(claimsHeldBack(question, held)).toBe(true);
});

test.each(passes)("a question that only asks, proposes or denies passes: %s", (question, held) => {
  expect(claimsHeldBack(question, held)).toBe(false);
});

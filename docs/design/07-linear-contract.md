# 07 — Linear contract

Linear is the durable brief and the human-visible history. Sergeant leans on it heavily: the issue
says what to do, comments carry questions, answers, and summaries, attachments say which PRs belong
to the issue, relations carry blockers and follow-ups, delegation says who is responsible, and the
Done state (usually set by GitHub automation) says the work landed.

Linear stays **concise and useful to humans**. Detailed briefs, reports, transcripts, and Situation
Reports go to S3; operational logs go to CloudWatch (02 §5). Linear gets summaries and links.

## 1. What Linear owns

| Linear holds | Sergeant's use |
|---|---|
| Issue title, description, acceptance section | the brief, copied verbatim into worker and review briefs |
| Comments (top-level and threads) | human instructions, answers, discussion; Sergeant's concise updates and questions |
| Delegation (`delegate` = Sergeant's app user) | intake: delegated means "Sergeant is responsible" |
| Workflow state | started when work begins; Done/Canceled close the task |
| Relations: blocked by, blocks, related, parent/children | admission waits on blockers; follow-ups are linked |
| Attachments (GitHub PR links) | **which PRs belong to the task** (08 §4) |
| Labels | `sergeant:hold` stops merges and new run starts (§12) |

Sergeant never stores a copy of any of these beyond a display cache of the identifier.

## 2. Identity

Sergeant acts in Linear as its own app user (Linear's agent model: issues are *delegated* to it,
`actor = app`), with the installation's OAuth credential held only in the control-plane zone. Humans
authenticate to `sgt` with their own Linear identity (ADR-0024/0028, kept). Workers have no Linear
access.

## 3. What Sergeant posts

| Moment | Comment | Notes |
|---|---|---|
| First turn, when work starts | 2–5 lines: what Sergeant understood, the plan at outcome level, which repositories | Skipped for trivial tasks where the PR will say everything |
| A question for a human | the question (§4) | the only kind that creates a human wait |
| A genuine blocker Sergeant cannot resolve | what is blocked, what would unblock it | e.g. a required live check no one can run |
| Budget exhausted | the budget ask (§6) | |
| Outcome | 2–6 lines: what landed (PR links), known gaps, follow-ups filed, anything a human should check, and the task's total cost | posted when the work lands or for a non-code outcome; the cost line (TECH-5227, `cost.ts`) is an estimate split by provider, run counts by role, wall time and accounts, a run with no reported cost counted as unknown; Sergeant's own turns count over the whole task (`turns.jsonl`), not only the current budget window |
| After each review round | about 5 lines: what changed (from the worker report), the PR and reviewed head, the verdict with blocking/non-blocking counts and up to two findings, what happens next, the estimated cost so far (worker and review runs by role, and Sergeant's turns, up to the previous turn) | TECH-5227, `progress.ts`; its own comment for every finished review still current, keyed `progress:<issue>:<reviewRunId>`, posted after the next turn even when that turn also asks or merges; `review.progressComments: false` turns it off |
| Answers to human comments | when the comment asked something Sergeant can answer | |
| Post-merge audit findings | one comment listing blocking findings and a report link (06 §8) | guardrail, rare |
| Stopped | two lines when Sergeant stops because of undelegation, cancellation, or `release_task`: why it stopped, listing open PRs, then the task's total cost line | an accept-as-is ending's line gets it too |

Never posted: per-run or per-push updates, CI results, review start notices (a finished round gets
only the progress comment above), raw markers,
internal ids, transcripts. Linear already shows linked PRs and their status in the issue, so
"opened PR #12" comments are not needed.

Comments carry no visible markers. Idempotency uses client-supplied comment ids (02 §6; verified as
`14` V1).

## 4. Questions, answers, and the human wait

**Asking.** `ask_human` posts:

```
**Question for you** — <one-line question>

<why only a human can decide this, in 1–3 sentences>

Options:
1. <option> — <consequence>
2. <option> — <consequence>

Sergeant recommends **1** because <reason>. Reply in your own words; a number is fine.
```

A blocking question becomes the task's `HumanWait` (01): one at a time. Non-blocking questions are
asked the same way but create no wait.

**Answering.** Humans answer however they like: a top-level comment or a thread reply, a number, a
label, a paragraph with the choice on the last line, requested changes plus a choice. Every new or
edited human comment wakes the task. Sergeant reads it in the next turn; when it reads a reply as the
answer, the turn's decision names it (`answeredQuestion`, with its interpretation) and the human wait
clears only then.

**Never silent** (UNF-663, UNF-674, UNF-698). If a reply is ambiguous, Sergeant asks one short
clarifying question and the wait stays open. Sergeant keeps no per-comment record. Instead, every Linear
change wakes a turn that sees every human comment, and merges and completion carry the conversation
revision the proposing turn saw: if a comment or edit arrived since, the Gate refuses and a fresh turn
decides (M10, X5). A human's "stop" therefore can never be overtaken by a merge decided before it
(03 §5).

**Resolving the thread** (TECH-5052). Once Sergeant has acted on an answer (a
turn that names the question it `answered` asked nothing and had every action done), it resolves its
own question's thread with Linear's `commentResolve`, so an open thread only means "still needs a
human". A clarifying question is a reply in the same thread (`followsUp`), which stays open. Never a
human's or another bot's thread; a thread already resolved is left alone; a failure is only logged.

**Reminders.** After `humanWait.remindAfterHours` without an answer, Sergeant is woken to decide
whether to re-ask more simply, mention someone, continue with its recommendation where that is safe
and reversible, or leave it.

**Withdrawal.** If the question stops mattering, Sergeant withdraws it with a one-line note.

**Who may answer.** Any human member of the team (not bots or integrations). Budget extensions and
review waivers need an approver (§6, 06 §6). Firstmate posting through the captain's account counts
as the captain.

## 5. Intake and admission

A guardrail admits an issue when **all** of these hold (deterministic):

1. its delegate is Sergeant's app user;
2. its team is in `linear.allowedTeamIds`;
3. its workflow state type is not completed or canceled;
4. no open task exists for it;
5. every issue it is blocked by is completed or canceled;
6. open tasks < `limits.maxOpenTasks`;
7. the installation is not paused;
8. it has a human assignee, and Linear's issue history shows that same person most recently
   delegated it to Sergeant (TECH-5179), or, when the history shows no delegation because the issue
   was created already delegated, that same person created it (TECH-5192). A delegation or
   creation made through an app counts as that person's only when the app is in
   `linear.delegatingAppIds` (Linear's MCP connector, so the owner's assistant can file work for
   them) and Linear records it acting for a user with the assignee's display name; Linear gives no
   id or email for that user, so no other app is trusted with the name. That person is the task's **owner**, recorded with the task:
   every run of it uses only their registered model accounts (04 §10). Reassigning or unassigning
   the issue while the task runs is a **handoff** (§8): token ownership never moves mid-task, nothing
   resumes on its own, and the new assignee's own delegation starts a new episode (§9), checked
   afresh, with the earlier PRs and branches there to continue. The history is read in
   full on every admission attempt, so a missed webhook or downtime cannot skip the check; anything it
   cannot prove refuses. Each refusal (no human assignee; someone else delegated it; the delegation is
   not attributable) is one comment saying what to do, keyed by what Linear showed, so a poll never
   repeats it. An owner with no usable model account is asked, when a run would start, through the
   ordinary question (§4), so their reply resumes the task in a fresh budget window (TECH-5217).

Issues that fail only (5), (6), or (7) stay queued in Linear and are re-checked on every intake pass,
highest Linear priority first, then oldest delegation. No comment is posted for queueing;
`sgt task list --queued` shows them with the reason.

Delegation arrives by webhook; a reconcile poll (every 2 minutes, and at startup) catches anything
missed (S1 ADR-0040's "nothing missed while down", kept). The same poll recomputes each open task's
conversation revision and wakes the task when it differs from the revision its last completed turn saw,
so a missed comment webhook or a failed turn never leaves human input unread (03 §5).

On admission the task row is created with the default budget and an empty repository set, and the
task is woken with `admitted`. The issue moves to the team's first `started` state when the first
worker starts.

## 6. Budget asks and fresh windows

When the budget is exhausted, Sergeant asks (`ask_human` with `purpose: budget_extension`), or, if it
cannot, a guardrail posts a fixed version:

```
**Budget reached** — about 2h of active work used (about $26 of model spend so far, as reported).

Done: <what landed or is ready>. Remaining: <what is left>. PRs: <links with CI/review state>.
Sergeant recommends **one more window (+2h / +$25)** because <reason>.
Reply to extend, or say stop.
```

A human's answer to any of Sergeant's questions, this one included, gives the task a fresh budget
window (TECH-5059): from the answer, with zero spend and the installation's current budget. So does a
human's review of the task's PR, an approval, a change request, or a review comment, from the review
(TECH-5218). Waiting on a human PR action is a human wait like a question: while the only thing left is
a human's merge of a PR Sergeant said is ready for a human to merge (a required review it cannot give,
such as a code owner's) or a human's re-review it asked for, a window whose wall time runs out asks no
budget question and takes no turn; the review opens a fresh window, and the merge ends the task. An
extension is therefore just an answer; there is no separate grant (this supersedes `grant_budget`,
K1–K4, and `sgt task grant` in 03 §7 and 11). A reply that accepts the work as it is ends the task instead (TECH-5118): reasoning
proposes `accept_as_is`, allowed only after a human replied to the budget question in the current budget window
(TECH-5137: a reply from before a re-trigger never ends the fresh task), and Sergeant asks
nothing more and leaves the PRs and the issue for a human to merge or close, saying so in one comment
keyed by the accepting reply (TECH-5120). It is decided on the live
conversation, so a reply posted while reasoning ran is read by the next turn instead. While the issue
stays delegated and in Todo, intake does not start it afresh; a human moving it out of Todo and back
(or `sgt task wake`) starts a fresh task, as after a stop. A comment alone does not.

**Nothing to change (TECH-5232).** When a worker's own verification shows the issue needs no change,
reasoning proposes `close_issue` instead of asking: `done` when main already covers it, citing the
commit, files, or tests, and `canceled` when it is obsolete, citing what superseded it. Sergeant posts
that evidence as one comment, keyed by the conversation revision it decided on, moves the issue to the team's first completed
or canceled state, and ends the task through the accepted ending above, with no question asked. Gate
rules C1–C4 allow it only while the issue is delegated to Sergeant (A1, A2), with no PR in the task
(linked to the issue or reported by a run), with evidence, after a worker finished its verification
with no run still going, and on the live conversation the turn read. The comment and the close are made
on that same live read, with nothing that waits in between (TECH-5236), so a human comment, an edit, or
a PR linked meanwhile denies the close and the next turn reads it. A human reopens the issue by
moving it back to Todo, which starts a fresh task. Partial coverage or a judgment call still asks.

## 7. Completion: PRs, automation, and Done

In our repositories, merging the PR **is** completing the issue: Linear's GitHub integration moves the
issue to Done when a PR whose description carries a closing reference (`Fixes UNF-123`, the UNF-697
convention) is merged. Sergeant designs around that rather than duplicating it.

**Verified 2026-10-02 (UNF-704).** A sandbox PR in a private
repository carried both
`Fixes UNF-721` and `Part of UNF-722`. Opening it moved both issues from Backlog to In Progress and
created `sourceType=github` attachments: `linkKind=closes` for `Fixes`, and
`linkKind=contributes` for `Part of`. On merge, the `Fixes` issue moved to Done while the `Part of`
issue stayed In Progress; both attachments changed to `status=merged` with the merge timestamp.
The temporary file was removed by
a follow-up PR, and the probe issues were archived. No compensating completion machinery is needed.

- **Single-PR task.** The worker's PR carries `Fixes <IDENTIFIER>`. Sergeant merges it (or a human
  does, where the repository's merge policy is `human`). Automation moves the issue to Done. Intake
  sees the issue closed, a guardrail closes the task as `done`, and Sergeant's outcome comment (if
  any) is the last thing it posts.
- **Multi-PR task.** Only the PR whose merge completes the work carries `Fixes <IDENTIFIER>`; the
  others carry `Part of <IDENTIFIER>`, which links without closing. The worker reports this per PR
  (`closesIssue`), and Sergeant checks it against the PR body before merging (M9, 08 §7). Sergeant
  merges the non-closing PRs first, in the worker's `mergeOrder`, and the closing PR last. Reasoning
  decides whether all required work landed by reading the issue, the reports, and the review verdicts;
  the only deterministic checks are the merge rules.
- **Repository without automation**, or a non-code outcome (an investigation, a decision, "no change
  needed"): Sergeant uses `mark_complete`, which posts the outcome and moves the issue to the team's
  first completed state (X1, X4, X5).
- **Issue marked Done while work remains** (a human closed it, or a closing PR merged early): the
  human's or automation's state wins. A guardrail closes the task as `done`, cancels any active runs,
  and posts one line listing still-open linked PRs, then the task's total cost. Reopening the issue
  starts a new episode (§9).

Whether Linear moves an issue with several closing PRs only after all of them merge does not matter
to this design, because non-final PRs never carry the closing reference.

## 8. Cancellation and undelegation

Handled by guardrails, even while paused, as one closing action whose steps run in order (03 §10):
cancellation is requested for every active run, delegation is removed where applicable, a note is
posted, and the task row closes last, so a crash midway can never let the issue be re-admitted with a
fresh budget.

| Human does | Sergeant does |
|---|---|
| Removes Sergeant as delegate | cancel active runs; close the task `canceled (undelegated)`; one-line note with open PRs |
| Moves the issue to a canceled state | same, `canceled (issue canceled)` |
| Reassigns or unassigns the issue away from the task's owner (TECH-5179) | **handoff**: cancel active runs; keep PRs and branches; once the runs are stopped, reread the issue, move it back to Todo (only from a started state) and remove Sergeant's delegation (unless a newer valid delegation is in place by then); one note linking the open PRs, saying the new assignee may continue personally or delegate it to Sergeant. A task whose work already merged only has its audit stopped, and the issue keeps its status. A task from before TECH-5179 that its owner cannot be proven for is handed off the same way |
| `sgt task cancel UNF-123` | same, plus removes Sergeant's delegation so the issue is not re-admitted |
| Comments "stop" / "pause this" / "never mind" | Sergeant's reasoning interprets it: `release_task`, or cancel the worker and wait |

Open PRs are left open; the note lists them and humans decide. Branches are left in place.

## 9. Reopening and re-delegation

A closed task is never resumed. If the issue is reopened (moved back to a non-completed state while
still delegated) or delegated again, intake admits a **new episode**: a new task row with a fresh
budget. Its first turn sees the whole comment history, earlier PRs (attachments), and Sergeant's own
earlier summaries, and continues from there.

A merged task is seen through once its issue is Done, or Canceled (TECH-5132); in any other state
intake keeps resuming it, so a later move to Done is still seen. A task seen through after its merge
and back in Todo, delegated, is such a reopen (TECH-5182). Intake,
including its periodic poll of Linear, sets the old `state.json` aside as
`state.completed-<time>.json` beside it, and the new episode is admitted like any other: the owner
check (§5) runs again on Linear's latest delegation and fails closed. A task still under way, merged
or not, is never set aside. The post-merge feedback sweep keeps reading the set-aside episodes
(TECH-5190): feedback on a PR merged before an episode was seen through is swept from that episode's
merge on, as before the reopen, whatever the new episode is doing; the issue's comments, and its later
PRs, are the new episode's until it lands.

## 10. Humans editing the issue while work is active

An edit or comment wakes the task; the Situation Report includes a diff of the description and marks new
comments. Sergeant decides:

- a cosmetic edit: nothing;
- a clarification or added requirement: `send_run` to the primary worker with the new text verbatim,
  or, if the worker cannot take messages, a successor with a fresh brief;
- a change to what the issue requires after a review: a new review of the current head against the new
  text, because earlier verdicts were against the old text;
- a change that invalidates the work: cancel the worker, say so in a short comment, and start again.

Before a merge or `mark_complete`, the Gate re-reads the issue and its comments (M10, X5). If the
conversation revision changed after the proposing turn's snapshot, the action is refused and a fresh
turn decides with the new text in front of it. There is no locking: a comment arriving in the
second between that read and GitHub's merge is an accepted race (captain, 2026-10-02).

## 11. Follow-up issues

Only Sergeant creates issues; workers suggest them (`followups[]`). Sergeant creates one only for a
concrete bug, required unfinished work from the task's own scope, a real blocker, or a current
operational or security problem (TECH-5186). There is no per-task quota, but more than one is
exceptional, and each states its category and why (`create_followup.category`, `why`; the issue's
description opens with them). A reviewer's non-blocking notes never become one, nor do theoretical
edge cases, future robustness, generalized cleanup, speculative rollback hazards, or abstraction
improvements: those are feedback.

**Sergeant feedback (TECH-5186).** With the closing PR's merge, reasoning may give up to three short
lines from the workers' `feedback` and non-blocking review notes worth keeping (`merge_pr.feedback`;
for a merge Sergeant did not make, only the closing worker's `feedback`). After the outcome comment,
Sergeant posts them once as a **Sergeant feedback** comment, keyed `feedback:<issue>:<pr>:<mergedSha>`,
and adds the `sergeant-feedback` label (a workspace label, else the team's; a human provisions it and
Sergeant never creates it). Delivery is both: a failed comment or label leaves the feedback unposted
and the task open, and a later pass retries under the same key. A task with nothing worth keeping
gets neither. An issue completed in Linear without a recognized closing merge takes the stop path
(§8); when it is still delegated to Sergeant, the stop's last drive posts the same comment from the
latest worker's `feedback`, keyed `feedback:<issue>:stop:<request>`, and adds the label, before the stop
intent is removed. No custom field or other store: a retro across tasks (TECH-5187) reads these
comments and the label.

**Sergeant retro (TECH-5187).** When about 10 issues got a Sergeant feedback comment since the last
retro, at most 2 weeks after it (if anything new happened), or on a human's `sgt retro`, reasoning on
the control plane reads those comments and the state of every issue the agent created since, checks
the previous retro, and answers with themes, evidence, recommendations, and rarely an issue (high bar,
at most 3). Its issues go to the configured Sergeant project's team, in its first `backlog` state,
unassigned and not delegated, keyed `retro:<window start>:<key>`; the retro is one Linear document in
that project, `Sergeant retro <date>`, keyed `retro:<window start>`. The newest such document is the
last retro: its first line names where its window ended and its "Issues filed" section what it filed.

- Same team, linked to the origin (`related`, or `blocked_by` when it must wait).
- Description: why it exists, what was learned, a link back. Written to stand alone.
- Delegated to Sergeant only when `followups.autoDelegate` is on; otherwise a human starts it.
- In the team's first `backlog` state, never Triage (whose rotation would auto-assign it to whoever is
  on call). Assigned to the origin's assignee unless that is Sergeant, else to the human who delegated
  the origin to Sergeant when Linear's history shows it, else unassigned.
- Limits: no per-task count (TECH-5186); `maxDepth` (F2–F3); deduplicated by Sergeant's semantic key
  (02 §6).

**Feedback after the work landed (TECH-4985).** Once the completing PR merged or the issue is Done,
the task loop takes no more turns, so a human comment on the issue, or a comment or review on its
merged PR from someone with a role in the repository, would otherwise be lost. Sergeant sweeps
recently landed issues, reasoning judges each new piece of feedback, and actionable feedback becomes
one ordinary follow-up under the rule above (Backlog, owner-assigned, not delegated), keyed by the
feedback, with the delta, the feedback verbatim, and links to the issue and the merged PRs. A human
starts it the normal way, by moving it to Todo and delegating it; nothing about it is special after
that. Feedback while the task is active stays part of its conversation (§10) and never files one.

Multi-repository work does not need follow-ups: one worker handles all repositories in the task's set
(S1's UNF-625 machinery is not needed).

## 12. Relations, blockers, and the hold label

- **Blocked at admission**: not admitted until blockers resolve (§5).
- **Blocker added mid-task**: a fact in the Situation Report. Sergeant decides whether to pause the
  worker, continue, or ask.
- **`sergeant:hold` label** on the issue: the Gate refuses `start_worker`, `start_reviewer`, and
  `merge_pr` (G4, M8) until it is removed. Running work continues unless Sergeant cancels it. A cheap
  deterministic brake for humans that does not need a comment.

## 13. Optional: agent activity panel

Linear's agent platform can show an agent's activity (thoughts, actions) on the issue without
comments. If available, Sergeant may publish turn summaries there, keeping comments for §3's moments.
Not required by this design; recorded as `14` V3.

## 14. When Linear is unavailable

- Intake and reconcile retry with backoff.
- A turn whose issue fact is `unavailable` is skipped and retried with backoff: there is no point
  reasoning without the brief.
- Linear effects fail and are retried by the Effector; abandoned ones surface to Sergeant later.
- Runs keep working; GitHub-side facts keep flowing.

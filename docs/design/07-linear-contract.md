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
| Relations: blocked by, blocks, related, parent/children | admission waits on blockers; follow-ups are linked; evident dependencies are recorded as blocked-by (`record_blocked_by`, TECH-5278) |
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
| Budget exhausted | the budget ask (§6): what happened in the window, where the work stands, and the stop rubric's recommendation with its estimated remaining cost | nothing while the task only waits on a human (rubric rule 0) |
| Outcome | 2–6 lines: what landed (PR links), known gaps, each after-deploy check as "not verified (after deploy)" with its follow-up (TECH-6146, a follow-up keyed `after-deploy-…`), other follow-ups filed, anything a human should check, and the task's total cost | posted when the work lands or for a non-code outcome; the cost line (TECH-5227, `cost.ts`) is an estimate split by provider, run counts by role, wall time and accounts, a run with no reported cost counted as unknown; Sergeant's own turns count over the whole task (`turns.jsonl`), not only the current budget window |
| After each review round | about 5 lines: what changed (from the worker report), the PR and reviewed head, the verdict with blocking/non-blocking counts and up to two findings, what happens next, the estimated cost so far (worker and review runs by role, and Sergeant's turns, up to the previous turn) | TECH-5227, `progress.ts`; its own comment for every finished review still current, keyed `progress:<issue>:<reviewRunId>`, posted after the next turn even when that turn also asks or merges; `review.progressComments: false` turns it off |
| A worker took over a PR a human or another agent opened | one line naming the PR and who opened it, and that a human reviews and merges it | TECH-6164, `adopted.ts`; once per PR, keyed `adopted:<issue>:<repo>#<n>`, as soon as a worker's report names an open PR the worker App did not open; such a PR gets no review round (G3), so no progress comment, which is why it is said here |
| Answers to human comments | when the comment asked something Sergeant can answer | |
| Description updated (TECH-6166) | one line: what changed in the description and whose comment asked for it | with `update_description`, a reply in the thread of the human Linear comment that changed the scope, else a comment on the issue (a PR comment); keyed by the issue and the new description |
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
   id or email for that user, so no other app is trusted with the name. **Known issue (TECH-5280):**
   the match relies only on Linear's `botActor.userDisplayName` equalling the assignee's
   `displayName`, so an empty name matches an empty name, and a match overrides a different human
   that Linear reports as the entry's actor. The downside is small and the allowlist bounds it, so
   both are accepted as before but flagged: Sergeant logs a warning and notes it with the owner in
   the task's `state.json`. That person is the task's **owner**, recorded with the task:
   every run of it uses only their registered model accounts (04 §10). Reassigning or unassigning
   the issue while the task runs is a **handoff** (§8): token ownership never moves mid-task, nothing
   resumes on its own, and the new assignee's own delegation starts a new episode (§9), checked
   afresh, with the earlier PRs and branches there to continue. The history is read in
   full on every admission attempt, so a missed webhook or downtime cannot skip the check; anything it
   cannot prove refuses. A running task's poll rereads it after a Linear webhook that may have changed
   the delegation names the issue (a plain comment does not), or at most every ~10 minutes as a fallback,
   avoiding the bulk of a poll's Linear cost (TECH-5923). The proof is kept in the task's `state.json`
   (TECH-5974), so a restart does not redo a still-valid one — the stampede of dozens of loops each rereading
   their full history at once used to trip Linear's rate limit — and rereads that fall due together are
   paced by one service-wide pacer (a few at once, then one every 10 seconds), since loops' polls align on
   the ~15-minute safety-net tick; a burst of delegation webhooks for one task is debounced into one reread.
   The fallback window is the safety net for a missed delegation webhook, and
   every effect that spends the owner's quota or lands their work still rereads it first. Each refusal
   (no human assignee; someone else delegated it; the delegation is
   not attributable) is one comment saying what to do, keyed by what Linear showed, so a poll never
   repeats it. An owner with no usable model account is asked, when a run would start, through the
   ordinary question (§4), so their reply resumes the task in a fresh budget window (TECH-5217).

Issues that fail only (5), (6), or (7) stay queued in Linear and are re-checked on every intake pass,
highest Linear priority first, then oldest delegation. No comment is posted for queueing;
`sgt task list --queued` shows them with the reason.

Delegation arrives by webhook; a reconcile poll (every 2 minutes, and at startup) catches anything
missed (S1 ADR-0040's "nothing missed while down", kept). The same poll recomputes each open task's
conversation revision and wakes the task when it differs from the revision its last completed turn saw,
so a missed comment webhook or a failed turn never leaves human input unread (03 §5). A task whose
loop ended is reread that way only when an event names it or every 15 minutes, whether or not webhooks
deliver (TECH-5942).

On admission the task row is created with the default budget and an empty repository set, and the
task is woken with `admitted`. The issue moves to the team's first `started` state when the first
worker starts.

## 6. Budget asks and fresh windows

When the budget is exhausted, Sergeant asks, and the question makes the case for the human's call
(TECH-6021, `stop-case.ts`, `stop-rubric.ts`). The poll that finds the window exhausted builds it from the
ledger it already has (this window's run records, `turns.jsonl`, the PR facts and the task's report
recoveries); it never starts a worker or reviewer, or asks reasoning, to research the window:

```
**Question for you**

Sergeant stopped this task: its budget is exhausted (<wall time or spend>). Running work was canceled.

**What happened in this window:** <runs in start order, with outcomes, steers, restarts, fix cycles,
human reviews>. <n> Sergeant turns, <n> fix cycles.

**Where it stands:**
- <PR link>: CI <counts by state>; review: <verdict at this head>; mergeable: <state>.
- Open blocking findings: <up to three, with location>.
- Left: <the concrete steps: fixes, rebase, (re-)review, CI, Sergeant's or a human's merge>.
- Spent: $<spent> of $<cap> reported.

**Sergeant recommends extend** (rubric rule 3: a first fix cycle after a reviewer's change request).
Remaining: one fix, a re-review and merge, about 29 min and $5.

Continue?
1. Extend …  2. Accept as-is …
```

The recommendation is the stop rubric of `docs/findings/tech-5922-wall-time-windows.md` §6, its
thresholds as written there, applied in order, the first match deciding:

- **Rule 0, park.** A task only waiting on a human posts nothing. This is the existing human wait, not
  a separate check: an open question holds the task before the budget is read, and a merge handed to a
  human or a re-review Sergeant asked for (TECH-5218), including the TECH-5913 escalation of a green PR
  blocked on a required human review, parks quietly below. A wait uses none of the window (below), so
  only a window the work before the wait used up gets here, and it neither asks nor logs it.
- **Rule 1, recommend stop.** Three or more fix cycles in the window (a worker run after a review that
  requested changes); the same blocking finding back after two fix cycles (the same `location`); two or
  more restarts or steers of one run with no report from any attempt; spend at 80% of the cap with no PR
  ready for review; or a run reporting what it cannot get (unreadable inputs, a decision, a human's
  call), recommended as "stop, or answer this".
- **Rule 2, recommend extend.** Below 80% of the cap, the only thing left is a merge Sergeant may do
  (approved at the head, required CI green, `mergePolicy: sergeant`), a conflict-free rebase of an
  approved PR, or a first review of a finished worker's PR. Automatic extension is not built: these
  still ask, "Sergeant recommends extend", so there is never an automatic extension in a row to limit.
- **Rule 3, ask.** Everything else. It recommends extend for a first fix cycle after a reviewer's change
  request, a run canceled in flight that was not the window's first and is its role's first canceled
  attempt, or an approved PR Sergeant may merge waiting only on CI; otherwise it makes no recommendation.

Every outcome, including rule 1's stop and rule 3's no-recommendation fallback, estimates what is left.
The estimate is rough on purpose: it uses the same concrete remaining-step list shown above, with step
lengths from the TECH-5922 measurement (reviewer 5 min, worker 17, a mechanical fix 6, CI 5, a merge 2)
and money from this task's own finished runs of each role and the window's turns; with no finished run
of a role to go by, the cost is said to be unknown. A draft PR's steps include marking it ready for review.

Each question's call and rule is recorded in the task's `stops.jsonl`, and the human's reply to it next
to it as extend (`1`, extend, continue), stop (`2`, stop, accept as-is, or a reply reasoning ended the
task on through `accept_as_is`), or other. Only measurement reads it: reasoning still reads the reply
itself. `GET /v1/stops` and `sgt stops` report, per rule and call, the questions asked, the replies by
kind, and how many followed the recommendation, the data a later task needs to authorize automatic
extension for rule 2.

**A window counts only active time (TECH-6165)**: the time a worker or reviewer run or a planner turn
is running in it, up to the window's `wallMinutes`. Waiting on a human, on CI, or for a task slot never
counts, so no wait runs a window out. The loop starts the clock when it sees a run running (or one whose
status it cannot read) or starts a turn, and stops it when none is, keeping the time counted so far in
`state.json` (`budget.activeMs`, and `activeSince` while the clock runs). Spend counts every finished run
and turn of the window as before, the limit on runaway spending.

**Any human direction gives the task a fresh window**, with zero spend and the installation's current
budget, however exhausted the old one was, and wakes a turn (TECH-5059, TECH-5218, TECH-6165): a human's
answer to any of Sergeant's questions, this one included, or any other human comment on the issue; and a
human's review, inline review comment, or comment on the task's PRs. Each opens it from its own time. A
review or comment on a PR does not answer a Sergeant question still open on the issue: the question stays
open, and the loop takes no turn, until a human replies or edits the issue. Only an attributable human
opens a window. Linear says not who edited an issue, and GitHub's PR facts not who merged or closed a PR,
so an edit to the issue's title or description, or a merge or close of a PR Sergeant handed to a human to
merge or re-review, only wakes a turn, in the window the task has: the turn reconciles it even once that
window is exhausted (it can then only ask or accept, B1), and the task then waits, or asks the budget
question, as before. Each window has a number,
`budget.windowSeq` in `state.json`, 0 for the task's first and one more for each window opened; the
window's budget question is keyed by the task's start and that number, however the window opened, and a
task saved before it had one is in window 0. A window saved before active time was kept counts the wall
time it has had as used.
A comment a person's assistant posts through that person's own account (the Linear MCP, `gh`) is that
person's. A bot's or app's never opens one: a review bot that comments on every push would otherwise keep
a task going forever. Linear app users and integrations are never human, the GitHub adapter reads no App
account's feedback, and Sergeant's own comments are its own. A PR review or comment webhook, a bot's or
App's too, drops that PR's remembered feedback (08), so the poll it wakes rereads it. So does the task's unblocking—its last open
"blocked by" issue completing or canceling, or that relation removed, from the poll that sees it
(TECH-5803). Waiting on a human PR action is a human wait like a question: while the only thing left is
a human's merge of a PR Sergeant said is ready for a human to merge (a required review it cannot give,
such as a code owner's) or a human's re-review it asked for, the task takes no turn and posts nothing,
whatever its window. An extension is therefore just an answer; there is no separate grant (this supersedes `grant_budget`,
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

The latest human comment, on the issue or a task PR, overrides earlier instructions, the description
included, but only for what it addresses (TECH-6166). When one changes what the issue asks, reasoning
proposes `update_description(description, why, commentId?)`: the whole new description, with only what
the comment changed rewritten. Sergeant writes it only while the live description is still the one the
turn read, then posts the note above, so workers and reviewers check against one current source. The Gate:

| Rule | Check |
| --- | --- |
| U1 | the live conversation revision, human feedback on the task's PRs included (each PR re-read for the edit), is the one the turn read, so a human's edit or comment since, on the issue or a PR, is never overwritten; the write itself happens only while the description, re-read just before it, is the one the turn read (Linear has no conditional write, so an edit in the instant between is an accepted race, as for M10) |
| U2 | a note's thread (`commentId`) is a human comment on this issue |
| U3 | the new description differs from the one the turn read |

The note is keyed by the issue and the new description, so it is posted at most once. When the write
succeeds and the note fails, the action fails with that said, and the description stays written. The
edit changes the issue revision, so a review or skip from before it gives no standing (M13). A run
started later in the same turn gets the new text, even when the note failed.

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
- Description: why it exists, what was learned, a link back. Written to stand alone. It ends with the
  default-branch commit of each repository it concerns (the task's PRs' repositories, else its one
  enrolled repository; for feedback, the merged PRs'), read when it is filed, so a worker can see how
  stale its paths and scope may be and checks them on the current default branch (05 §3, TECH-5258).
  A failed read says so and never stops the filing.
- Delegated to Sergeant only when `followups.autoDelegate` is on; otherwise a human starts it.
- In the team's first `backlog` state, never Triage (whose rotation would auto-assign it to whoever is
  on call). Assigned to the origin's assignee unless that is Sergeant, else to the human who delegated
  the origin to Sergeant when Linear's history shows it, else unassigned.
- Limits: no per-task count (TECH-5186); `maxDepth` (F2–F3); deduplicated by Sergeant's semantic key
  (02 §6).
- After-deploy checks (TECH-6146): a done-when item only production access or post-deploy observation
  can prove gets one such follow-up per check, keyed `after-deploy-<slug>`, instead of a question to a
  human (03 §12). Nothing else differs: same Backlog state, relation, owner, and dedup.

**Feedback after the work landed (TECH-4985).** Once the completing PR merged or the issue is Done,
the task loop takes no more turns, so a human comment on the issue, or a comment or review on its
merged PR from someone with a role in the repository, would otherwise be lost. Sergeant sweeps
recently landed issues, reasoning judges each new piece of feedback, and actionable feedback becomes
one ordinary follow-up under the rule above (Backlog, owner-assigned, not delegated), keyed by the
feedback, with the delta, the feedback verbatim, links to the issue and the merged PRs, and the
default-branch commit it was written against. A human
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
- Linear's rate limit (`RATELIMITED`, answered with HTTP 400) stops every Linear call until the latest
  advertised `x-ratelimit-*-reset`, capped at one hour, else a minute, logged once (TECH-5923). A task
  loop that fails on it resumes after that time, not at the next intake, and shows as `paused` with
  the reset time until then, not `failed` (TECH-5941); the feedback sweep ends its pass. A login checked during that pause gets a 503 naming when to retry. Any other refusal names
  Linear's error code and message. The `requests` and `complexity` budgets each response reports, and
  each such pause with the tasks it paused, are kept for `sgt admin api`, and a budget below 15%
  before its reset is logged as a warning once (TECH-6208).

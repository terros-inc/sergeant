# Findings: why tasks hit the 30-minute wall-time window (TECH-5922)

Question: when a Sergeant task stops with "wall time exhausted", is the window's time spent on real
work or on waiting for humans? Should the window change, or should something else?

**Status: evaluation only.** No code or budget behaviour changes here. The issue owner asked to review
these findings and the proposed rubric (section 6) before any implementation task is filed, so the
next steps in section 8 are proposals, not filed issues.

**Short answer.** About half of the time in a real budget stop is Sergeant's own run time, and the
median real stop was 58% work. Most worker → review → fix chains fit in 30 minutes; 12% do not.
Stopping at the end of the window is fine and stays. What needs to change is what happens at the
stop: today Sergeant asks "do you want to spend more time?", and a human then researches the task by
hand to decide. Sergeant should do that research itself, make the case, and recommend extend or stop
using a short rubric (section 6). Once the rubric proves reliable, Sergeant can extend the obvious
cases without asking.

## 1. Source and coverage

All numbers come from one operator export, computed on the Sergeant host from the per-task state
(`state*.json`), `turns.jsonl`, run records (`runs/*/run.json` and `record.json`, end time = the
record's mtime), and the per-poll lines of `serve.log`. Only aggregates left the host.

- **Period:** 2026-10-02 21:21Z (the host's ledger starts there, after a rebuild) to 2026-10-13 07:00Z.
  The issue asked for Sep 29 onward; nothing earlier exists.
- **Windows:** 530 windows had a deadline in the period; 255 of them expired before anything else
  ended them.
- **Window length:** this installation sets a 30-minute window (the design default is 120 minutes,
  `docs/sgt.md` Budgets).
- **Not attached:** the operator's per-window table (task, window start, minutes per category, run in
  flight, how it ended, what reopened it). The example tasks in section 7 can therefore only be checked
  against the posted aggregates and the issue's own description of them, not window by window.

## 2. Two kinds of "exhausted"

| Kind | Windows | What it means |
|---|---|---|
| Expired while Sergeant waited on its own open question | 105 | Harmless. The answer opens a fresh window (TECH-5059); nothing is canceled or asked. |
| Real budget stop | 150 | 97 budget questions, 38 with runs canceled, 8 parked quietly (TECH-5218), 1 cost limit, 6 other. |

`sgt task show` prints `EXHAUSTED` for both, because it only compares now with `wallDeadline`. That is
most of why "nearly every stalled task" looked exhausted in the Oct 12 triage.

## 3. Where the time went in the 150 real stops

Share of all their minutes, and median / p90 minutes per window:

| Category | Share | Median | p90 |
|---|---|---|---|
| Active run (worker/reviewer) | 50.5% | 16.9 | 29.3 |
| Sergeant turns | 2.9% | 0.7 | 1.9 |
| Waiting on a human | 25.7% | 0.8 | 26.5 |
| CI / GitHub mergeability | 0.1% | 0 | 0 |
| Rate limits (GitHub, Linear) | 2.2% | 0 | 0 |
| Slot (concurrency) cap | 0.6% | 0 | 0 |
| Idle/other (restarts, loop errors, Linear unreadable, merge-retry grace, misc.) | 18.0% | 0 | 28.8 |

- **Human waits.** Of the 1,209 human-wait minutes, 872 were a PR waiting on a human review or merge:
  273 after Gate H1 handed the merge to a human, and 599 where a green PR was blocked on review
  (inferred). 315 were questions, almost all on Oct 2–3, before TECH-5059 was live.
- **Since the rules went live (Oct 5 02:20Z, 110 real stops):** run 56.3%, turns 3.2%, human 26.6%
  (818 of its 878 minutes are PR waits), idle/other 10.2%, rate limits 3.1%.
- **Shape.** In the median real stop, 58% of the window was run + turn time. 61 of the 150 were at
  least 80% work; 37 were at least half waiting on a human.

### Runs in flight at the deadline

- 44 of the 150 real stops ended with a run in flight: 29% of real stops, 8% of all 530 windows.
- 38 of those runs were canceled (28 workers, 10 reviewers); the other 6 finished just after the
  deadline.
- At the deadline those runs had been running a median of 11.5 minutes (p90 29.8). 16 had started
  within about 1.5 minutes of the window opening (a single run longer than the window); the other 28
  started after earlier runs had used most of the window (a chain that outgrew it).

### Lost or redone work

- 32 of the 44 were redone later by a run of the same role, 8 had kept their report, and 8 were
  neither. (The groups overlap: a run can both keep its report and be redone.)
- Canceled runs with no report had used 623 run-minutes. Canceled records carry no cost, so the dollars
  lost are unknown.

### Run and chain lengths against 30 minutes (all runs started in the period)

| | Runs | Median | p90 | Over 30 min |
|---|---|---|---|---|
| Worker | 524 | 6.1 min | 16.5 min | 17 (14 cut off by the cap) |
| Reviewer | 394 | 3.0 min | 5.1 min | 0 |

- 45 of 918 runs were canceled for any reason (4.9%).
- Worker → review → fix chains (runs less than 20 minutes apart): 288 chains, median span 12.1 minutes
  (p90 30.4), 2 runs at the median and 4 at p90. 34 chains (12%) spanned more than 30 minutes, 4 more
  than 60. These long chains are Sergeant's own worker → reviewer → fix runs, not human waits.

## 4. Did the fresh-window rules fire?

| Rule | Result |
|---|---|
| TECH-5059: a human answer opens a fresh window | 169 of 182 answers did. 12 of the 13 misses were Oct 2–3, before the rule was live. The one later miss answered a budget question and got a window 7 minutes later. |
| TECH-5218: a human review opens a fresh window | 22 of 32 review bursts did. 9 misses came while a Sergeant question was open (the loop holds on the question, so the later answer opened the window). The last is a timing artifact: a window opened 30 s later. |
| TECH-5218: no "Continue?" while waiting on a human PR action | 61 real stops were waiting only on a human PR review or merge at the deadline. Only 8 parked quietly; **50 asked "Continue?"** (the TECH-5663 pattern); 3 expired before any question was posted. In 42 of the 50 the PR was green and blocked on review, with no Sergeant handoff or re-review request, which did not count as a human wait before TECH-5913. |
| TECH-5803: unblocking opens a fresh window | 4 of 4 unblocks did. |
| TECH-5913: escalate a stalled review; park while it waits | Went live 2026-10-13 16:10Z, after the period. Its effect is not in these numbers. |

Before TECH-5913, no human PR wait stopped the clock inside a window: the code only checked for one
once the window had already run out.

### Calendar cost

When a human's "Extend" reopened a real stop, it came a median of 110 minutes after the deadline
(p90 711), 539 hours in total over 92 stops. Since Oct 5 the median is 50 minutes (p90 806). This,
more than the window's own 30 minutes, is what a stop costs: the task sits until someone researches it
and replies.

## 5. Reading the numbers

The issue owner's framing, which this document takes as settled:

- **Stopping at the window end is fine.** The window is the runaway-time backstop.
- **A human reply restarts the clock (TECH-5059), and that rule stays.** Waiting on a human is not the
  problem to solve.
- **Letting an in-flight run finish past the window is not an option.**
- **Human review time should never count against the window**, because a review opens a fresh window
  (TECH-5218). The 872 measured PR-wait minutes are a gap in how that rule was applied (42 of the 50
  "Continue?" asks were green PRs blocked on a review nobody had been asked for, which TECH-5913 now
  covers), not a reason to change the window length.
- **Chains over 30 minutes are Sergeant's own worker → reviewer → fix runs.**

So:

- **Is 30 minutes too short?** For single runs, rarely: worker p90 is 16.5 minutes and 14 of 524 workers
  were cut off. For chains, sometimes: 12% of chains exceed 30 minutes, and 28 of the 44 in-flight
  stops were late-starting runs at the end of a chain. A longer window would turn some of those stops
  into finishes, but it also delays every stuck-task signal by the same amount and widens the
  runaway-cost budget for every task. The window length is not the main lever; the stop decision is.
- **What does the stop cost?** Not the window: the median 110 minutes (50 since Oct 5) until a human
  decides, and the 623 run-minutes of canceled work with no report. A good case at the stop shortens the
  first; extending the obvious cases automatically removes both for those cases.
- **CI and rate limits are not the problem.** CI is 0.1% (a lower bound, see below), rate limits 2.2%,
  slot waits 0.6%.
- **Idle/other at 18% (10.2% since Oct 5)** is restarts, loop errors and unreadable Linear. It is worth
  watching but is outside this issue.

### What the data can't separate

- **CI vs human waits.** Required checks were `pending` in only 28 of about 1,100 open-PR snapshots, and
  non-required checks are not recorded. GitHub's `blocked` covers both a missing approval and failing
  required checks. A green-but-blocked PR is counted as a human review/merge wait (inferred), and CI time
  inside a run counts as run time. The CI figure is a lower bound.
- **Inferred human waits** come from the last turn's facts, not from a recorded wait. The H1 handoff
  minutes come from a recorded Gate denial and are firmer.
- **Rate limits, slot waits, restarts and loop errors** come only from `serve.log`, at about one-minute
  resolution. The ledger records none of them.
- **"Lost or redone"** is a proxy: whether the report was kept, and whether a same-role run came later.
  The data cannot show whether a canceled worker had already pushed useful commits.
- **Run end times** are the run record's mtime; no end time is stored.

## 6. Recommendation: make the case at the stop

Keep the window and keep stopping at its end. Change what happens at the stop.

Today an exhausted window ends in a budget question (`docs/design/07-linear-contract.md` §6). Its
template already has Done / Remaining / a recommendation, but in practice a human still has to
reconstruct the window to decide, often by asking another AI to research it and pasting the answer
back. Sergeant has the ledger (turns, runs, steers, restarts, reviews, PR and CI state) and should do
that research before it asks. When a window runs out, the stop comment makes the case:

1. **What happened in the window**: a short narrative of runs, steers, restarts and reviews. For
   example: "Started a worker; steered it once for a failing test; it was restarted after a crash;
   reviewer requested changes (1 blocking finding); fix worker started 4 minutes before the deadline
   and was canceled."
2. **How close the work is to done, and what is left**: PR state (CI, review verdict, mergeability),
   open blocking findings, and the concrete remaining steps.
3. **A recommendation, extend or stop, with the reasons**, taken from the rubric below.

### The stop rubric

Apply in order; the first rule that matches decides.

**0. Not a stop: park.** If the task is only waiting on a human (an open question, a merge handed to a
human, a re-review it asked for, a green PR waiting on a required human review), post nothing and take
no turn. The human's action opens a fresh window (TECH-5059, TECH-5218, TECH-5913).

**1. Stop (recommend; still ask).** Recommend stopping when any of these hold:
- the same blocking finding has come back after two fix cycles, or the task has had three or more fix
  cycles in the window;
- two or more restarts or steers of the same run produced no new commit or report;
- spend is at or above 80% of the window's cost cap with no PR ready for review;
- the work cannot finish without something Sergeant cannot get (access, a decision, another task).
  Then the recommendation is "stop, or answer this", and it names what is missing.

**2. Extend automatically (once proven).** Obvious cases, where the remaining step is small, bounded
and mechanical. All of these must hold:
- the remaining work is exactly one of: a merge Sergeant may do (review approved, required CI green,
  `mergePolicy: sergeant`); a rebase or mechanical fix (conflict-free rebase, lint or format) on an
  approved PR; or a first review of a finished worker's PR;
- no rule in 1 matches;
- spend is below 80% of the window's cost cap;
- the task's previous window did not also end in an automatic extension (at most one automatic extension
  in a row; the next stop always asks).

Until the rubric has proved reliable, these cases still ask, with "Sergeant recommends extend" and the
case made, so humans can confirm the call.

**3. Ask, with the case made.** Everything else: recommend extend or stop with the reasons, and let the
human decide. Typical "recommend extend" asks: a first fix cycle after a reviewer's change request; a
run canceled in flight that started late in the window (a chain that outgrew it) on its first attempt.

### Tradeoffs

- **Runaway-cost protection.** The window stays a hard backstop: nothing runs past it, and an automatic
  extension is a fresh, fully capped window, not an open-ended one. Limiting automatic extension to
  bounded mechanical steps, below 80% of the cost cap and at most once in a row, keeps a looping task
  from extending itself indefinitely.
- **Stuck-task detection.** A stop is today the main moment a human looks at a stuck task. Repeated fix
  cycles, a recurring finding, or restarts without progress always mean ask or stop, never auto-extend,
  so the signal is preserved where it matters; and the narrative makes a stuck pattern visible at a
  glance instead of after research.
- **Wrong calls.** An automatic extension that should have been a stop costs at most one window (30
  minutes and its cost cap) before the next stop asks. A "stop" recommendation is never acted on
  without a human.
- **Window length.** Lengthening the window would reduce the 12% of chains that overflow, at the cost of
  slower stuck detection and a larger worst case per task. The rubric captures most of the same benefit
  for the obvious cases without either cost. Revisit the length once the rubric's agreement is known.

## 7. The issue's examples under the rubric

The per-window table was not attached, so each example is checked only against the issue's description
and the aggregates above.

| Task | What the issue says | Rubric |
|---|---|---|
| TECH-5870 | Reviewer approved; `merge_pr` denied by B1 (wall time exhausted). | Only a merge left. If CI was green and the repository's `mergePolicy` is `sergeant`: rule 2, extend automatically. If the policy is `human`, it is a handoff: rule 0, park. |
| TECH-5919 | The turn declined to start a reviewer with about 2 seconds left. | Worker finished; a first review is next (reviewer p90 5.1 min): rule 2, extend automatically. |
| TECH-5663 | 18 turns, many "nothing changed, waiting" turns while two approved PRs waited on a human merge. | Rule 0: park, no question. This is the "Continue?" pattern counted 50 times in section 4. |
| TECH-5873 | Worker canceled at window end right after a reviewer requested changes; a question asked at 1:36 PM PT was answered at 4:38 PM PT. | The question wait was harmless (the answer opened a fresh window, TECH-5059). The stop: first fix cycle after a change request: rule 3, ask, recommending extend. If the requested change was mechanical, rule 2 would apply. The issue owner's first look named this the one clear case of a run lost to the window. |
| TECH-5805, TECH-5913 | Worker canceled at window end right after a reviewer requested changes. | Same as TECH-5873: rule 3, recommend extend, unless this was a repeated fix cycle or a recurring finding (rule 1). |
| TECH-5918 | Worker canceled at window end after spending $9.60 of a $10 cost cap; it had opened a PR. | Spend at 96% of the cap: never automatic. A PR exists, so rule 1's cost clause does not apply unless it was not ready for review; rule 3, ask, with the spend stated. |
| TECH-5612, TECH-5888 | Worker canceled at window end. | Not enough in the issue to place them. A late-starting first attempt is rule 3 (recommend extend); a long single run (one of the 14 workers cut off over 30 min) is rule 3 with the run's progress stated. |
| TECH-5902 | Reviewer canceled at window end. | No reviewer ran over 30 minutes, so this reviewer started late in a chain: a first review is rule 2; a re-review after several fix cycles is rule 1 or 3. |

## 8. Proposed next steps (not filed)

For review with this document; none is filed until the rubric is agreed.

Steps 1 and 2 are implemented by TECH-6021: the budget question makes the case and the rubric's
recommendation, and `sgt stops` reports agreement per rule (`docs/design/07-linear-contract.md` §6).

1. **Make the case at the stop.** Build the window narrative from the ledger and include it, the
   remaining work and the rubric's recommendation in the budget question (`docs/design/07-linear-contract.md`
   §6 template). No change to when the window ends.
2. **Measure the rubric.** Record each stop's recommendation and the human's actual reply, and report
   agreement per rubric rule.
3. **Extend the obvious cases automatically** (rubric rule 2) once agreement on that rule is high, with
   the at-most-once-in-a-row and cost limits above.
4. **Show question waits as waits.** `sgt task show` prints `EXHAUSTED` for the 105 harmless windows; it
   should say the task is waiting on an answer.
5. **Re-measure after TECH-5913** with the same method, to confirm green PRs blocked on review now park
   instead of asking.
6. **Record what the ledger lacks** (run end time and cancel reason, rate-limit and slot waits), so the
   next measurement does not depend on log scraping or mtimes.

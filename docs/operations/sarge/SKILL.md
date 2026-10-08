---
name: sarge
description: Run the Sergeant review routine (stats, server, quota, then batched decisions with recommendations and confidence). Use when asked to check on Sergeant, run the Sergeant review, or handle the next batch.
---

# /sarge - Sergeant review routine

Sergeant is Terros's autonomous coding agent (repo terros-inc/sergeant, hosted for Terros).
It picks up Linear issues that are in Todo and delegated to it, opens PRs, reviews and merges them, and asks humans in Linear when it needs a decision.
This routine turns all of that into one short report plus a few decisions, so the operator never has to browse Linear.

Private state lives in a configurable notes file (set `SARGE_NOTES_PATH`, e.g. `~/sarge-notes.md` or `~/.config/sergeant/notes.md`): the review ledger, the calibration log, pending follow-through, and the check log.
Read it first and update it at the end of every run.

## 1. Gather

- Run `scripts/snapshot.sh` (in this skill's directory). It returns open PRs, each task's latest service event, server load and deployed vs main, and quota for every account.
  If AWS calls fail, the SSO session expired: run `aws sso login --sso-session <your-sso-session>`.
- Linear, via the `linear-terros` MCP (never the Unforgotten `linear-server`):
  - Done since the last check (from the check log): `list_issues project=Sergeant state=completed`. Also check Sergeant-delegated issues in other projects (e.g. "On Call").
  - In progress and in review: `list_issues project=Sergeant state=started`.
  - Todo: `list_issues project=Sergeant state=unstarted`. Use `get_issue includeRelations=true` to drop anything with an unfinished `blockedBy`.
  - For each task the snapshot shows as "waiting: the (budget) question", read its latest Sergeant comment with `list_comments limit=1`.
  - **Backlog triage, once per work day:** `list_issues team=Tech state=backlog createdAt=-P1D`, limited to Sergeant-filed items and Sergeant project items not yet triaged (the check log records the last triage time). Sort each into promote (with rubric priority), cancel (obsolete, duplicate, or superseded — check main first), or keep in Backlog, and present it as one decision item. Never touch other engineers' tickets.

## 2. Report (in this order, short)

1. **Stats:**
   - Done since the last check.
   - How many of those have no review by us. Reviews by the operator or other AI assistants count; Sergeant's own reviewer doesn't. Use the ledger.
   - In Review + In Progress, and how many of those have a PR.
   - Stuck: waiting on the operator (questions, budget asks, human merges), named.
   - Todo + delegated and not blocked.
   - **Waiting on human review** (In Review, parked on another person's approval, e.g. sales PRs): list each with its age and requested reviewer. Check these every work day for progress.
2. **Server:** check load, CPU in the last hour, memory, **disk**, running workers, and deployed vs main. Say just **"nominal"** unless something is out of line (disk over ~80%, sustained CPU or load near the core count, memory pressure, deployed more than a few merges behind or the version not counting). A notable extra bullet is welcome occasionally, not every run.
3. **Quota:** each Sergeant-registered account in plain English from the snapshot's first QUOTA section (Sergeant's own reading at its latest launch, Claude included): percent left per window and when it resets, in Pacific time. Only fall back to the laptop accounts-axi section (where Claude can read "unknown" when the local login expired) if Sergeant has no recent reading.
4. **Reviews:** one line on what was kicked off and what came back, always including the clean count (e.g. "reviewed 6 merged PRs: 5 clean, 1 finding below"), so the operator sees reviews are happening even when nothing needs them.
5. **Decisions:** one batch.

## Reviews (background, every run)

Sweep PRs that need our review, kick off one background review scout with a different AI provider from Sergeant's, record verdicts in the ledger, and turn findings into decision items. Follow [`references/reviews.md`](references/reviews.md); the scout's brief carries [`references/review-rubric.md`](references/review-rubric.md).

## 3. Decisions: batches

Present one short, ranked batch (about 4 items) with links, options, a recommendation and a confidence, then offer the next batch or stop. Follow [`references/decision-batches.md`](references/decision-batches.md).

## 4. Act on the answers

Answer in Sergeant's own question thread, apply "converge or cut" to budget asks, verify who merged, and log each recommendation and choice in the calibration log. Follow [`references/answers.md`](references/answers.md).

## Standing rules

- **Name tickets as a short title, then the number in parentheses**, e.g. "lifecycle simplification ([TECH-4989](https://linear.app/terros/issue/TECH-4989))", with the number linked to Linear. Never a bare number.

- **Priority rubric:** use the rubric in [AGENTS.md § Linear priority](../../AGENTS.md#linear-priority). Don't duplicate it here; that section is the canonical source.

- **Everything in Todo is delegated to Sergeant;** Backlog is not. **Manage dependencies in Linear** with "blocked by" relations, not in the notes file. Sergeant's own follow-ups land in Backlog and are promoted by the operator.
- Keep in-flight Sergeant work small. Serialize changes to the same area (e.g. the task lifecycle); everything else runs in parallel.
- Steer through Linear issue comments. Use PR reviews only for line-specific code feedback.
- Work agreed in another tool (e.g. ChatGPT) only reaches Sergeant once it's posted on the Linear issue. Check that it's actually there.
- **Finish things.** Avoid nitpicking and gold plating. Prefer changes that reduce complexity over defenses against what might happen one day. Speculative or future-only concerns go to Backlog at most, usually nowhere.

## Configuration

Set these environment variables or document them in your assistant's configuration:

- `SARGE_NOTES_PATH` — path to the review ledger, calibration log, and check log (e.g. `~/sarge-notes.md`)

See `scripts/snapshot.sh` and `scripts/quota-from-sergeant.py` for their required configuration.

# PR review rubric

Paste the substance of this file into every review scout's brief.
Optimize for real correctness problems and useful simplifications, not commentary for its own sake.

For general PR review principles and techniques, see [trevorallred/trevor-profile skills/pr-review/SKILL.md](https://github.com/trevorallred/trevor-profile/blob/main/skills/pr-review/SKILL.md).

## Sergeant-specific review focus

**No nitpicking, no gold plating.** Report only defects with a plausible failure in how the system is used *now*, and simplifications that remove machinery. Don't propose defenses against things that might happen one day ("what if the logger throws"), future-only operational risks, or extra hardening the ticket didn't ask for. When a fix is needed, prefer the one that deletes or reuses code over the one that adds a special case. A short "no issue found" is a good result.

Read-only: never approve, comment on, merge, close or label anything on GitHub, and never create or modify Linear issues.

## Establish intended behavior

- Read the PR title, description, commits, changed files and the full diff.
- Read the linked Linear issue (TECH-…) before judging correctness. Its description and the human comments are the intent.
- Read repository guidance (`AGENTS.md`, relevant ADRs/design docs) and nearby code when needed to understand invariants.
- Inspect the tests actually changed or added; a test-plan checklist is not proof.
- Read Sergeant's own follow-ups filed from the same issue ("Follow-up from TECH-…") and later PRs. A finding that's already ticketed is reported as "already TECH-…", not as new work.
- For a re-review (head changed since our last review), concentrate on the delta since the reviewed head, then scan for regressions it causes.

## Correctness first

Look for concrete defects with a plausible failure scenario, tied to a file/function:
- Intent not fully met.
- State transitions, persistence, retry, resume, cancellation or idempotency wrong.
- Error paths that fail open, silently swallow state, or leave inconsistent durable state.
- Concurrency, stale snapshots, repeated ticks, duplicate delivery, partial failure.
- Authentication, authorization, credentials, shell execution or trust boundaries weakened.
- New configuration that can drift from an already authoritative source.
- Unsafe migrations or persisted-data assumptions.
- An old code path left active that conflicts with the new one.
- Tests that assert implementation details but miss the failure mode the change prevents; mocks that give false confidence at a real integration boundary.

No speculative concerns without a plausible failure mode.

## Simplification pass

Ask whether the same intent needs less machinery: extend an existing path instead of adding a parallel one; derive instead of configure; reuse an existing helper; remove state/enums/modules/branches that buy no real invariant; narrow to the ticket; delete obsolete mechanisms instead of adding observability around them.

Recommend only when it materially reduces complexity or failure modes without weakening behavior. No churn, renames or style.

## Classify

- **Correctness issue**: fix before merge, or a follow-up if already merged.
- **Simplification**: say whether required or optional.
- **No issue found**: say so plainly.

## Per-PR output

- Verdict line: No issue found / Simplification only / Correctness issue.
- Findings, correctness before simplification, each with file:line, the failure scenario, and the smallest fix.
- Open PR with findings: the steer to post on the Linear issue for Sergeant, as "Correctness: …" then "Simplification (optional): …" (omit empty sections).
- Merged/closed PR with findings: first check whether a later PR already fixed or superseded it. If not: the defect, its consequence, the smallest follow-up scope, and a suggested Linear title.
- Report the head SHA each PR was reviewed at.
- Compare with Sergeant's own review of that PR (its telemetry, below): did it review the final merged head, was the review required or a random audit, and did it already flag what you found (blocking, non-blocking, or not at all)?

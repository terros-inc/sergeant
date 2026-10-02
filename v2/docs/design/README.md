# Sergeant 2 — pseudocode architecture package

**Status: draft 3 (2026-10-02), pending captain review.** These are the living design documents for
Sergeant 2, maintained here from now on. They incorporate the captain's first-round decisions, the
UNF-701 evaluation criteria, an independent fresh-context architecture review, and the captain's review
posture, woven through every file rather than appended. Nothing here is implemented yet.

Terms: **the captain** is the project owner, who makes product decisions; **Firstmate** is the
owner's agent supervisor, which wrote this package; **S1** is Sergeant 1, the Rust implementation, removed
from `main` and preserved at the tag `v1-final`; **S2** is Sergeant 2, this `v2/` workspace. Paths such
as `docs/adr/…` (still at the repository root) and `docs/data-model.md` (at `v1-final`) refer to S1's
documents.

## Design summary

**Sergeant** is the whole system. A delegated Linear issue is a unit of work. Sergeant's **reasoning**
(an AI component, one turn at a time per task) reads the current issue, GitHub, and run state; chooses
the relevant enrolled repositories; briefs **one primary worker**, which does all the engineering and
may run its own subagents; starts a **separate fresh-context reviewer** when the change warrants it (if in
doubt, it does); interprets reports; asks a human only for genuine judgment; and merges. GitHub → Linear
automation then marks the issue Done.

The **deterministic core** keeps a five-table ledger, assembles facts, schedules turns, executes actions
idempotently, runs runner adapters, and applies a **Gate** whose every rule names the material harm it
prevents: an unreviewed or red merge; production, admin, personal, or control-plane authority reaching a
run; runaway time or concurrency (spend best-effort); and a human decision silently abandoned. Everything
else is handled by re-reading authoritative state, another reasoning turn, a retry, or redoing some work.

Workers are trusted development engineers in one shared runner zone, separate from the control plane.
Review quality is tracked as a product metric (over- and under-review, vendor and mode splits). There are
no phases, leases, acceptance-criterion records, billing ledger, or experiment framework.

## Where to start

1. `00-charter.md` — goal, principles (including the "what happens if we lose it?" test), the one
   picture, who owns what, S1 → S2.
2. `12-scenarios.md` — fifteen situations walked through the design, and where a state machine was
   tempting.
3. `14-open-questions.md` — what is settled, the `## Captain Questions` section (currently none),
   tensions, verification items, and the review findings with what changed (§F).
4. `13-s1-supersession.md` §5–6 — the transition plan and the implementation slices.

Then the reference contracts as needed.

## Contents

| File | What it defines |
|---|---|
| `00-charter.md` | Goal, non-goals, Sergeant's two halves (reasoning, deterministic core), principles P1–P14, ownership, trust model summary, S1 → S2 |
| `01-domain-model.md` | **Every type shape**, with why, owner, durability, source of truth, lifecycle, and "if lost" |
| `02-persistence.md` | The five tables, what is deliberately not stored, S3/CloudWatch, idempotency inventory, restart, ledger loss |
| `03-sergeant-reasoning.md` | Turns, wake reasons, reasoning's tools, the conversation revision, the Gate's rule catalog (each rule mapped to a harm), the Effector and closing steps, sessions and compaction, the prompt outline |
| `04-runner-contract.md` | The small common runner contract, optional capabilities, unknown vs. lost, best-effort usage, workspaces, the runner zone and credential vending, adapters |
| `05-brief-report-protocol.md` | Worker briefs and reports, modeled on Firstmate's; the standard worker rules; parsing |
| `06-review.md` | Fresh-context review, review dispositions (the one deterministic review hook), calibration sampling, review telemetry and over-/under-review metrics |
| `07-linear-contract.md` | What Sergeant posts, questions and the human wait, intake, budget asks, completion through automation, cancellation, edits, follow-ups |
| `08-github-contract.md` | Two GitHub Apps, enrollment checklist, PR association via Linear attachments, CI facts, merge rules M1–M10, moving bases |
| `09-security.md` | Zones, how each hard exclusion is enforced, CI and the production boundary, prompt injection, accepted blast radius |
| `10-installation-config.md` | Identity, configuration keys, setup, the laptop trial installation |
| `11-apis-cli.md` | Internal/public API, webhooks, runner API, background loops, guardrail actions, `sgt` commands |
| `12-scenarios.md` | Fifteen end-to-end scenarios |
| `13-s1-supersession.md` | Every S1 concept classified (keep / simplify / move to reasoning / move to runner / delete); ADRs kept and abandoned; what we give up; the 7-step transition plan; implementation slices |
| `14-open-questions.md` | The decision register, including the independent review's findings and changes |

## Section 15 — independent review

An independent fresh-context architecture review was run against draft 2 (its report is not published
here). Its twelve findings, their classification under the captain's review posture, and what changed
are summarized in `14-open-questions.md` §F; the captain's review of draft 3 and its changes are in §G. A second fresh-context consistency pass over this draft is recommended before
the implementation backlog is created.

## Conventions

- Pseudocode, not TypeScript. `?` optional, `|` one of, `T[]` list.
- Type shapes live only in `01`; other files refer to them.
- Rule ids (G, B, R, RS, V, S, C, Q, F, P, D, M, K, E, X) are defined in `03` §7, `06` §6, and `08` §7.
- `[S]` Sergeant's reasoning, `[G]` deterministic core, `[W]` worker, `[R]` reviewer, `[H]` human in
  scenarios.

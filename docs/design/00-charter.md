# 00 — Architecture charter

Status: draft 3 (2026-10-02): revised for the captain's first-round answers, the independent
architecture review, and the captain's review posture. This is a
pseudocode architecture for review, not an implementation plan. Nothing here is TypeScript, and
nothing here changes Sergeant 1.

## 1. Goal

A Linear issue describes a unit of engineering work. **Sergeant** reads it, decides what work
should happen, gives that work to a worker, gets it independently reviewed, asks a human when real
judgment is needed, and sees it through to merged code or a clear answer. Sergeant enforces only
the few invariants that need deterministic enforcement.

Success looks like this:

- A delegated issue becomes merged PR(s) in one or more enrolled repositories, or a clear question
  or report on the issue, without a human babysitting it.
- A human can read the issue and know what Sergeant is doing, why, and what it needs, without
  reading transcripts.
- Spend, wall-clock time, and blast radius stay inside limits a human set.
- After a crash or restart, "read Linear, GitHub, and the active runs, then decide" is enough to
  carry on. Occasionally some agent work is redone. That is acceptable.
- Automated review quality is measured and improves over time, as seriously as implementation
  quality.

## 2. Non-goals

Sergeant 2 does not:

- promise formal guarantees against every possible agent failure. It accepts occasional repeated or
  lost agent work, small timing races with external systems, broad authority for trusted runners inside
  the development zone, and best-effort controls where a provider cannot expose exact information;

- write code itself;
- encode how a good engineer thinks (no planning, implementation, review, fix, rethink, test, or
  repair phases);
- run a workflow engine, phase machine, or lifecycle DSL;
- orchestrate several simultaneous implementation workers on one task;
- own git workspaces, clones, rebases, conflict resolution, or test execution;
- broker individual development tools or credentials capability by capability;
- bind a task to one repository, or run per-repository lifecycles;
- duplicate completion that GitHub → Linear automation already performs;
- guarantee that no agent work is ever lost;
- interpret human language with pattern-matching code;
- keep a private durable memory system for its own reasoning;
- isolate tasks or runs from each other at the operating-system level;
- keep leases, acceptance-criterion records, distributed transactions, a billing ledger, or an
  experiment framework;
- support multi-tenant hosting, multiple controllers, or hypothetical scale;
- choose libraries or frameworks before a concrete need appears.

## 3. One actor, two halves

There is one coordinating actor: **Sergeant**. Workers and reviewers are subordinate agents.

Sergeant has two halves, which this package keeps distinct only because they are built
differently:

- **Sergeant's reasoning** is an AI session per task. It takes *turns*. In each turn it reads a
  freshly assembled Situation Report, decides what should happen next, and proposes actions:
  start or message the primary worker, start a reviewer, ask a human, comment, create a follow-up
  issue, merge a PR, choose the task's repository set.
- **Sergeant's deterministic core** is ordinary TypeScript. It admits tasks, reads facts, schedules
  turns, keeps the small ledger, vends credentials, runs the runner adapters, meters budgets, and
  executes actions idempotently. Its **Gate** refuses any proposed action that would break an
  invariant.

Sentences in this package such as "Sergeant starts a reviewer" mean Sergeant's reasoning proposed
it and the deterministic core allowed and performed it.

## 4. Principles

**P1. The Linear issue is the unit of work.** It is not bound to one repository. Sergeant picks
which enrolled repositories are relevant and gives that set to the worker, who may inspect and
change all of them and open several PRs. Multi-repo work is ordinary and uncommon. If the work is
really several outcomes, Sergeant creates follow-up issues. (S1: ADR-0031's one-repository rule;
UNF-608's worker could not reach the repo its fix belonged in even after a human redirected it;
UNF-625 needed follow-up-issue machinery just to express "also change repo B".)

**P2. AI decides what should happen. Deterministic code decides what is objectively true and what
is permitted.** Neither side does the other's job. (S1: UNF-663, UNF-674, UNF-698 — three tickets
in one day where pattern rules silently ignored human replies; ADR-0031's phase-mismatch
decisions.)

**P3. The "what happens if we lose it?" test, and machinery only for material harm.** Every piece of
durable state and every deterministic rule must answer "what happens if we lose it?". If the answer is
that an agent occasionally repeats half an hour of work, Sergeant does not protect it. The captain's
standard (2026-10-02): **add deterministic machinery only when a failure can cause material harm that
Sergeant has been explicitly asked to prevent; otherwise re-read authoritative state, take another
reasoning turn, retry, or redo the work.** Four such harms are the current target. They are a
simplicity target, not a fixed taxonomy: every hard rule must name the harm it prevents, or be
challenged.

| Material harm | What prevents it | Where |
|---|---|---|
| L1. Unreviewed or red code merged | Merge requires green required checks on the exact head and a recorded fresh-review disposition for that head; default-branch rulesets keep workers from merging around it | 08 §7, 06 §6 |
| L2. Production, admin, personal, or control-plane authority crossed | No run holds such credentials; the runner zone is separate from the control plane | 09 |
| L3. Runaway time or concurrency (and spend, best-effort) | Wall-clock, concurrency, and cancellation are hard; cost is enforced where usage is observable | BudgetMeter, 03 §7 |
| L4. A human decision silently abandoned | Every Linear change wakes a turn that sees every human comment; one open question is durable until answered; merges and completion carry the conversation revision their turn saw and are refused if Linear changed since | 03 §5, 07 §4, M10, X5 |

Everything else is either re-read from Linear, GitHub, and the runner, or allowed to be lost.

**P4. Authoritative state lives outside Sergeant's head.** Linear, GitHub, runner state, and the
small ledger are authoritative. Sergeant's reasoning session is working memory: it may persist
across turns for efficiency and is compacted automatically, but a completely fresh session must
always be able to re-read the world and continue.

**P5. Sergeant manages; workers engineer.** Sergeant does not write code. Each task has **one
primary worker** at a time, and it owns finding code, planning, editing, git, rebasing, local
tests, CI diagnosis, fixing, and PRs. If parallel engineering helps, the worker runs its own
subagents; Sergeant does not need to know their topology.

**P6. Review is fresh-context and measured.** The required review is a separately launched reviewer
run whose reasoning did not inherit the implementer's (independence of reasoning, not an OS privilege
boundary). The worker decides whether its change needs one, and when in doubt asks for it ("think
80/20, not 99/1"); an occasional wrong skip is an accepted cost. Reviews happen 0..N times. A random
sample of skipped reviews gets a nonblocking audit review; telemetry tracks both over- and
under-review, and same- versus different-vendor review, as a first-class product metric (06 §8–9).
Worker-launched subagent reviews are measurement-only until the captain decides otherwise. (S1:
ADR-0039/UNF-641, ADR-0041/UNF-647.)

**P7. Budgets are coarse guardrails.** About 2 hours of active task time and about $25 per task by
default, both configurable. Wall-clock, concurrency, and cancellation are hard controls. Spend is
best-effort: enforced mid-run where a provider reports usage, known at the end otherwise, and blind to
dev/stage resources, CI, and separately billed tools. They bound wandering; they are not stage budgets.
(S1: UNF-639 cost $73; UNF-653's SME note that a cap checked only between Runs cannot stop a $49 Run.)

**P8. Trusted development runners, a structural hard boundary.** A runner is treated like an
autonomous development engineer, not a hostile sandbox escapee. Runs share one development zone:
anything granted to any run (enrolled repositories, dev/stage systems) is within the accepted blast
radius. The hard boundary is production, IAM/org/billing, Sergeant's control plane, and personal
credentials; no run ever holds them, and that is enforced by the credentials given, not by prompts.
(S1: UNF-650, a worker minted the control plane's GitHub App token because it inherited the daemon's
environment.)

**P9. Linear stays concise.** Linear holds Sergeant-level summaries, important decisions and
questions, PR references, and outcomes. Briefs, reports, and transcripts go to S3; operational logs
go to CloudWatch. (S1 retro F7: 1 of 25 Sergeant comments on UNF-639 needed action.)

**P10. A human wait means one thing.** "This task is waiting for the answer to this Linear
question." No phase to resume, no transition to replay.

**P11. Completion follows the real integration.** In our repositories, merging the PR is what
completes the Linear issue: GitHub → Linear automation moves it to Done. Sergeant merges (where the
repository allows it) and lets that happen. It does not run a parallel completion protocol. For
multi-PR tasks it only makes sure non-final PRs do not close the issue early (07 §7).

**P12. Provider neutral, not lowest common denominator.** The common runner contract is small.
Adapters may expose richer capabilities (fresh subagents, resumable sessions, native cloud
execution, provider review features) that Sergeant uses where they help, without those capabilities
entering the core domain model. (S1: ADR-0001 survives in spirit.)

**P13. Jev is optional.** Sergeant's reasoning makes most semantic decisions. Jev may serve as a
cheap bounded classifier or watchdog where evidence shows it helps. Nothing exists just to give Jev
a role.

**P14. Boring code.** Strict TypeScript, async/await, small interfaces, schemas at the edges.

## 5. The system in one picture

```
                      humans: Linear issue + comments, sgt CLI
                                    │ delegate · comment · answer · cancel
                                    ▼
 ┌─────────────────────────────────── Sergeant ────────────────────────────────────────┐
 │                                                                                       │
 │   ┌───────────────────── reasoning (AI session per task) ──────────────────────┐    │
 │   │  turn: read Situation Report → decide → propose actions → end_turn          │    │
 │   │  working memory, compacted automatically; never authoritative               │    │
 │   └──────────▲───────────────────────────────────────────────┬─────────────────┘    │
 │              │ Situation Report                     proposed │ actions               │
 │   ┌──────────┴──────────────────────── deterministic core ───▼─────────────────┐    │
 │   │ Intake · FactReader · Scheduler · Ledger (SQLite) · BudgetMeter              │    │
 │   │ Gate (the four invariants + limits) → Effector (idempotent effects)          │    │
 │   │ RunManager + credential vending → Runner adapters                            │    │
 │   └──────┬──────────────────────────┬──────────────────────────┬───────────────┘    │
 └──────────┼──────────────────────────┼──────────────────────────┼────────────────────┘
            │ comments, questions,     │ merge, PR links,         │ start · status · send
            │ follow-ups, attachments  │ CI and PR reads          │ cancel · result
            ▼                          ▼                          ▼
         Linear ◄── PR merged ──── GitHub ◄── branches, PRs ── primary worker (+ its subagents)
       (automation                                             reviewers (fresh context)
        marks Done)                                            via claude-local, codex-local,
                                                               cloud-agent adapters
   briefs, reports, transcripts, Situation Reports → S3;  operational logs → CloudWatch
```

The arrows that matter:

- Sergeant's reasoning never touches Linear, GitHub, or a runner directly. It proposes actions; the
  Gate is the only path to an effect.
- Workers push branches and open PRs with a worker identity. They never touch Linear or the ledger.
- Merging is Sergeant's, and the Linear issue's Done state usually follows from GitHub automation.

## 6. Who owns what

| Owner | Owns | Does not own |
|---|---|---|
| **Sergeant — reasoning** | Understanding the issue; choosing the repository set; briefing the primary worker; asking for review; reading reports; deciding whether a finding blocks; asking humans and interpreting replies; creating follow-up issues; deciding merge and what happens next | Facts (it reads them); permissions (the Gate decides); code; any memory that correctness depends on |
| **Sergeant — deterministic core** | Intake and admission; the ledger; assembling facts; scheduling turns; the Gate; idempotent Linear/GitHub effects; run bookkeeping, liveness, credential vending; budgets and concurrency; session compaction triggers; review-quality accounting; the kill switch | Any semantic judgment |
| **Primary worker** (one run at a time per task, via a runner) | All engineering: finding the relevant code inside its repository set, planning, editing, git, rebasing, local tests, CI diagnosis, fixing, PRs and their descriptions; its own subagents; deciding whether its delta needs fresh review; reporting follow-up ideas | Linear; merging; budgets; issue creation; any credential outside the development zone |
| **Reviewer** (a separately launched reviewer run; a worker's fresh subagent review is measurement-only until the captain decides otherwise) | Judging a change against the issue's requirements and engineering quality in fresh context; naming unverified external boundaries; a structured review report | Mutating the change; deciding merge or completion |
| **Runner adapter** | Process, session, container, or cloud-agent mechanics and cleanup; workspaces; caches; provider accounts; optional richer capabilities | Task decisions |
| **Linear** | The durable brief; the human-visible history; delegation; relations and follow-ups; which PRs belong to the issue (attachments); Done, via GitHub automation | Sergeant's runtime bookkeeping |
| **GitHub** | Code, branches, PRs, CI, required checks, rulesets (the hard merge boundary) | Task state |
| **Humans** | Delegating; answering; granting budget; cancelling; merging where a repo requires it; enrolling repos; configuring installations | Day-to-day supervision |

## 7. What is AI and what is deterministic

| Question | Decided by | Why |
|---|---|---|
| What did the human mean? | Sergeant's reasoning (optionally helped by a Jev classifier) | Semantic |
| Has the conversation changed since the turn that proposed this merge or completion? | Gate, re-reading Linear | Objective (revision equality) |
| Is this one task or several? Which repos are relevant? | Sergeant's reasoning | Semantic |
| Is the repo set a subset of enabled enrollments? May another follow-up be created? | Gate | Objective |
| Does this delta need fresh review? | The worker, then Sergeant's reasoning | Semantic |
| Does the exact head being merged have a valid review disposition? | Gate | Objective (evidence names that SHA) |
| Is this reviewer finding blocking? | Sergeant's reasoning | Semantic |
| Did CI pass on this exact SHA? Is the PR mergeable? | GitHub, read by FactReader | Objective |
| Is the run alive? What has it spent? | Runner adapter, read by RunManager | Objective |
| Is the task over budget? | BudgetMeter | Objective |
| What to say to the human when it is? | Sergeant's reasoning | Semantic |
| Is this task or behavior suspicious? | Sergeant's reasoning; optional Jev watchdog (advisory) | Semantic |
| Can a run touch production? | Nobody: no run holds production credentials | Structural |
| Is the issue done? | GitHub → Linear automation on merge; Sergeant's reasoning for non-code outcomes | Real integration |

## 8. Trust model in one paragraph

All runs share one **runner zone** (development trust): write access to the enrolled repositories they
are given (with no bypass of default-branch rulesets), dev/stage AWS authority, model credentials, and
engineering tools. Reviewers are given read-only GitHub tokens, but runs are not isolated from each
other, so anything granted to any run is within the accepted blast radius. Sergeant's deterministic core
runs in a separate **control-plane zone** that holds the Linear agent credential, the control-plane
GitHub App, installation configuration, and merge authority. Neither zone holds production,
IAM/org/billing administration, or anyone's personal credentials: that is the hard boundary. Sergeant's
reasoning reads untrusted text (issues, comments, reports, code), so everything it can cause is bounded
by the Gate. Details and the literal blast radius are in `09-security.md`.

## 9. Sergeant 1 → Sergeant 2

| Concern | Sergeant 1 | Sergeant 2 |
|---|---|---|
| Who decides the next step | `orchestrator::decide::next_step`, a fixed lifecycle in code (~11k lines in `orchestrator/`, ~7k in `implementation_tick/`) | Sergeant's reasoning, a turn over a fact snapshot |
| Lifecycle model | `TaskState` + `current_phase` (PLANNING → IMPLEMENTATION → VERIFICATION → FINALIZATION → DONE), typed waits, grants, CAS phase transitions | Open or closed, plus at most one human wait ("waiting for the answer to this Linear question"). No phases |
| Roles | simplify (planner), implement, review, fix, rethink, test, repair, deep-assurance, final-review (retired) | One primary worker per task, and reviewers |
| Repositories per task | Exactly one; others spill into follow-up issues (UNF-625) | Sergeant chooses a set of enrolled repos; one worker may produce several PRs |
| Workspace | Sergeant-owned bare cache, retained Task worktree, observation worktrees, stow/reclaim | Runner-owned and disposable; continuity from pushed branches |
| Git and PRs | Sergeant pushes candidates with its own App; the worker only commits locally | The worker pushes and opens PRs with a worker identity; Sergeant merges |
| Review | Worker-decided review, gating audit sample, review contracts, AC parsing, SME routing, deep assurance | Worker-decided fresh-context review (separate reviewer run) recorded as a per-head-SHA disposition; nonblocking audit sample; review telemetry for over-/under-review and vendor comparison; subagent reviews measurement-only |
| Testing | Test role, validation plans; ADR-0041 made CI the gate | CI is the gate; workers run targeted tests; what CI cannot do is reported `blocked_by_environment` |
| Human decisions | Decision menus, choice ids, reply-shape parser, typed interpreter, clarification rules | Free-form questions and answers on the issue, interpreted by Sergeant; the human wait and the conversation-revision check on merge/completion enforced deterministically |
| Completion | Sergeant's finalization phase, exact-head certification, merge, then Done | Sergeant merges; GitHub → Linear automation marks Done |
| Credentials | Capability → executor model | Development credentials vended per run; one shared runner zone separate from the control plane |
| Persistence | 10 application tables plus JSON sub-documents for waits, grants, faults, health, repo scope, planning baselines, deep-assurance | 5 small tables: `tasks`, `runs`, `turns`, `actions`, `system_state` |
| Recovery | Deterministic reconciliation of phases, waits, workspaces, candidate lineage | Re-read the world and take a turn; adapters re-adopt or report lost runs |
| Language | Rust (~179k lines across three crates) | TypeScript, deliberately small |

## 10. What we are betting on

- **Sergeant's judgment, given good facts, beats a fixed lifecycle.** If it falls short, the fix is
  better facts, prompts, and evals, not a phase machine. `12-scenarios.md` tests this bet against
  fifteen situations.
- **Workers are competent engineers.** Modern coding agents rebase, diagnose CI, and open PRs.
  Sergeant 1 spent much of its complexity doing those things for them.
- **Redo is cheaper than recovery machinery.**
- **Review quality can be measured well enough to tune.** The calibration sample and review telemetry
  (06 §9) are how we will know whether the review-need policy is too strict or too loose, and whether
  same-vendor fresh context is enough.

Main risks (`14` §C): reasoning cost per task, prompt injection through untrusted text, accepted
co-residency inside the runner zone, best-effort spend, and the unverified GitHub → Linear completion
behavior (verified first in the walking skeleton).

## 11. How to read this package

Read this charter, then `12-scenarios.md` (the design walked through fifteen situations), then
`14-open-questions.md` (what the captain still decides). `01`–`11` are the reference contracts the
scenarios rely on. `13-s1-supersession.md` classifies every Sergeant 1 concept and holds the
transition plan.

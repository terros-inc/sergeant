# 13 — Sergeant 1 supersession matrix and transition plan

Sergeant 1 is the fallback, historical evidence, a source of lessons, and a source of edge cases. It
is not a migration target and is not changed by this design. This document classifies every
important S1 concept, records which ADRs Sergeant 2 keeps or abandons, and lays out the transition
the captain chose.

Classes: **KEEP** (same idea, same role) · **SIMPLIFY** (the need survives in a much smaller form) ·
**MOVE TO REASONING** (becomes Sergeant's reasoning) · **MOVE TO RUNNER** (becomes the worker's or adapter's
job) · **DELETE** · **UNDECIDED** (in `14`).

## 1. Concept matrix

### Work model and lifecycle

| S1 concept | Class | S2 form | Why |
|---|---|---|---|
| Task / Run (ADR-0013) | SIMPLIFY | `Task` = ledger row per issue episode; `Run` = one runner execution | The aggregates survive; almost all their state does not (02) |
| `TaskState` ACTIVE/WAITING/DONE/CANCELED | SIMPLIFY | open or closed; "waiting" derived from the one `HumanWait` | Waiting meant many things in S1; in S2 it means one thing (P10) |
| `current_phase` PLANNING→…→DONE (ADR-0031) | DELETE | none | The fixed lifecycle is what Sergeant's judgment replaces. ADR-0031 even needed `phase-mismatch:` human decisions when history and phase disagreed |
| Waits (`wait_json`: GITHUB_EVIDENCE, HUMAN_INPUT; deadlines, timeout actions) | SIMPLIFY | `HumanWait` only; GitHub "waits" are wake reasons on facts | A GitHub wait is just "wake me when CI finishes" |
| Grants (`retry`, `fresh_run`, `rethink`, `active_budget`) | SIMPLIFY | `BudgetGrant` only | Retry, fresh run, and rethink are Sergeant's decisions; only budget is human authority |
| Planner / simplify role (ADR-0038, UNF-341, UNF-569) | MOVE TO RUNNER, MOVE TO REASONING | the worker plans; Sergeant decides scope, repos, and decomposition | A planning run that only chooses a repo and work units is overhead for a capable worker |
| Execution plan, work units, tiers, validation level | DELETE | none | The 2026-09-30 retro (F4) found planner tiers did not even drive model choice |
| Implement / fix / repair roles | MOVE TO RUNNER | one primary worker, continued or succeeded | They are the same engineering job with different context |
| Rethink (ADR-0025) | MOVE TO REASONING | Sergeant may change approach with a successor worker or ask a human | Changing approach is judgment, bounded by budget |
| Test role, validation plans, `test_contract` | DELETE | CI is the gate; workers run targeted tests; `blocked_by_environment` for the rest | ADR-0041 already made CI the gate; the retro counted ~9 full-suite runs on one task |
| Deep assurance (UNF-345), SME consultation and routing (UNF-531, UNF-356) | MOVE TO REASONING | a reviewer `focus`, or a human question | No separate stage; Sergeant decides when a change needs special scrutiny |
| Fix/rethink budgets, retry policy, failure classes (ADR-0022) | SIMPLIFY | task budget + B3 start-rate breaker; run failure kinds are facts | One coarse budget replaces several counters |
| Candidate identity, lineage, exact-head certification | SIMPLIFY | per-head `ReviewDisposition` + M4/M5/M6 | "Evidence must be about the exact SHA being merged" survives; lineage bookkeeping does not |
| Multi-repo stopgap and follow-up spin (UNF-569, UNF-625) | DELETE | the task's repository set; one worker, several PRs | Captain round 1: workers are not restricted to one repo. UNF-608 showed the cost of the restriction |
| Repo scope (`pending_repo_scope_json`, scope sources, Jev/exact-match selection) | SIMPLIFY | `set_repositories` by Sergeant | Choosing repos is judgment; enforcing the set is credentials |
| Decision menus, choice ids, reply-shape parser, typed interpreter, clarification rules (ADR-0031, UNF-663/674/698) | MOVE TO REASONING | free-form questions; Sergeant interprets; merges and completion compare a conversation revision | Three bugs in one day came from parsing human language deterministically |
| Recursive decision issues | DELETE (already gone in S1) | | |
| Linear follow-up issue creation | MOVE TO REASONING + Gate limits | `create_followup_task` | Captain round 1: Sergeant creates issues; workers suggest |
| Preflight, planning baseline, staleness checks | DELETE | Sergeant sees description diffs and decides (07 §10) | |
| Completion via Sergeant finalization + merge | SIMPLIFY | Sergeant merges; GitHub → Linear automation marks Done | Captain round 1: do not duplicate the integration |

### Review

| S1 concept | Class | S2 form | Why |
|---|---|---|---|
| Worker-decided review (ADR-0039, UNF-641) | KEEP | `ReviewRecommendation` per PR head; fail-safe to review | The captain's most valued S1 feature |
| Audit review sample | KEEP, changed | deterministic hash sample of skipped heads; **nonblocking** | Captain round 1 says nonblocking; S1 had made it gating (tension recorded in `14` §C) |
| Review calibration (`review_decision`, `review_trigger`, `review_result`, `human_found_must_fix`) | KEEP, extended | `ReviewFacts` telemetry; over- and under-review metrics; provider and mode splits (06 §9) | Review quality is a first-class metric; no experiment framework yet |
| No mandatory final review | KEEP | | |
| Reviewer rules: AC verdicts, trace trade-offs, numstat, targeted probes (ADR-0041) | KEEP | reviewer rules (06 §4) | Direct lessons from the UNF-639 retro |
| Acceptance-section parser, stable AC ids, review contracts | SIMPLIFY | reviewers rule on every requirement quoting the issue and file unmet ones as blocking findings; the parser adds a finding if one is missing; an acceptance finding cannot be accepted as non-blocking (D3) | The lesson (every requirement gets a verdict; plans cannot narrow acceptance) is kept without criterion records (captain posture, 2026-10-02) |
| Unverified external boundaries (UNF-608/614, captain option A) | KEEP | reviewer rule 5: name, verify by docs, else non-blocking `needs_live_validation` | |
| Parallel CI and review (ADR-0032) | KEEP as behavior | Sergeant starts review at once; M5 and M6 are independent | No deterministic ordering needed |
| Reviewer evals (UNF-428), scenario corpus | KEEP (manual) | re-pointed at the S2 review brief when a controlled comparison is wanted (06 §9) | |
| Implementer, simplifier, full-system evals (UNF-429/430/433) | SIMPLIFY | implementer evals re-pointed at the worker brief; simplifier dropped; full-system eval becomes S2 replay (§4) | |

### Execution, workspace, GitHub

| S1 concept | Class | S2 form | Why |
|---|---|---|---|
| Provider-neutral control plane (ADR-0001) | KEEP | small runner contract + optional capabilities (04) | Captain round 1: neutral, not lowest common denominator |
| Worker adapter process records, re-adoption, interrupted resume (ADR-0040 restart survival) | MOVE TO RUNNER | adapters own re-adoption; Sergeant only calls `status` | The lesson (workers outlive the daemon) stays |
| Drain as quiesce (ADR-0040) | KEEP | `POST /v1/drain` | |
| Workspace ownership, retained Task worktree, observation worktrees (ADR-0018/0019/0031) | MOVE TO RUNNER | disposable per-run workspace; continuity by pushed branches | P4: redo beats recovery machinery |
| Bare repo cache | MOVE TO RUNNER | adapter cache, never correctness-bearing | |
| Stow and reclaim (ADR-0034), `sgt/recover/*` branches | DELETE | workers push WIP regularly (rule 3) | |
| Build cache hygiene (UNF-699) | MOVE TO RUNNER | adapter-owned, capped cache on the data volume | |
| Sergeant pushes candidates; credential-free staging push (ADR-0020 + amendment) | MOVE TO RUNNER | the worker pushes with the worker App | The planted-hook risk disappears because the control-plane credential never runs in a worker-writable place |
| PR creation and PR body content (UNF-538) | MOVE TO RUNNER | the worker writes a self-contained PR body (rule 4) | |
| `Fixes UNF-###` (UNF-697) | KEEP, refined | closing reference only on the PR that completes the issue; `Part of` on the rest | Multi-PR tasks must not close early |
| Merge | KEEP in Sergeant | `merge_pr` with M1–M10 | One of the four invariants |
| GitHub App identity (ADR-0017) | SIMPLIFY | two Apps per installation: control plane and worker | Rulesets need a separate actor for workers |
| Worker account selection by quota (ADR-0036) | MOVE TO RUNNER | inside the Claude adapter | |
| Worker environment allow-list (UNF-650) | KEEP | adapter launches with an explicit environment, in a runner zone separate from the control plane | The hard boundary |
| Capabilities and executors (ADR-0037), `[tools]`, `sgt tool configure`, persona-eval executor | DELETE | workers get dev credentials directly; an eval-only credential, if needed, is ordinary runner-zone authority; evidence integrity (did the candidate change the evaluator?) becomes a reviewer check | Captain: no capability mediation without a concrete material failure. Revisit only if paid-eval spend or tampering becomes real |
| Repo-owned `sergeant.toml` (ADR-0014) | DELETE | workers read `AGENTS.md`/README | Topology and commands are the worker's to discover |
| Context snapshots (ADR-0018) | SIMPLIFY | brief artifacts and Situation Reports in S3 | |

### Persistence, operations, security

| S1 concept | Class | S2 form | Why |
|---|---|---|---|
| SQLite (ADR-0003), single process + flock (UNF-567) | KEEP | | |
| V2 data model (10 tables + JSON sub-documents) | SIMPLIFY | 5 tables (02) | |
| `events` table | DELETE | `turns` + `actions` + run timestamps | |
| `task_inbox` | DELETE | Linear read each turn; a conversation revision on merge and completion (03 §5) | |
| `outbox` | SIMPLIFY | `actions` with idempotency keys | |
| `artifacts` table, object storage (ADR-0010) | SIMPLIFY | S3 keys on owning rows | |
| `workspaces` table | DELETE | | |
| `managed_repositories` table (ADR-0028/0029) | SIMPLIFY | enrollment in SSM config | ADR-0042 already treated it as configuration |
| `worker_accounts` table | MOVE TO RUNNER | | |
| `system_state` autonomy pause | KEEP | `pause` | |
| Fault watchdog, `faults_json`, `health_json` (ADR-0033/0035) | SIMPLIFY | run reconcile + `health.consecutiveTurnFailures` + escalation | |
| Safety governor (escalation windows, start windows) | SIMPLIFY | Gate rate limits (C1, E1, B3) | |
| Leases (ADR-0009) | DELETE (already gone) | | |
| Redaction, threat model §9 | KEEP | | |
| Permissions model (ADR-0008, `permissions.rs`, unwired) | DELETE | | Never had a caller |
| Org tenancy (ADR-0004) | DELETE (already gone) | installation = tenant | |
| Attention and escalation policy (ADR-0015) | KEEP in spirit | concise Linear (P9, 07 §3) | |
| Linear as only task source (ADR-0005/0012) | KEEP | | |
| Linear OAuth CLI identity (ADR-0024), public API (ADR-0028) | KEEP | | |
| `sgt admin` over SSM (ADR-0027) | KEEP | | |
| Installation identity (ADR-0040), configuration in AWS (ADR-0042), releases pulled (ADR-0043) | KEEP | 10 | Recent captain decisions |
| Rust (ADR-0002) | DELETE | TypeScript | Captain decision |
| AXI CLI standard (ADR-0015-axi) | KEEP | `sgt` output conventions | |
| Testing layers, `isolated_command`, daemon harness, `/health/loops` gate (UNF-482/554/555/556) | KEEP in spirit | same three layers for S2 (§4) | |
| File-size standard | KEEP in spirit | | |

## 2. ADRs explicitly abandoned or changed

| ADR | Sergeant 2 position |
|---|---|
| 0001 provider-neutral control plane | **Kept**, but Sergeant no longer owns "the implementation/review/test workflow". Its stated ownership list shrinks to dispatch, review policy, escalation, budgets, and status |
| 0013 Task/Run simplification | **Kept in spirit and pushed further**: its principle ("model only the runtime state Sergeant must persist, recover, reconcile, or enforce") is exactly the P3 test. Its partial reversal by ADR-0031 is undone |
| 0031 Coding V1 lifecycle | **Abandoned**: phases, typed waits beyond the human question, workspace retention, one-repo rule, Sergeant-owned repair. Kept: blockers gate admission; questions live on the original issue; no recursive decision issues |
| 0037 capabilities and executors | **Abandoned**. Its distinction between authority isolation and evidence integrity survives as a reviewer check |
| 0038 planner-first repo selection | **Abandoned**: no planner run; Sergeant chooses repos directly from purposes and asks the worker to report missing ones |
| 0039 worker-decided review | **Kept**, with the audit review made nonblocking |
| 0040 restart survival / installation identity | **Kept** (both) |
| 0041 reviewer rules, CI is the gate | **Kept** (rules: a verdict on every requirement, trade-offs traced, numstat evidence); AC-section parsing and stable ids dropped |
| 0042 configuration in AWS | **Kept**; enrollment stays in config |
| 0043 installations pull releases | **Kept** |
| 0018/0019/0020/0034 workspaces and pushes | **Abandoned** (runner-owned) |
| 0022/0025 retry and rethink loops | **Abandoned** (Sergeant's judgment within budget) |
| 0008 permissions | **Abandoned** |
| 0014 `sergeant.toml` | **Abandoned** |

## 3. What we give up

Honest costs of the supersession:

- **Deterministic replay of "why did it do that?"** S1's next step was a pure function of state. S2's
  is a model decision; we keep its inputs (Situation Reports) and outputs (turns, actions) for audit
  and replay, but not determinism.
- **Guaranteed review of every first candidate**: S2 trusts the worker's call plus sampling, as S1 did
  after ADR-0039.
- **Workspace retention**: a lost worker loses unpushed work. Accepted (P4).
- **Fine-grained evidence integrity for paid evals** (ADR-0037's executor): replaced by a reviewer check.
- **Proven S1 edge-case handling** (conflict repair ahead of review, phase-mismatch recovery, survivor
  processes). Each scenario in `12` maps the edge case to judgment, an adapter duty, or a Gate rule;
  some will resurface as bugs and should be fixed in the smallest home.

## 4. Evals and tests carried forward

- **Implementation and testing guidance:** `v2/AGENTS.md` is authoritative, including risk-based
  validation with no blanket test requirement or coverage target.
- **Sergeant replay evals**: recorded Situation Reports (S3) replayed through a new prompt or model,
  scored on decisions (did it start review when it should, ask when it should not, merge only what it
  should). Includes the **fresh-start drill** (03 §8): replays with a fresh session must reach the same
  decisions as with the persistent one.
- **Worker evals**: S1's implementer-eval scenarios re-pointed at the worker brief and report.
- **Reviewer evals**: manual, re-pointed at the S2 review brief when wanted (06 §9).

## 5. Transition plan

The captain's direction: reversible, without coexistence becoming a permanent subsystem.

The final Sergeant 1 source baseline is the annotated tag `v1-final`, which points to commit
`aad6046473d1d338bae1cdeaaf7f2c8cf6f1fa6a`. Use `git show v1-final` to inspect that baseline or
`git switch --detach v1-final` for a reference checkout. Its installable immutable release is
`v0.1.0+aad6046`; rollback an installation with
`sgt admin upgrade <installation> --release v0.1.0+aad6046`, then restore the preserved V1
configuration and SQLite file. The source tag remains the reference for the historical deployment
code and runbooks if the older operator path is needed.

| Step | What | Exit criterion | How to reverse |
|---|---|---|---|
| 1 | Finish this package; independent fresh-context review; apply it under the captain's review posture; captain review | captain approves the design | — |
| 2 | Tag the final Sergeant 1 state (`v1-final`) and its last immutable release; set Personal's upgrade policy to `manual` so no V2 artifact is pulled by accident | tag and release exist; policy confirmed | — |
| 3 | Build the **thin path** (§6) in the `v2/` workspace (UNF-700: Turborepo/pnpm, oxlint, Vitest, its own path-filtered CI; V1's CI skips `v2/**`): one delegated issue → reasoning → one worker → PR → fresh reviewer → merge → Linear completion, with only the hard controls that path needs. UNF-704 verified the GitHub → Linear completion behavior first on a sandbox repository and team (07 §7, `14` V2). | scenarios 1 and 2 pass as process tests with fake Linear, GitHub, and runner; the completion behavior is recorded as observed | delete the skeleton |
| 4 | Run the thin path on the captain's laptop as its own installation identity, with its own Linear agent user ("Sergeant 2") and GitHub Apps on selected Personal repositories; runs in a container (10 §5). This is first real use, deliberately early | V2 completes a few simple real Personal issues end to end | stop delegating to "Sergeant 2"; V1 is untouched |
| 5 | Grow it incrementally on the laptop, one increment at a time (§6), each with its scenarios added to the process suite: human questions, cancellation, budget enforcement, multi-repo, audit reviews, restart cases, and the rest. The full 15-scenario suite is the **destination**, not the admission ticket to first use | the 15 scenarios pass; captain judges V2 better on the real tasks tried (including a review that changes code, an audit review, a human question, and a time-budget stop); review telemetry recording | drop the increment; as step 4 |
| 6 | Replace Personal's V1 with V2: drain V1, let in-flight tasks finish or undelegate them, keep V1's SQLite file and config version, `sgt config set` the V2 config, `sgt admin upgrade --release <v2 tag>`; retire the laptop identity | V2 runs Personal; `/health/loops` gate passes | reinstall the immutable release associated with `v1-final` (`v0.1.0+aad6046`; ADR-0043 rollback), restore the previous SSM config version, restore the kept SQLite file, re-delegate |
| 7 | Keep the V1 tag and history as the escape hatch; delete V1 code from main once V2 has carried real work for a while | captain says delete | check out the tag |

Not in this plan: a long-term dual architecture, a compatibility layer, data migration from V1's
database (V2 starts with an empty ledger; Linear and GitHub carry the history), or Terros moving before
Personal has run V2.

## 6. Implementation slices

Logical groups for the later backlog, with the contract each one provides. No tickets are created here.

| # | Slice | Provides | Depends on |
|---|---|---|---|
| 1 | **Contracts and fakes** | the 01 types as Zod schemas (TypeScript types inferred from them); Zod tool and action schemas; the Gate as pure functions with a test per rule (03 §7, 06 §6, 08 §7); fake Linear, fake GitHub, fake runner; a scenario harness that runs 12's scenarios | — |
| 2 | **Ledger and Effector** | the five tables (02 §3); actions with idempotency keys; closing steps and re-drive (03 §10); startup sequence (02 §8); a missing ledger starts paused | 1 |
| 3 | **Linear integration** | intake, admission, and reconcile (07 §5); comment reading and the conversation revision (03 §5); questions and the human wait; concise comments; attachments; delegation removal; client-id idempotency (verify V1) | 1, 2 |
| 4 | **GitHub integration** | PR and CI facts with `missing` / `not_run_conflict` (08 §6); PR association via attachments; merge with M1–M10; `sgt doctor repo`; the completion-behavior probe (07 §7) | 1, 2 |
| 5 | **Runner platform and the Claude adapter** | the runner contract (04 §2); the runner zone (separate OS user; container on a laptop); credential vending; reconcile with unknown ≠ lost and cancel retries (04 §6); usage; report transport | 1, 2 |
| 6 | **Reasoning turns** | Situation Report assembly from 3–5; read and action tools; scheduler and wake reasons; prompt v1; turn limits; sessions and compaction (03 §8) | 2–5 |
| 7 | **Primary-worker protocol** | brief rendering and the worker rules (05); report parsing; one primary worker (R1); `continueFrom`; handoff; repository requests | 5, 6 |
| 8 | **Review** | review briefs and separate reviewer runs; dispositions D1–D6; audit sampling; `ReviewFacts`; `sgt review quality` | 4, 5, 7 |
| 9 | **Budgets and operations** | BudgetMeter (hard time and concurrency, best-effort spend), `enforce_budget`, grants; pause and drain; `/health/loops`; CloudWatch; the `sgt` commands and APIs in 11 | 2, 5, 6 |
| 10 | **Evals** | reasoning replay evals with the fresh-start rubric (03 §8); worker evals and (manual) reviewer evals re-pointed at the S2 briefs | 6–8 |
| 11 | **Transition** | `v1-final` tag; distinct V2 release tags; the laptop installation (identity, Linear agent user, Apps, container); the Personal replacement runbook and a rollback rehearsal | 1–9 |

Slices are logical groups, not a build order. Delivery follows the transition plan (§5): a thin
vertical path first, then increments, each landing on a system already in real use.

**The thin path** (steps 3–4): one delegated issue → a reasoning turn → one primary worker → a PR → a
fresh reviewer run → merge → Linear completion by automation. It takes the minimum of slices 1–8 that
path touches, and only the hard controls that path needs:

- the merge rules (M1–M10: green required checks on the exact head, a review disposition for that head,
  the PR linked to the task, the repository's merge policy, the conversation revision unchanged);
- one worker per task (R1) and a per-run wall-clock limit with cancellation;
- the runner zone and credential vending, so no run holds production, admin, personal, or
  control-plane authority (on the laptop, a container);
- the installation pause as the operator's stop;
- idempotency keys for starting runs and merging.

**Increments** (step 5), roughly in this order, each a small change with its own scenarios: human
questions and the `HumanWait` (8); cancellation, undelegation, and closing steps (13); budget
enforcement and grants (10); CI repair and moving bases (5, 14); review iterations and acceptance
findings (3, 4, 15); multi-repository tasks (6); audit reviews and review telemetry (06 §8–9); restart and
unreachable-runner cases (7, 9); distraction and security handling (11, 12). Cloud adapters, Codex, Jev,
and anything in 06 §9's "later" come after the full suite passes.

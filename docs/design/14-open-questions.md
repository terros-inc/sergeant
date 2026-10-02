# 14 — Decision register

One register for every consequential choice. §A records what is settled and where the package applies
it. The single `## Captain Questions` section holds what is genuinely unresolved. §C lists contradictions
and unresolved tensions. §D lists facts about external systems to verify. §E lists defaults chosen without
asking. §F records the independent architecture review's findings and what changed; §G records the
captain's review of draft 3 and what changed.

## A. Settled

### By the captain

| Decision | Applied in |
|---|---|
| No separate Supervisor actor: **Sergeant** is the whole system; **reasoning** is its AI component | everywhere; 00 §3 |
| Sergeant does not write code; it manages | 00 P5, 03 §1 |
| One primary worker per task; parallel engineering via the worker's own subagents | 03 R1, 04 §8 |
| Sergeant chooses each task's repository set; the worker may change all of it and open several PRs; no per-repo lifecycle | 01 `RepositorySet`, 03 RS1, 04 §9, 08 §4 |
| Only Sergeant creates Linear issues; workers suggest follow-ups | 03 F1–F3, 05 rule 12, 07 §11 |
| The required review is a separately launched fresh-context reviewer run; review and CI run in parallel; tiny fixes may skip re-review, material changes get a fresh one | 06 §1–7 |
| Worker-launched subagent reviews are measurement-only; no preset threshold; Firstmate brings the comparison to the captain later | 06 §5, §9 |
| Review-need policy: no hard thresholds; if in doubt, review ("80/20, not 99/1"); an occasional wrong skip is an accepted cost; track over- and under-review | 05 §5, 06 §1, §9 |
| UNF-641 calibration preserved, with **nonblocking** audit reviews | 06 §8 |
| Review quality is a first-class product metric; keep enough telemetry (provider, model, mode, findings, must-fix, resulting mutations) to compare same- and different-vendor review; no experiment framework yet | 06 §9, 01 `ReviewFacts` |
| Sessions may persist; automatic compaction; correctness never depends on the session; no private memory system | 03 §8 |
| Minimal local task state; a human wait means "waiting for the answer to this Linear question" | 01 `Task`, `HumanWait`; 02 |
| Budgets of about 2 h and about $25, configurable; coarse guardrails; wall-clock, concurrency, and cancellation hard; spend best-effort | 01 `Budget`, 04 §7 |
| Completion follows real PR → Linear automation; an assumption verified in the walking skeleton; no compensating architecture in advance | 07 §7 |
| Provider neutrality with a small common contract and optional richer capabilities | 04 §2 |
| Jev optional and evidence-driven | 03 §11, 09 §8 |
| Linear concise; details to S3; logs to CloudWatch | 02 §5, 07 §3 |
| Transition: review package → tag V1 → a thin vertical path → the laptop early → incremental growth to the full scenario suite → replace Personal → keep the V1 tag | 13 §5–6 |
| V2 code lives in an isolated `v2/` TypeScript workspace in the existing repository (Turborepo/pnpm, oxlint, Vitest, path-filtered CI; V1's CI skips `v2/**`) (UNF-700) | 10 §6, 13 §5 |
| Zod is the schema library from the first code: types are inferred from Zod schemas, and every external input (worker/reviewer reports, proposed actions, Linear/GitHub payloads, config) is validated with Zod before use (captain, 2026-10-02) | 01, 05 §6, 13 §6 |
| Review posture: no formal guarantees against every agent failure; deterministic machinery only for material harm Sergeant must prevent; otherwise re-read, take another turn, retry, or redo. No per-task OS isolation, leases, acceptance-criterion records, distributed transactions, billing ledger, or capability mediation without a concrete material failure | 00 P3, §2; 02; 04; 09 |
| The "what happens if we lose it?" test; the four material harms as a simplicity target, not a fixed taxonomy | 00 P3, 01, 02 §1, 03 §7 |
| No durable per-comment bookkeeping: merges and completion carry a conversation revision the Gate re-checks against Linear; the `HumanWait` is kept only for an open Sergeant question | 01, 03 §5, 07 §4, 08 M10 |
| Workers and reviewers get every human-authored comment, bounded only by size with pointers to the full thread | 01 `TaskExcerpt`, 05 §2, 06 §2 |
| No ledger backup or restore: a missing ledger starts paused and an operator decides; lost budget and audit history are accepted | 02 §9 |
| Simplicity principle for every agent working in Sergeant 2 | `AGENTS.md` |

### By Firstmate, under the question-handling rule

These were open in draft 2. Each is answered by a recorded captain decision or principle, so none is a
Captain Question.

| Was | Answer | Why it is settled |
|---|---|---|
| Who merges where merging to main deploys to production | Per-repository `mergePolicy`: `human` for repositories whose default branch auto-deploys to production, `sergeant` elsewhere | The hard boundary excludes production authority; a merge that deploys is production authority |
| Who may delegate, answer, grant budget, waive review | Anyone in the allowed Linear teams delegates and answers; configured approvers grant budget, waive review, and receive escalations | Budget and waivers are the human authorities the Gate relies on; everything else follows "Linear is the human surface" |
| Reasoning runtime | A plain model tool-use loop with Sergeant-defined tools and Sergeant-managed sessions, behind a thin interface so the model is swappable; a provider agent SDK only if it honors 03 §8's contract | Small auditable tool surface; provider neutrality (P12) |
| Separating runners from the control plane | One shared runner zone: a separate OS user with the metadata endpoint blocked on the host, a container on the laptop; no per-run isolation | The captain's posture: per-task isolation is not a requirement; the control-plane boundary is |
| Auto-delegating follow-ups | Per-installation setting: on for Personal (depth 1, at most 3 per task), off for Terros at first | The captain's UNF-625 direction ("don't make a human do bookkeeping"), bounded for fan-out |
| Workflow-file changes | The worker App has no `workflows` permission; a needed CI change ends `blocked_by_environment` for a human | Editing a PR workflow could expose repository secrets, a production-boundary risk |
| Paid evals (S1's persona-eval executor) | No executor; an eval-only credential, if needed, is ordinary runner-zone authority, with evidence integrity as a reviewer check | The posture: no capability mediation without a concrete material failure |
| The laptop trial's identity | Its own installation identity (second region or account), its own Linear agent user and GitHub Apps, runs in a container | Consequences of ADR-0040 and the personal-credential boundary, not a product choice |
| "About 2 h of task wall time" | Active time: the union of time with a run going; waiting for humans or CI does not count | S1's active budget did the same; calendar time would exhaust a task waiting on a human |

## Captain Questions

No Captain Questions. Every open choice from draft 2 and the independent review is either settled by the
captain's own decisions (round 1, UNF-700, the 2026-10-02 clarifications) or follows from them under the
question-handling rule (§A). The one review-raised question (what evidence lets worker-launched subagent
reviews satisfy the required review) was already settled by the captain as measurement-only, with a later
decision once data exists.

## C. Contradictions and unresolved tensions

**C1. Nonblocking audits reverse an earlier captain choice.** ADR-0039 records that the captain replaced
a non-gating shadow audit with a *gating* one. Round 1 says nonblocking, and the package follows it. An
audit that finishes after the merge reports on code already in main; a guardrail comments on the closed
issue (06 §8).

**C2. Strong review intent, relaxed review enforcement.** Review is called one of the most important
requirements, yet the review-need policy accepts occasional wrong skips, and the shared runner zone means
a reviewer's read-only token is a convention rather than a boundary. Both are deliberate (captain,
2026-10-02); the package relies on telemetry (06 §9) to show whether that balance is right.

**C3. Completion by automation vs. Sergeant deciding the outcome is achieved.** Sergeant controls
completion only through which PR carries `Fixes` and when it merges (M9). A human or an early closing PR
can complete the issue while work remains; the human's or automation's state wins (07 §7). The `Part of`
behavior is unverified until the skeleton's first probe.

**C4. "Lean on Linear" vs. "never silently ignore a comment".** Resolved toward Linear (§G): no local
record of handled comments. The ledger keeps only the conversation revision each turn saw, and the Gate
compares it with Linear at merge and completion. The cost is that "seen" is not "understood": a turn
that saw a comment may still misread or ignore it. That is judgment, measured by evals, not gated.

**C5. Persistent sessions vs. correctness from authoritative state.** Every turn still carries the current
Situation Report, so a persistent session saves rationale, not facts. The efficiency gain may be modest.

**C6. The spend budget is not a cap.** Captain-sized at $25, but enforced only where usage is observable
and blind to dev/stage resources, CI, and separately billed tools. Wall-clock is the real backstop.

**C7. Repository-set scoping is advisory between runs.** The captain wants Sergeant to choose each task's
repositories, and tokens are scoped to that set, but co-resident runs can use each other's tokens. The
set guides workers; it does not contain them (09 §4).

**C8. A busy conversation can delay a merge.** M10 and X5 refuse whenever the conversation changed since
the proposing turn, so a thread that keeps changing makes reasoning re-decide each time before it can
merge. Accepted: each refusal costs one turn, and a human conversation rarely keeps changing for long. No
merge waits on a comment reasoning cannot interpret any more; reading it is enough to proceed.

**C9. `Fixes UNF-###` on every Sergeant PR (UNF-697)** would close a multi-PR issue at the first merge.
Refined: only the completing PR carries it; the others say `Part of`.

**C10. The laptop trial's container.** On the laptop, runs need a container to stay away from the
captain's personal credentials, while on the EC2 host a separate OS user suffices. Two runner-zone
mechanisms, both small.

## D. Verification items (facts to check, not decisions)

| Id | Check | When | If false |
|---|---|---|---|
| V1 | Linear accepts a client-supplied id on comment and issue creation, and a duplicate id fails as a conflict | slice 3 | issue creation looks up the semantic key first; a rare duplicate comment is accepted |
| V2 | **Verified (UNF-704):** `Fixes` creates a `closes` attachment and closes on merge; `Part of` creates a `contributes` attachment and does not close | 2026-10-02; evidence in 07 §7 | no compensating machinery needed |
| V3 | Linear's agent activity panel API, for turn summaries | slice 3, optional | comments only |
| V4 | A non-bypass GitHub App cannot merge into a protected default branch through the API; installation tokens can be scoped to repositories and permissions and revoked early | slice 4 | branch protection "restrict who can push" listing the control-plane App |
| V5 | Claude Code headless: resume, a steering mechanism for mid-run messages, fresh subagents, usage reporting | slice 5 | the adapter declares fewer capabilities; reasoning adapts (04 §2) |
| V6 | Codex CLI: resume and usage reporting | after the skeleton | Codex as reviewer only |

## E. Defaults chosen without asking

- Budget: 2 h active time (hard), $25 including reasoning turns (best-effort), soft at 80%, 10-minute
  wrap-up grace, $2 reasoning reserve, 2 concurrent reviewers, 6 run starts per hour.
- Reasoning: $1.50, 300 s, and 40 tool calls per turn; 4 h maximum sleep; compaction at 60% of the
  context window; a fresh session after 3 compactions.
- Liveness: reconcile every 60 s; idle or unreachable wake after 20 min; unknown status never becomes
  "lost".
- Linear: at most 6 Sergeant comments per task per hour; one blocking question at a time, at most 3 open
  in all; reminder after 24 h.
- Review: audit sample 0.2.
- Follow-ups: at most 3 per task, depth at most 1.
- Enrollment in SSM configuration; PR association in Linear attachments.
- One daemon per ledger; SQLite (no backups); S3 for artifacts; CloudWatch for logs; a missing ledger
  starts paused.
- Branch convention `sergeant/<IDENTIFIER>-<slug>`.

## F. Independent architecture review: findings and changes

An independent fresh-context review of draft 2 (report not published here; disposition "keep the
central architecture, redesign the safety seams"). Applied under the captain's review posture (2026-10-02), which
classifies each finding:

- **DESIGN BUG**: internally inconsistent, or violates a settled captain decision.
- **HARD-BOUNDARY RISK**: can cause a material outcome Sergeant must prevent.
- **ACCEPTED OPERATIONAL RISK**: real, intentionally tolerated for simplicity.
- **MEASURE / PROVE**: uncertain; evaluate empirically rather than architect around now.

Only the first two block.

| Finding | Class | What changed |
|---|---|---|
| F01 shared runner user defeats repo scope, reviewer read-only, freshness | ACCEPTED OPERATIONAL RISK, with a DESIGN BUG part | Per-task isolation is not a requirement (captain). Fixed the inconsistent claims: 06 no longer says a reviewer *cannot* see a worker's workspace; freshness is independence of reasoning; 09 states the shared zone and its blast radius literally; cloud identities must meet the hard boundary (no production or admin authority, no ruleset bypass, enrolled repositories only) |
| F02 a merge may ignore a human edit or comment after the reviewed snapshot | HARD-BOUNDARY RISK (an abandoned human decision) and DESIGN BUG (auto-acknowledging uninterpreted comments) | M10: merges re-read Linear and are refused if the issue changed since the turn's snapshot or any human comment is unhandled; X5 likewise for completion. The three-failure auto-acknowledge is removed. No locking. (Per-comment handling later replaced by a conversation revision, §G) |
| F03 acceptance evidence cannot represent scenario 15; Sergeant could narrow acceptance | DESIGN BUG | Reviewers file every unmet or contradicted requirement as a blocking finding; the parser adds one if missing; D3 forbids accepting an acceptance finding as non-blocking; narrowing goes to the human. No acceptance-criterion records; workers and reviewers get the issue verbatim |
| F04 ten minutes of unreachability treated as death | DESIGN BUG | Unknown is never lost; status and cancellation are retried; replacement is reasoning's choice after a cancel request (R1); duplicated work accepted. No leases |
| F05 spend not enforceable; ledger loss resets authority | DESIGN BUG (overclaiming) and ACCEPTED OPERATIONAL RISK | Spend is described as best-effort everywhere; time, concurrency, and cancel are hard. Ledger loss is rare: backups to S3, and a missing ledger starts paused. No billing ledger. (Backups later dropped, §G) |
| F06 composite actions cannot be atomic | HARD-BOUNDARY RISK (a human's stop turning into a restart) and DESIGN BUG (11 claimed atomicity) | Closing actions have ordered, idempotent steps, re-driven until done, with the ledger row closed last. Robust dedupe only for externally harmful duplicates (02 §6) |
| F07 the review-quality experiment is not executable | MEASURE / PROVE | Experiment framework removed; telemetry and over-/under-review metrics kept; subagent reviews measurement-only; the "within noise" rule removed |
| F08 interfaces and keys disagree | DESIGN BUG | One `grant_budget` action; report revisions defined; one runner API path; typed budget asks (`purpose`); task id in disposition and merge keys; liveness config keys; scalar aliases; drain declared process-local |
| F09 the Gate is not mapped to the four harms | DESIGN BUG | Every rule names the harm it prevents (03 §7); the eight-repository cap, empty-set rule, size checks, and open-PR completion rules removed; M10 and X5 added |
| F10 blast radius incomplete | DESIGN BUG | 09 §9 rewritten as literal capabilities: all granted repositories and dev/stage, spend outside the model budget, tokens until expiry, unreviewed merges on a wrong skip |
| F11 completion rests on an unverified fact | MEASURE / PROVE | Verified by UNF-704's sandbox issue/PR probe (07 §7); no compensating architecture needed |
| F12 compaction validation underspecified | MEASURE / PROVE | The Situation Report is described as a bounded snapshot with history pointers; a fresh-start eval rubric scores preserved constraints, not identical actions (03 §8) |

## G. Captain's review of draft 3 (PR 345): findings and changes

The captain's review found the overall direction strong and materially simpler than Sergeant 1, with one
main concern: some evaluator findings had been answered with durable bookkeeping that starts to recreate
a workflow engine. Classified under the same posture:

| Finding | Class | What changed |
|---|---|---|
| G01 per-comment dispositions (`handled_comments`, `CommentDisposition`, `ack-comment`, coverage retries and escalation) are workflow state | DESIGN BUG (violates the posture: re-read authoritative state rather than persist semantic state) | Replaced by a `conversationRevision` (issue title and description, every human comment's id and `updatedAt`) in the Situation Report. Merge and completion carry the proposing turn's revision; M10 and X5 re-read Linear and refuse on a change, waking a fresh turn. Every Linear change wakes a turn, and the intake reconcile wakes any task whose revision differs from its last completed turn's, so human input is never silently dropped (L4). `HumanWait` remains only for an open Sergeant question, cleared by `TurnDecision.answeredQuestion`. The accepted race is unchanged |
| G02 "relevant human comments" in briefs lets a component filter out a requirement | HARD-BOUNDARY RISK (acceptance narrowed; the F03 hole) | Briefs and review briefs include every human-authored comment verbatim. Very long threads are bounded by size alone: newest inline, a pointer per older comment, and the complete thread delivered beside the brief (05 §2) |
| G03 `cancel-task:<taskId>` in 11 contradicted the single closing key | DESIGN BUG | `close:<taskId>` everywhere, so a task has at most one pending closing action |
| G04 S3 ledger backup and restore is recovery machinery | DESIGN BUG (machinery for an accepted operational risk) | Dropped. A missing ledger starts paused; an operator inspects Linear, GitHub, and runners and decides; lost budget and audit history are accepted (02 §9) |
| G05 requiring slices 1–8 and all 15 scenarios before the laptop recreates S1 on paper before learning | DESIGN BUG (sequencing against "very small walking skeleton") | First real use is one thin vertical path (issue → reasoning → worker → PR → fresh reviewer → merge → Linear completion) with only the hard controls it needs; questions, cancellation, budget enforcement, multi-repo, audit reviews, and restart cases follow incrementally. The full scenario suite is the destination (13 §5–6) |

# ADR-0037: Capabilities and executors — workers express intent, Sergeant owns authority

## Status

Accepted (UNF-621). Documentation only: it names the model the existing repo-tool path (UNF-360,
UNF-361, UNF-362) already follows and fixes the constraints UNF-613's `persona-eval` capability
must follow. It changes no code or schema.

Implemented for `persona-eval` by UNF-613; see "Implementation (UNF-613)" below for the choices this
ADR left open.

## Context

Two lines of work produced the same authority rule independently:

- **Repo tools.** UNF-360 let a repository request a logical tool by name (`[tools] allowed =
  ["life-axi"]`) while refusing any command, auth, or credential field. UNF-361 put the name →
  command mapping and the tool's own login state on the installation side. UNF-362 exposed a
  configured tool to a Run through a wrapper on the worker's `PATH`.
- **Live evals.** Workers and reviewers sometimes need evidence that ordinary local tests cannot
  produce (real model calls, scored persona evals). Handing a worker broad model/AWS/GitHub
  credentials because a Linear task asked for evidence would move authority to the least-trusted
  actor (`docs/security/threat-model.md` §2).

Without one written model, each new need (the next eval, a remote worker VM, a sub-agent service)
risks inventing its own authorization path. This ADR records the model once so later work extends
it rather than running beside it.

## Decision

### Core principle

> **Workers get capabilities, not credentials.**

This is an architectural/API rule about what a worker is *granted* and what it may *select*. It is
not a claim that an executor can never place a credential inside a process. An executor may
internally use a bounded credential (for example an eval-only model key inside an ephemeral worker
VM). The worker asks for `persona-eval`; it never chooses, enumerates, or receives the
installation's credential inventory.

### The model

Deliberately small, five rules:

1. **The repository requests capability names.** Repo-owned `sergeant.toml` may name a logical
   capability (`life-axi`, `persona-eval`). It cannot define credentials, commands, arguments,
   workflow names, host authority, or privilege. `repo_config::ToolsConfig`'s
   `deny_unknown_fields` already enforces this for `[tools]`.
2. **The installation authorizes capabilities.** The Sergeant installation decides which requested
   names actually exist, for which repository, within which bounds, and how they execute. A name
   the installation does not authorize is simply unavailable to the Run. It is never a fallback to
   something broader.
3. **A Run receives a bounded capability set.** The worker's prompt and API expose only the
   capabilities resolved for that Run, each with a status and remediation when it is not usable.
   The set is recorded in the Run's context snapshot for provenance.
4. **Each capability has an executor.** The executor is an installation-owned implementation
   detail: a local tool, a GitHub Actions workflow, an isolated VM, a sub-agent service. The
   worker cannot see or choose it.
5. **Sergeant owns authority; executors own mechanics; workers express intent.**

```
Linear task
   ↓
Sergeant            — resolves repo request × installation authorization → Run's capability set
   ↓ grants capability
Worker              — sees capability names + purpose + status, never credentials or executor
   ↓ requests operation (intent + bounded inputs)
Capability          — Sergeant derives repository, candidate SHA, executor, bounds from trusted state
   ↓
Executor            — local tool | GitHub Actions | isolated VM | future service
```

This is the UNF-349/UNF-360 rule, **"repo may request; installation must authorize"**, extended
by one step: the thing that gets authorized is carried out by an installation-chosen executor, and
the worker only ever holds the capability.

### How current repo tools fit

Today's `[tools]` path is already this model, with one executor kind ("local tool"):

| Model step | Current implementation |
|---|---|
| Repository requests | `[tools] allowed = ["life-axi"]` → `repo_config::ToolsConfig` (UNF-360); command/auth/token/credential fields fail to parse |
| Installation authorizes | Installation installs the binary on the daemon host's `PATH` (optionally `SERGEANT_TOOL_<NAME>_COMMAND`); the Task's assigned human authorizes their own scope with `sgt tool configure` (UNF-361). `tool_config::resolve_run_tools` combines the two into `Ready` / `Unconfigured` / `ExecutableNotFound` |
| Run's bounded set | `ContextSnapshotBody::available_tools` (UNF-362): name, status, installation-side purpose (`tool_config::tool_description`), remediation. Never a command or credential |
| Executor | Local-tool executor: `tool_config::write_tool_launcher` writes a per-Run wrapper that execs the installed binary with the `(human, repo, tool)`-scoped isolated `HOME`; `orchestrator::dispatch` prepends it via `WorkerTask::extra_path_dirs` |
| Worker intent | The worker runs `life-axi …` by its logical name. It does not know where the binary lives or where its session state is |

One limit must stay explicit. On the V1 shared host, the local-tool executor gives the right
**authority shape** (the worker never selects a scope or credential; Sergeant resolves it from the
Task's assignee) but **no confidentiality**: the wrapper runs as the same OS user as the worker, so
the worker could read that isolated `HOME` directly. See `docs/security/threat-model.md` §10.
That is acceptable for a read-only diagnostic tool configured with the human's own login. It is
not acceptable for a capability whose credential is broader than what the worker may hold. Such a
capability needs an executor outside the worker's process/user context (see `persona-eval` below).

The existing `[tools]` table stays as it is. Renaming it to `[capabilities]` only for terminology
is a non-goal. In this model a "tool" is a capability whose executor is a local tool.

### How `persona-eval` (UNF-613) fits

`persona-eval` uses the same path. It does not add a parallel authorization system:

| Model step | `persona-eval` |
|---|---|
| Repository requests | The managed repository lists `persona-eval` in the same `[tools] allowed` list. It names no workflow, ref, credential, or command |
| Installation authorizes | Installation-side code, hardcoded and minimal for V1 like `tool_description`/`resolve_login_command` today, authorizes exactly one `persona-eval` for the exact managed repository, bound to the known hardened workflow (UNF-620) plus its bounds: known personas, a trial cap, and a per-Task dispatch cap |
| Run's bounded set | `persona-eval` appears in the Run's capability set with its purpose, status, and remediation like any other capability. Implementation, fix, and review Runs may all receive it |
| Executor | GitHub Actions in V1, dispatched by Sergeant under its own GitHub App identity (ADR-0017), never by the worker. The eval credentials live only in that workflow's environment |
| Worker intent | A narrow operation such as `run_live_eval(persona, scenarios, trials)`. Sergeant fills in repository, exact candidate SHA, workflow, and ref from trusted Task/Run/installation state, and rejects inputs outside the authorized bounds |

Resolution therefore dispatches **per capability name** to its executor. A local-tool name resolves
as today. `persona-eval` resolves to its own executor and does not need a human-scoped login,
because it runs under Sergeant's identity. This is a match on a known name, not a registry or
policy language.

Some parts are left to UNF-613 on purpose: the transport of the worker-facing operation (for
example a daemon route the worker reaches through a `PATH` wrapper) and the exact recorded
evidence. The one constraint here: **nothing in the worker-facing surface may encode the
executor.** No workflow names, run URLs to poll, or `gh` commands in prompts.

A review Run requesting `persona-eval` gets external evidence, not code-mutation authority.
Granting a capability never widens a role's other authority.

### Authority isolation and evidence integrity are separate concerns

These two properties must never be counted as each other:

- **Authority/credential isolation** answers *who can act*: the worker cannot select or obtain
  credentials beyond its granted capabilities, and an executor injects only the authority one Run
  needs.
- **Trusted-evidence integrity** answers *whether a result proves what it claims*. It matters for
  any capability whose result is used as acceptance evidence, even when credential isolation is
  perfect.

A perfectly isolated executor can still produce meaningless evidence if the candidate controls
the definition of success. So a capability used as acceptance evidence records, at minimum:

- the exact candidate repository and commit SHA;
- the trusted evaluator/harness revision, which is not assumed equal to the candidate's;
- the normalized inputs actually executed;
- the executor/run identity (e.g. the workflow run id);
- the result/artifact identity and conclusion.

The candidate may control the code under test. It must not silently control the definition of
success. If the candidate modifies the evaluator, harness, scenarios, or scorer, that fact is
surfaced explicitly (e.g. `candidate-modified-eval-definition`) and the result is not treated as
ordinary trusted proof. This evidence lives in the requesting Run's existing durable homes (its
events and artifacts, `docs/data-model.md`) and needs no new table.

A read-only diagnostic capability such as `life-axi` is subject to the authority rule but is not
itself acceptance evidence, so the integrity requirements apply only when a result is offered as
proof.

### Failure is explicit, never silent success

If a Task needs a capability's result and the capability is unauthorized, its executor is
unavailable, its bounds are exhausted, or trusted evidence cannot be produced, Sergeant surfaces an
explicit **unverified external boundary**. It never completes quietly without the evidence
(UNF-608's review rule). The existing `Unconfigured`/`ExecutableNotFound` statuses with a
remediation are the local-tool form of this.

### Remote-worker implication: executor neutrality

The model must still hold when workers move from shared-host processes to isolated VMs or
sub-agents:

- an executor may inject only the bounded authority that one Run needs;
- a worker VM never inherits the daemon's or installation's credentials (Secrets Manager access,
  the GitHub App key, provider accounts);
- destroying the worker environment removes its temporary authority, with no standing credential
  left behind to revoke;
- changing `persona-eval` from a GitHub Actions executor to a VM executor, or `life-axi` from a
  host `PATH` wrapper to something inside a VM image, must not require changing Linear tasks, repo
  capability names, or the worker prompt/API.

Remote execution is also what removes the shared-host confidentiality caveat above. The capability
model does not change; only the executor gets stronger.

## Implementation (UNF-613)

`crates/sergeant-core/src/capability/` holds the installation side; the daemon adds the worker-facing
route and client. The choices this ADR deliberately left open:

- **Authorization is one hardcoded grant** (`capability::persona_eval`): a single named
  repository and a fixed set of personas; a targeted request names a bounded number of
  scenarios and a bounded `trials` count, while a request with no scenarios runs main's approved
  workload and may not set `trials`; at most 4 live evals per Task across all its Runs; the model is
  never overridable. Executor binding: `persona-eval.yml` dispatched from `main`, reports artifact
  `persona-eval-reports-<run id>`. The request body is `deny_unknown_fields`, so naming a repository,
  commit, ref, workflow, or model fails to parse.
- **Resolved at dispatch, against the Run's own checkout.** `orchestrator::dispatch` reads the
  Run's `sergeant.toml` request there, so it works for GitHub-App-sourced repositories too.
  Local-tool resolution (`tool_config::resolve_run_tools`) skips installation-executed names. The
  result is recorded under `runs.resolved_context.capabilities` (grant, bounds, executor binding,
  and a token digest) rather than the context snapshot, which is written before the workspace
  exists. The prompt discloses the capability as `ready` or `unavailable` with its bounds and
  failure semantics, and never names the executor.
- **Transport: a per-Run launcher and a loopback route.** A ready Run gets a `persona-eval` script
  on its `PATH` (in the per-Run tool `bin` directory, never the worktree). It execs
  `sergeant capability persona-eval run|status|wait` with this Run's URL and a random per-Run token.
  The daemon's internal listener serves `POST`/`GET /runs/:id/capabilities/persona-eval/requests[/:request_id]`;
  the public API never mounts them. The token is an **accidental-routing guard, not per-Run
  authentication**. It lives in a file readable by the OS user every worker shares (threat model
  §10), so a hostile co-resident Run can read another Run's token and use it. Because Sergeant
  derives everything else, that Run gets only the other Run's evaluation of that Task's pinned
  candidate, within that Task's bounds. It can spend that Task's live-eval budget and read the
  results. It can never choose the repository, commit, ref, workflow, or model, or obtain a
  credential. The executor's credentials never reach any worker. Real per-Run authentication needs
  a per-Run process boundary. That is a separate captain decision, not built here.
- **The candidate comes from trusted workspace state.** A mutation Run's candidate is the committed
  tip of the Task's branch, and a request with uncommitted tracked changes is refused. An
  observation (review) Run's candidate is the exact commit its detached worktree was created at,
  even if the reviewer moves `HEAD`. A review Run gets evidence this way, never code-mutation
  authority.
- **The GitHub Actions executor publishes the candidate under a Sergeant-owned ref.** The hardened
  workflow can only evaluate a commit that some branch contains, so the executor pushes the exact
  SHA to `sgt-eval/<request id>`, never to the Task's candidate branch or its PR. It then dispatches
  with `return_run_details`. The repository's CI runs only for pull requests and `main`, so the ref
  triggers nothing on its own. The push runs from a Sergeant-created staging repository, never in the
  worker-writable checkout (`github::git_auth::push_commit`, ADR-0020's amendment). This needs the
  App's `actions: write` permission; see `docs/runbooks/sergeant-github-app-credentials.md`.
- **Attempts are durable before any external effect; cleanup is retried.** In the same transaction
  that reserves budget, `live_eval.requested` records the attempt: the Sergeant process making it,
  and the resources the executor will create (the deterministic `sgt-eval/<request id>` ref). If that
  process dies before recording the executor's answer, any later process treats the attempt as a
  charged unverified boundary, because whether the workflow started cannot be proven. It never
  retries it. Releasing resources is idempotent (a ref already gone counts as released) and is
  recorded as `live_eval.released`. A release that fails is retried: the daemon's supervised
  `live-eval-recovery` critical loop (reported by `/health/loops`, restarted with the process if it
  dies) runs `live_eval::recover` on the outbox-delivery cadence. Each pass pages through every Task
  that ever requested an eval, never only a recent window. It settles every unsettled request: it
  resolves orphaned attempts, observes dispatched requests no worker is waiting on, and retries
  releases.
- **Evidence integrity is checked, not assumed** (`capability::evidence`). The executor's own view
  of the run must show the authorized workflow path, `main`, and `workflow_dispatch`. The trusted
  evaluator's `evidence.json` must name exactly the dispatched candidate SHA, repository, executor
  run, evaluator revision, and normalized inputs, and the requested persona must have a scored
  result. Anything else is an unverified boundary. A candidate that changes the evaluator is
  labelled `candidate_modified_eval_definition`, not `trusted`.
- **Every end is recorded** as `live_eval.*` events on the requesting Run's Task
  (`docs/data-model.md`). No table was added. Each request is `live_eval.requested`, then
  `live_eval.dispatched`, then one terminal event: `live_eval.completed` with the assessed evidence,
  executor identity, artifact ids, and `usage: null` (the V1 executor reports no cost), or
  `live_eval.failed` with its stage: budget, executor unavailable, dispatch, blocked by environment
  (UNF-670), setup (the trusted evaluator rejected the request before its paid job ran -- e.g. a
  scenario main's catalog lacks -- never charged), harness (the evaluator failed after its paid job
  started -- never a behavior result), or evidence. A rejected
  result keeps the identity of the output it rejected: run attempt, artifact ids, any reports
  problem, and the rejected `evidence.json`'s SHA-256. The
  per-Task budget counts every request that did or may have reached the executor. A failure is
  answered to the worker as `state: unverified_external_boundary` with its reason and
  `boundary_kind`; a request main's evaluator cannot run -- a scenario the candidate's diff visibly
  defines (refused before dispatch, a fast path), or one the trusted workflow's setup rejects before
  its paid job (read from the run's jobs) -- is instead answered `state: blocked_by_environment` and
  never charged (UNF-670). A pre-dispatch check that could not run is shown as `preflight_warning`.
  The PR body's
  Validation section lists every live eval and what it proved, boundaries included, so a missing
  proof is visible at merge time. UNF-608's review rule is the intended consumer of these records
  once it lands.

Known V1 limits:

- A dispatch whose outcome is unknown (a timeout, or a crash before the answer was recorded) is
  charged and becomes an unverified boundary. Its possibly-running workflow is not tracked, and its
  ref is released anyway.
- The per-Run token is a routing guard, not authentication (above).

## Non-goals (V1)

Not built, and not implied by this ADR:

- a general capability policy DSL;
- per-role policy matrices, beyond "a capability never widens a role's other authority";
- a generic credential broker;
- GitHub Actions as a universal execution mechanism;
- a special-purpose "live eval architecture" beside this model;
- renaming `[tools]` to `[capabilities]` only for terminology;
- wiring `domain::permissions` grants (ADR-0008) into capability authorization. V1 installation
  authorization is concrete code per capability. If grants are ever wired to a real caller,
  capability authorization is a natural consumer, but that is its own decision.

## Consequences

- A new capability is added by giving an existing repo-requestable name an installation-side
  authorization and an executor. It is not a new config table, API family, or authorization path.
- Adding a capability with credentials broader than the worker may hold requires an executor
  outside the worker's process/user context. A `PATH` wrapper over a shared-host credential does
  not meet that bar.
- Evidence-producing capabilities carry an integrity obligation that credential isolation alone
  does not meet.
- Related: ADR-0001 (provider-neutral control plane: executors are to capabilities what providers
  are to workers), ADR-0014 (repo-owned config), ADR-0017 (GitHub App identity),
  `docs/security/threat-model.md` §10, `docs/runbooks/sergeant-tool-configuration.md`.

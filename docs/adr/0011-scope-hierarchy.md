# ADR-0011: Scope hierarchy for multi-repo products (UNF-214)

## Status

Superseded by [ADR-0013](0013-task-run-simplification.md) (UNF-226) and, for Repository/
Application/Environment, further superseded by [ADR-0014](0014-repo-owned-topology-config.md)
(UNF-233). Organization, Project, ExecutionTarget, and WorkItemScope described below were all
removed by ADR-0013; Repository/Application/Environment briefly survived as SQLite tables
restructured into a strict single-parent chain (Environment→Application→Repository) with plain
optional FK columns directly on `Run`, but ADR-0014 removed those tables entirely in favor of
repo-owned `sergeant.toml` config and an immutable resolved-context snapshot on `Run`. The context
below is kept for history, not as the current design.

## Context

Until now Sergeant had no durable notion of "which repository/app/
environment" beyond the implicit assumption that a WorkItem maps to one
repo. The design doc calls for explicit scope entities so that:

- one feature can span multiple repositories (e.g. backend + iOS +
  Android),
- a mutating implementation Run still targets exactly one
  repository/worktree,
- a Test/Deploy run targets a specific Application + Environment, not "the"
  repo,
- one repository can host multiple Applications,
- Sergeant's own Project concept stays distinct from a task-system's
  project (e.g. a Linear project — see ADR-0005).

## Decision

- New tables, each carrying `organization_id` directly per ADR-0004:
  `projects`, `repositories`, `applications`, `environments`,
  `execution_targets`, `work_item_scopes`. See
  `migrations/0004_scope_hierarchy.sql`.
- Hierarchy shape: `Organization -> Project -> Repository -> Application`.
  A Project can have many Repositories (the multi-repo-product case); a
  Repository can have many Applications (e.g. a backend repo containing a
  Lambda, a document store, and a React Native app in one checkout).
- `Environment` is deliberately **not** nested under `Application` — it is
  an org-level table on its own. Any Application can be paired with any
  Environment via an `ExecutionTarget`, rather than an Environment
  belonging to one Application. This is what the "Environment is modeled
  independently from Application" acceptance criterion means concretely.
- `ExecutionTarget` is the concrete thing one Run executes against, and is
  exactly one of two shapes (enforced by a SQL `CHECK` and mirrored by
  `domain::execution_targets`):
  - `repository` — `repository_id` set. This is a mutating implementation
    run's default target: one repository/worktree.
  - `app_environment` — `application_id` and `environment_id` both set.
    This is what a Test/Deploy run must target.
  A Run having a concrete `ExecutionTarget` never implies its owning
  WorkItem is single-repo — the WorkItem's affected scopes are tracked
  separately (see below), and a Run only ever points at the one target it
  actually executes against.
- `domain::runs::create_run` enforces the target-kind requirement per
  `RunRole`: `Implementer`/`Fixer` require a `repository` target;
  `Tester` requires an `app_environment` target (Deploy itself has no Run
  role yet — that lands with UNF-203's ExternalJob concept, not this
  ticket); every other role leaves the target optional. This is a domain
  decision (`SergeantError::Domain`), not just a schema constraint, so a
  caller gets a typed, role-aware error before the row is ever written.
- `work_item_scopes` is a polymorphic join table
  (`work_item_id, scope_type, scope_id`) rather than four nullable FK
  columns on `work_items`, because a WorkItem's affected scopes are
  heterogeneous (any mix of Project/Repository/Application/Environment)
  and open-ended in count — this is how one WorkItem represents a feature
  spanning backend, iOS, and Android repositories at once.
- `projects` is Sergeant's own concept and carries no task-system
  identifier. A future Linear-project mapping, if ever needed, is an
  adapter concern per ADR-0005, not a column on this table.
- `applications.kind` is free text, not an enum: the set of application
  shapes (Lambda, document store, mobile app, service, library, ...) is
  open-ended and not Sergeant's to enumerate up front.

## Consequences

- A WorkItem can be represented as spanning multiple repos purely via
  `work_item_scopes` rows, with no change to `work_items` itself.
- Runs gain a required-when-applicable `execution_target_id` column
  (nullable at the schema level for roles that don't need one yet); every
  existing `Implementer`/`Fixer`/`Tester` run in tests had to start
  providing one, which is the intended behavior change, not incidental
  breakage.
- Adding a real provider adapter (UNF-195) or worktree wiring can now
  resolve "which repo/app/environment" from a Run's `ExecutionTarget`
  instead of inventing ad hoc target information later.
- ExternalJob (UNF-203) and any deploy-shaped Run role are still deferred;
  this ticket only makes sure the target *shape* (`app_environment`)
  already exists for them to reuse.

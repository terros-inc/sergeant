# ADR-0004: Organization/Workspace is the tenant boundary

## Status

Superseded by [ADR-0013](0013-task-run-simplification.md) (UNF-226). `organization_id` was
removed from every table: V1 is one independent Sergeant server/database per organization, so the
database/deployment boundary itself is the tenant boundary now, not an app-layer-enforced column.
The context below is kept for history, not as the current design.

## Context

The design doc requires that every durable resource carry or derive an
`organizationId`/`workspaceId`, and that organization membership not imply
universal access within it (that finer-grained permission model is future
work, not this ticket's).

## Decision

`organizations` is the first table in the schema and the root of the tenant
hierarchy. `work_items.organization_id` is a required, non-nullable
foreign key — a work item cannot exist outside an organization. As later
tickets add Project, Repository, Application, Environment, and the rest of
the scope hierarchy described in the design doc, each of those tables is
expected to carry (or derive through a parent) the same
`organization_id`, so tenant scoping is never something a query has to
reconstruct after the fact.

This ticket does not implement permission grants, principals, or any
access-control narrower than "belongs to this organization" — the design
doc calls that out as separate future work, and building it now would be
speculative given nothing yet consumes it.

## Consequences

- Any future query surface (API, CLI) can filter by `organization_id` as a
  first-class, indexed predicate rather than joining through several
  tables to figure out tenancy.
- Adding permission grants later is additive: a new table referencing
  principals and scoped resources, without needing to retrofit tenancy
  onto existing tables.

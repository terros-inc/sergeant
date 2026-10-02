# ADR-0005: External task systems are adapters, not core identity

## Status

Accepted; narrowed by [ADR-0013](0013-task-run-simplification.md) (UNF-226). The core principle
here — an external system's id is never Sergeant's own identity — still holds, but the mechanism
changed: since Linear is the only V1 task source, `Task.linear_issue_id` is a direct optional
column rather than the generic multi-provider adapter/connection/external-reference machinery
ADR-0012 built on top of this one (that machinery is gone; see ADR-0012's own status note).

## Context

Linear is the organizational source of truth for work and decisions today,
and AGENTS.md/the design doc lean on it heavily for process. It would be
easy to let a Linear issue ID become Sergeant's de facto WorkItem identity.
The design doc is explicit that this must not happen: Sergeant's canonical
state is its own durable store, and Linear (along with GitHub Issues,
Intercom, Jira, and future systems) is an integration, not the domain
model. A WorkItem may have multiple such references at once (e.g. a Linear
engineering issue and the Intercom conversation that prompted it).

## Decision

Sergeant's `WorkItem` has its own opaque, Sergeant-native id (see
docs/adr/0002-rust-v1.md) and is never keyed by an external system's id.
This ticket does not yet introduce the `ExternalWorkReference` table
described in the design doc (it's a thin join, deferred until a real
external-system adapter needs it — see the walking-skeleton scope note in
`AGENTS.md`), but the principle already governs the schema that exists:
`work_items` has no `linear_issue_id`-shaped column, and none should ever
be added. When external references are added, they attach to a WorkItem as
a one-to-many side table, scoped per-connection (an org may have multiple
Linear/GitHub/Jira connections), never as a required or unique key on
`work_items` itself.

`ExternalWorkReference` has since been implemented this way by UNF-196 —
see `docs/adr/0012-task-system-adapters.md` for the table shape and the
Linear adapter built on top of it.

## Consequences

- Sergeant can be exercised entirely without Linear (as this ticket's tests
  do) — nothing in `sergeant-core` imports or assumes Linear.
- Losing or rotating a Linear connection never orphans a WorkItem's
  identity; only its external references would need reattaching.
- A WorkItem spanning multiple origin systems (e.g. both a customer report
  and an internally-filed issue) is representable without contortion.

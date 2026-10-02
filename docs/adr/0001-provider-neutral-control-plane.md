# ADR-0001: Sergeant is a provider-neutral control plane

## Status

Accepted.

## Context

Sergeant coordinates autonomous software work across multiple AI coding
providers (Claude, Codex/OpenAI, Grok/Cursor, and future providers) as well
as human workers. FirstMate, the tool currently used to help build Sergeant,
is itself deeply Claude-Code-specific. Without a deliberate boundary, it
would be easy for Sergeant to grow the same coupling.

## Decision

Sergeant owns durable work state, task dispatch, provider routing, the
implementation/review/test workflow, escalation policy, human validation
dependencies, decision tracking, and status/observability. Sergeant does
**not** own or micromanage individual worker runs' internal behavior —
Claude may use Claude subagents, Grok may use Cursor Cloud Agents, Codex may
use its own agent machinery. Provider-specific details are kept behind
adapter boundaries; the durable domain model (`sergeant-core`) never
references a specific provider's tools, session model, or terminal/tmux
state.

Concretely, for this ticket (UNF-192): the domain model stores `provider`
and `model` as opaque strings on a `Run`, not as provider-specific
structures, and no provider adapter code exists yet — only the shape a
future adapter will plug into.

## Consequences

- New provider integrations are additive (a new adapter), not domain-model
  changes.
- Nothing in `sergeant-core` may import or assume tmux, Linear, or any single
  provider's CLI/session concepts.
- Provider routing logic (which provider/model to use for a given role) is
  explicitly out of scope until real usage data exists to inform it.

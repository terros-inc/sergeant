# ADR-0014: Repository/Application/Environment topology moves to repo-owned config (UNF-233)

## Status

Accepted.

## Context

ADR-0013 (UNF-226) restructured `Repository`/`Application`/`Environment` into SQLite registry
tables (`migrations/0004_repository_topology.sql`) with plain optional `repository_id`/
`application_id`/`environment_id` columns on `Run`, explicitly noting that "none of this table set
is assumed to be the long-term home for repository/application/environment topology; it may move
to `sergeant.toml` or another repository-backed config source later."

Real usage confirmed that sooner than expected: a SQLite-resident topology registry requires
Sergeant to be the system of record for information that actually belongs to — and changes
alongside — the application/repository itself (build/test/deploy commands, environment names,
permission requirements, secret references). Keeping it in SQLite means every topology change is
an out-of-band write to Sergeant's database instead of an ordinary commit to the repo it describes,
and duplicates information the repository already needs to carry for other purposes.

## Decision

- Remove the `repositories`, `applications`, and `environments` SQLite tables entirely
  (`migrations/0004_repository_topology.sql` is deleted outright; `migrations/0001_init.sql` is
  rewritten directly rather than data-migrated, per the same no-production-data standing
  simplification the captain gave for UNF-226 — see ADR-0013). `domain::repositories`,
  `domain::applications`, and `domain::environments` are deleted along with them.
- Remove `Run.repository_id`/`application_id`/`environment_id`. In their place, `Run` gains a
  single `resolved_context TEXT` column (`domain::runs::Run::resolved_context`): an immutable JSON
  snapshot of whatever repo/application/environment configuration was actually resolved and used,
  captured once at dispatch time. It is provenance, not a live reference — nothing re-reads or
  joins through it, and it is redacted the same way artifact content is before it is ever written
  (`domain::runs::create_run`).
- The preferred source of truth for topology and operational context is now a repo-owned
  `sergeant.toml` at the repository's checkout root, parsed by the new `sergeant_core::repo_config`
  module (`RepoConfig`/`ApplicationConfig`/`EnvironmentConfig`). It owns repository/application
  identity, environments, build/test/deploy instructions, permission requirements, and secret
  *references* — never a raw secret value (see `docs/security/threat-model.md#8`).
- An instance-level `sergeant.toml` (`repo_config::InstanceConfig`) may bootstrap/discover a
  repository's config or provide a temporary inline fallback for a repository that has not adopted
  repo-local config yet. It is deliberately small and keyed only by repository slug — never a
  general organization architecture registry. `repo_config::resolve_context` always prefers a
  repo-owned `sergeant.toml` over the instance-level fallback.
- `repo_config::resolve_context` is the resolution entry point that produces the `ResolvedContext`
  serialized onto `Run.resolved_context` (`ResolvedContext::to_json`) when an instance-fallback
  entry is involved. **Update (UNF-349):** `orchestrator::dispatch::dispatch_pipeline` now resolves
  repo-owned config for every dispatched Run as one explicit step
  (`record_repo_resolved_context`), once `prepare_run_workspace` resolves that Run's actual
  checkout path — not through `resolve_context` itself (dispatch never wants its
  instance-fallback branch), but by loading `sergeant.toml` directly
  (`RepoConfig::load_from_repo`) with the same three outcomes `resolve_context` already
  guarantees: no file means continuing with no repo-owned config (the ordinary case for a
  repository that hasn't adopted one yet); a valid file means recording its resolution onto the
  Run under a stable `"repo_config"` key, merged alongside (never replacing) any caller-supplied
  provenance already on `Run.resolved_context` (e.g. UNF-239's `claude_profile`, which must
  survive a repository adopting `sergeant.toml`); an invalid file (unparsable, or declaring a
  different repository slug) fails the dispatch outright. `application`/`environment` are never
  resolved at this layer — V1 still
  supervises a single repo per `docs/adr/0016`'s "one Sergeant environment" precedent, so
  multi-application/environment resolution at the dispatch layer remains open follow-up work,
  validated only at the `repo_config` schema/unit-test level for now (see
  `crates/sergeant-core/tests/repo_config_authority_boundary.rs`).
- This `resolved_context` snapshot is intentionally minimal: just enough to explain what a Run
  actually executed against. It is not UNF-213's (not yet dispatched) general-purpose Run context
  snapshot mechanism; UNF-213 may generalize or absorb it later rather than this ticket building
  that mechanism early.

## Consequences

- `docs/adr/0011` and the Repository/Application/Environment portion of `docs/adr/0013` are
  superseded by this ADR; each carries its own status note pointing here, with historical context
  left intact.
- Adding or changing an application's build/test/deploy/environment/permission shape is now an
  ordinary commit to the repository it describes, not a write to Sergeant's database.
- A `Run` no longer has a live, joinable pointer to topology — recovery and provenance rely on the
  resolved snapshot captured at dispatch time, which is exactly what UNF-233's acceptance criteria
  require and no more.
- `repo_config::resolve_context` is wired into an actual dispatch path as of UNF-349 (see above).
  Any generalization of `resolved_context` into UNF-213's fuller snapshot mechanism, and resolving
  a specific `application`/`environment` at the dispatch layer itself (rather than just the
  repository level), remain open follow-up work.
- Sergeant itself now carries a canonical `sergeant.toml` at its own repository root (UNF-349),
  dogfooding this exact schema rather than relying on any Sergeant-specific instance fallback.

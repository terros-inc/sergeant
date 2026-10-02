# ADR-0003: Sergeant V1 uses SQLite

## Status

Accepted.

## Context

The design doc specifies SQLite as Sergeant's durable orchestration store,
with the explicit reliability requirement that "nothing important should
exist only in RAM" and that Sergeant must be able to reopen its database and
reconstruct all active work/runs/decisions after a crash or restart.

## Decision

`sergeant-core` uses the `rusqlite` crate with the `bundled` feature, which
compiles SQLite from vendored C source rather than linking a system
library. This keeps builds reproducible in CI and on a fresh VM without a
`libsqlite3-dev`-style system dependency, at the cost of a slightly longer
first build.

Schema changes are plain, hand-written, numbered `.sql` files under
`crates/sergeant-core/migrations/`, embedded into the binary at compile time
via `include_str!` and applied in order on every `open_database` call,
tracked in a `_migrations` table. There is no ORM and no code-generation
step: given the small, deliberately minimal schema this ticket introduces,
raw SQL keeps the mapping between Rust types and storage obvious, and
avoids taking on a dependency whose migration/query-builder conventions
would need to be learned and maintained for their own sake. This can be
revisited once the schema is large enough that hand-written SQL becomes the
bottleneck.

`PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, and `PRAGMA
busy_timeout = 5000` are set on every connection: the first so
referential-integrity bugs surface immediately in tests rather than
silently corrupting data, the second because WAL mode is the standard
choice for a single-writer, durability-sensitive workload like this one,
and the third because `sergeant-daemon` (UNF-204) opens several independent
long-lived connections in the same process — one per supervisor/scheduler/
reconciliation loop, plus an ephemeral one per `/health` request — so an
overlapping write now has SQLite briefly wait instead of failing the whole
tick with `SQLITE_BUSY`.

## Consequences

- Restart-survival (this ticket's core acceptance test) is a property of
  the file on disk, not of any in-process cache — verified directly by
  `crates/sergeant-core/tests/restart_survival.rs`, which closes and reopens
  a real connection against the same file.
- Multiple Sergeant instances against one SQLite file is not supported by
  this ticket; the design doc's note that "claims/leases should be designed
  so multiple Sergeant instances are possible later" is deferred to whichever
  ticket introduces concurrent workers.
- If Sergeant later needs multi-writer concurrency beyond what SQLite/WAL
  comfortably provides, that is a future migration (e.g. to Postgres)
  behind the same `sergeant-core` API — nothing above the `db` module should
  need to know which database backs it.

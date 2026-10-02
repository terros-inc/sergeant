# ADR-0007: Logs are temporary, summaries/provenance durable

## Status

Accepted (principle only — no storage implementation in this ticket).

## Context

The design doc is explicit that full worker logs, transcripts,
stdout/stderr, tool traces, screenshots, and large test artifacts should
not live in Sergeant's relational database or be copied into Linear. The
recommended default is object storage (S3) under tenant/work-item/run
prefixes with secret redaction and a lifecycle expiration (30 days by
default), with the database holding only metadata, a concise summary,
outcome, provenance, and cost.

## Decision

This ticket does not implement artifact/log storage at all — no `artifacts`
table, no S3 client, no redaction pipeline. That work belongs to UNF-202
(object storage) once a real run actually produces logs worth storing. The
principle is recorded here now, ahead of the implementation, so that when
`Run` grows result/output fields in a later ticket, nobody reaches for
"just add a `TEXT` column with the full transcript" as the easy path: the
`result_summary` field already on `Run`
(`crates/sergeant-core/src/domain/runs.rs`) is deliberately named and
documented as a summary, not a transcript, to make that intent hard to miss
even before the object-storage side exists.

## Consequences

- `sergeant-core`'s SQLite file is expected to stay small (rows per work
  item/run/transition), never proportional to how much a worker logged.
- UNF-202 can add object storage and an `artifacts` table without touching
  anything in this ticket's schema — `Run.result_summary` and a future
  `Artifact.storage_ref` pointer are additive.
- Retention/redaction policy lives entirely in the object-storage layer,
  not in `sergeant-core`.

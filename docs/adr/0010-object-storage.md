# ADR-0010: Object storage for run artifacts (UNF-202)

## Status

Accepted. Implements the principle recorded in ADR-0007. Key namespacing narrowed by
[ADR-0013](0013-task-run-simplification.md) (UNF-226): `ArtifactKey` dropped its
`organization_id` segment along with `authorize_organization_access` — V1 has no multi-tenant
boundary to enforce here (one server/database per organization). The current key shape is
`{task_id}/{run_id}/{artifact_id}` (`promoted/{task_id}/{run_id}/{artifact_id}` once promoted).
The rest of this decision — the `ObjectStore` trait, the insert-row-then-upload ordering,
retention/promotion behavior — still holds as described below.

## Context

ADR-0007 established that raw worker logs/transcripts/screenshots must not
live in `sergeant-core`'s SQLite file. This ticket implements that: an
`ObjectStore` trait, an `artifacts` metadata table, secret redaction before
upload, and default 30-day expiration for raw artifacts.

## Decision

- `crate::storage::ObjectStore` is a minimal blocking trait (`put`/`get`/
  `delete`), keyed by `ArtifactKey` — the only way to address the store, so
  every key is structurally namespaced `{task_id}/{run_id}/{artifact_id}`.
- `crate::storage::InMemoryObjectStore` is the test/local implementation —
  no disk, no network. `crate::storage::s3::S3ObjectStore` (feature `s3`,
  `aws-sdk-s3`) is the production-shaped implementation, never constructed
  in tests and never exercised against a real bucket by anything in this
  repo.
- `crate::domain::artifacts::upload_artifact` is the *only* intended path to
  create an artifact: it redacts (`crate::redaction::redact`), checksums
  (SHA-256), inserts the metadata row, and only then uploads to the store —
  so content can never reach the store unredacted, and a crash or failure
  between the two steps leaves at worst a durable row pointing at content
  that was never written (the same "content unavailable" state
  `fetch_artifact_content`/`expire_due_artifacts` already handle for expired
  objects), never an orphaned object with no row to find it.
- Default `retention_class = 'ephemeral'` artifacts get `expires_at =
  created_at + 30 days`; `retention_class = 'promoted'` artifacts (set via
  `promote_artifact`) get `expires_at = NULL` and are excluded from the
  retention sweep. `expire_due_artifacts` simulates what a real deployment's
  S3 lifecycle rule does automatically: it deletes swept content but never
  the metadata row, so Task/Run history and provenance stay intact
  after expiration — callers see `fetch_artifact_content` return `Ok(None)`,
  not an error.

## Bucket/IAM setup this implementation assumes (not provisioned by this repo)

- A single bucket per environment (e.g. `sergeant-artifacts-<env>`) with
  Block Public Access fully enabled. V1 is one Sergeant server/database per
  organization, so there is no cross-tenant isolation to enforce within a
  bucket.
- A default lifecycle rule expiring objects under the bucket root after 30
  days, matching `domain::artifacts::DEFAULT_RETENTION_DAYS`, scoped to
  exclude the `promoted/` prefix (e.g. via a filter on that prefix, or a
  rule applied only to the unprefixed root). `domain::artifacts::promote_artifact`
  relocates the object to `promoted/{task_id}/...`
  (`storage::ArtifactKey::promoted`) via the existing `ObjectStore` trait,
  copying to the new key, committing the metadata row (`retention_class`,
  `storage_key`) to point at it, and only then deleting the old key — so a
  crash between those steps leaves at worst a harmless duplicate object
  reachable at the already-updated key, never a promoted object orphaned at
  a key nothing can resolve to. It fails loudly (`SergeantError::ObjectStore`)
  rather than flipping `retention_class` if the object is no longer present
  to relocate, so a promoted row can't silently outlive content the
  lifecycle rule already swept.
- Server-side encryption at rest (SSE-S3 or SSE-KMS) enabled by default.
- An IAM policy scoped to `s3:PutObject`/`s3:GetObject`/`s3:DeleteObject` on
  `arn:aws:s3:::sergeant-artifacts-<env>/*`, granted only to the Sergeant
  control-plane service identity — never to individual workers or provider
  adapters.
- Versioning left off: artifacts are write-once-then-expire, not edited in
  place.

## Consequences

- `sergeant-core`'s SQLite file stays proportional to run/artifact *count*,
  never to log volume.
- Secret redaction runs unconditionally on text-typed artifacts before
  upload (`domain::artifacts::redact_if_text`); it is not optional and does
  not depend on the store being private.
- The promoted-prefix relocation logic lives in this crate (`promote_artifact`,
  `ArtifactKey::promoted`) and is proven against `InMemoryObjectStore`; only
  the real S3 wiring (bucket name/region config, credentials, the actual
  lifecycle-rule prefix filter) is deferred to whichever ticket provisions
  infrastructure.

# ADR 0025: Add dormant normalized-source storage behind one session fence

**Status:** Accepted for dormant implementation

## Context

Architecture ADR 0028 requires receiver-first storage for versioned external transcripts without changing legacy external or ordinary chunk-upload sessions. Source text, unkeyed fingerprints, and raw idempotency keys must disappear at the retention boundary, while bounded deletion and terminal evidence may remain. Core remains authoritative for review identity, so review storage is not part of this rung.

## Decision

Alembic `0009` adds six nullable, all-or-none, insert-time-only fields to `scribe_sessions`: contract version, Core-authorized creator, manual language mode, and server-selected transcription-adapter, model, and normalization-profile revisions. Existing rows remain null with no inferred defaults/backfill. The session also holds immutable DB-clock receipt/maximum-fourteen-day-expiry anchors, a monotonic purge marker, and a current source version beginning at one. Purge clears the current pointer but retains timestamps; early privacy erasure remains permitted.

The existing `(tenant_id, id)` session row is the common durable serialization fence. Source triggers lock it and recheck `clock_timestamp()` near commit. Persistence must still lock/revalidate consent first, then lock this row and repeat its expiry/purge check for every later writer; this migration does not claim to implement those operations. Three forced-RLS tables store immutable source headers, segments, and receipt-key aliases. Header/segment bounds and order are checked before commit; a deferred foreign key prevents a missing current source. Fenced root deletion cascades plaintext, raw keys, and unkeyed hashes. Source evidence rejects update but permits retention deletion.

An append-only forced-RLS terminal-event table holds bounded evidence required for configured `failed`, which is terminal; legacy `failed -> uploaded` remains. The version-discriminated status trigger leaves the exact null-configured `0008` graph intact while requiring configured external rows to traverse the new states. Chunk/native/web rows cannot enter them. No new table or function is granted to runtime, worker, reconciler, or `PUBLIC`; this rung adds no repository, API/OpenAPI, Core DB, client/provider, derived-content table, infrastructure, or activation behavior.

Persistence Packet 1 adds an internal, protected-data-safe configured-session record without changing `CaptureSession`, the legacy status enum, or either wire schema. The repository accepts only Core-authorized identity, creator, and manual language mode; it binds one code-versioned server profile and the contract/status itself. Creation locks and revalidates the exact current consent. Configured rows use separate read/lock methods, while every legacy session, transcript, worker, and delivery path filters for a null contract discriminator.

Bootstrap now grants `scribe_sessions` privileges by column. Runtime may select/insert only legacy identity plus the six immutable configuration fields and may update only status. Transcription sees legacy columns plus the discriminator and may update only status; reconciliation sees the discriminator only to exclude configured rows. None can access lifecycle anchors or normalized-source tables in this packet. Revision `0010` makes the deferred fence compatible with those grants: safe configured inserts take a no-read fast path after `0009`'s insert trigger/checks have forced `created` with null lifecycle fields; updates preserve the locked final DB-clock and purge checks using only their required lifecycle columns.

## Consequences

- Applying `0009` alone is dormant: current code writes none of the new fields or tables.
- Applying `0010` plus Packet 1 remains dormant: no route or runtime callsite invokes configured creation.
- The trusted runtime keeps legacy child-table access, and those foreign keys enforce tenant—not contract—identity. Repository filters hide malformed configured children, but activation is blocked until discriminator triggers, an isolated configured writer, or an explicitly accepted equivalent trust boundary prevents raw-SQL bypass.
- Purge and every writer remain implementation work; this DDL supplies their common fence and fail-closed constraints but is not evidence that a deletion worker exists.
- Operational recovery is to hold later callers and retain the additive schema. Downgrade is destructive, test-only, and refuses after any versioned configuration, source, state, purge, or terminal evidence exists.

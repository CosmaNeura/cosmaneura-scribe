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

Persistence Packet 2 adds no route or schema. Its repository transaction locks current consent
before the configured session row, rejects expired, purged, or terminal sessions using the database
clock, and atomically commits the session pointer, immutable source and segments, receipt-key
binding, and metadata-only audit. Same-key retries allocate nothing; new keys matching the current
canonical fingerprint alias its byte-identical receipt; changed input receives the next version
without moving the first-receipt expiry anchor. Current-content reads use the same gates.

Persistence Packet 3 also adds no route, schema, grant, or scheduled authority. Explicit terminal
failure accepts a caller-stable opaque event ID plus a bounded failure code and system/operator
principal, stores the existing `0009` terminal evidence, and moves any nonterminal configured state
to terminal `failed`. Event IDs are unique within one tenant but may recur in another tenant. An
exact full-tuple retry, including after expiry or a purge that preserved the explicit failure,
returns the original event without another state, content, or audit write; conflicting evidence and
cross-session event-ID reuse fail closed. The operation
locks the consent serialization point and then the configured session row, uses the database clock,
and leaves normalized source content in place until its existing expiry anchor.

The Packet 3 due-purge operation takes that same lock order but does not require active consent:
revocation cannot block erasure. At or after the immutable source expiry it sets the monotonic purge
marker, clears the current pointer, deletes the normalized-source root so segments, raw receipt keys,
and unkeyed content fingerprints cascade, and writes only bounded audit/terminal evidence. A
non-handed-off session becomes `failed` with `retention_expired_before_handoff`; a handed-off session
remains `handed_off`; a prior explicit failure keeps its original evidence. Retries preserve the
original marker and event while re-running deletion and absence checks, and every source writer that
loses the common fence observes expiry or purge before it can write.

Persistence Packet 4 adds revision `0011` and updates bootstrap without adding an identity or
caller. A fail-closed database trigger requires an existing null-contract session before insert or
tenant/session reassignment on each direct legacy child root: audio chunk/grant/key, legacy
transcript/delivery/job, capture lease, reservation batch/reservation, and channel finalization.
The remaining capture receipt/item tables can only reference one of those guarded roots. Upgrade
takes bounded locks and refuses any pre-existing configured/legacy mixture before installing the
guards. Downgrade is disposable-test-only; operational recovery retains the guard dormant.

The existing runtime principal receives only `SELECT, INSERT` on normalized source headers,
segments, and receipt-key bindings; lifecycle-column `SELECT`; and `UPDATE` of status, receipt,
expiry, and current-version fields. It receives neither normalized-source `UPDATE`/`DELETE`,
terminal-event access, nor `content_purged_at` mutation. Transcription and reconciliation roles
receive no normalized-source or terminal-event access. This is sufficient for a future source
receiver and current-source read, while terminal failure and retention purge remain unavailable to
every deployed application role.

This dormant repository behavior follows ADR 0028's unconditional source deletion at the fourteen-
day anchor for synthetic verification only. It does not resolve ADR 0013's broader requirement that
legal holds win every scheduled purge. The current normalized-source schema has no hold relation or
reviewed precedence rule. Real-PHI activation therefore remains blocked until architecture/legal
owners reconcile that conflict and a separately reviewed retention authority enforces the result.

## Consequences

- Applying `0009` alone is dormant: current code writes none of the new fields or tables.
- Applying `0010` plus Packet 1 remains dormant: no route or runtime callsite invokes configured creation.
- Packet 2's repository remains dormant because there is no route or caller. Packet 4 makes its
  normalized-source and lifecycle-column authority available to the existing runtime principal,
  but does not invoke it.
- Packet 3 remains dormant for the same reason and adds no worker, scheduler, API, OpenAPI,
  deployment, migration apply, or activation path. Only synthetic repository tests invoke it.
- Packet 4 remains dormant because it adds no route or caller and this change does not apply its
  migration or bootstrap grants. It reuses the existing runtime workload identity rather than
  creating a third authentication path.
- A later API/retention packet must translate near-expiry commit-trigger failures into bounded
  errors and serialize a receipt's canonical body only after its transaction commits.
- The trusted runtime keeps legacy child-table access, but revision `0011` now enforces the contract
  discriminator underneath repository filtering. Configured sessions cannot own direct legacy
  child roots through ordinary SQL, and missing or RLS-hidden parents fail closed.
- Translation, review, working-transcript, and handoff writers remain implementation work. Packet 3
  proves source purge only; it is not evidence that a deletion worker or complete covered-content
  purge exists.
- Real-PHI retention activation is blocked on an explicit legal-hold decision and its corresponding
  schema, least-privilege routine/grants, report/enforce gates, and restore evidence.
- Operational recovery is to hold later callers and retain the additive schema. Downgrade is destructive, test-only, and refuses after any versioned configuration, source, state, purge, or terminal evidence exists.

## September 2026 long-visit capacity expansion

Revision `611c583b362a` separates the unchanged 100,000-character per-segment
limit from a 500,000-character source aggregate and an independently bounded
500,000-character translation history. Working content may total 1,000,000
characters from these inputs. The existing retention anchors, immutable source
versions, deferred aggregate validation, tenant and consent fences remain.
Core PR507 and Scribe PR133 provide compatible receivers first. Deployment
requires the sequence and retained-schema recovery in
[the flight plan](../flight-plans/2026-09-25-long-transcript-storage.md).

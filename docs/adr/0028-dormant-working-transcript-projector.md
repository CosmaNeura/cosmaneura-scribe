# ADR 0028: Add the dormant working-transcript projector

**Status:** Accepted for dormant synthetic implementation

## Context

ADR 0027 added immutable working-transcript storage without any writer or runtime grant. The next
small step is an internal projector that can prove the schema and canonical domain model agree. It
must not create a second projection algorithm or accidentally activate the feature.

## Decision

Add `publish_current_working_transcript(tenant_id, session_id)` to the internal repository
contract. The caller supplies no transcript ID, version, state, content, lineage, timestamp, or
fingerprint. The repository locks consent before session, loads the current source plus every
translation attempt and review for that source, and uses the existing v1 projector, status
derivation, and fingerprint functions. PostgreSQL checks evidence counts and aggregate content
size before materializing it because revision `0012` is intentionally less restrictive than the
domain envelope.

The database supplies creation time; the writer supplies a stable server-generated identity and a
strictly increasing version. In the transaction, it updates the current pointer/status, inserts
translation memberships, review memberships, segments, blockers, and finally the sealing header.
It then forces all relevant deferred constraints and performs a final live/current/fingerprint
gate. Exact replay recomputes the fingerprint using the current version, performs the same final
gate, returns the original creation time, and writes no audit event or duplicate row. The
consent/session locks serialize concurrent calls. After immediate validation, a no-op session
update re-arms the deferred session fences so the caller-owned outer commit checks expiry again.
Existing evidence is immutable; any later evidence insert queues its own membership fence, so the
translation/review constraint triggers do not need a synthetic re-arm.

Method-time domain and expected integrity failures are mapped to bounded `CONSENT_INVALID`,
`EVIDENCE_INVALID`, `RETENTION_EXPIRED`, and `STATE_CONFLICT` codes without including database
text. A re-armed named fence can still reject at the caller-owned outer commit, after the method has
returned; the future activation wrapper must translate that commit failure and must not log or
return raw database details. Other operational database failures remain visible and retryable.
Expiry is rechecked with the database clock after both a failed compare-and-set and a rolled-back
deferred constraint check.

This packet may precede translation and review repositories. It projects already-persisted `0012`
evidence and is the transaction-local primitive those future writers must call. Once a current
working pointer exists, `0013` requires newly inserted evidence to be included in a replacement
projection in the same transaction.

No role can call the PostgreSQL writer in production yet: this packet adds no grants and preserves
the existing source receiver's exact column grants. Activation must atomically grant a dedicated
projector principal its minimum table/column privileges and amend source correction authority to
clear only `current_working_transcript_version` in the same correction update. Enabling projector
calls before that correction change is forbidden. Purge already clears the pointer and cascades all
working content.

## Consequences

- The implementation remains unreachable from routes, workers, providers, and deployed roles.
- In-memory correction clears the current version and preserves the stable identity; PostgreSQL
  correction-after-projection is deliberately activation-coupled to the future grant packet.
- No migration, OpenAPI, settings, deployment, handoff reader, translation/review writer, or
  production activation is included.
- Real-PHI use remains prohibited pending the separately reviewed activation and end-to-end race
  packet.

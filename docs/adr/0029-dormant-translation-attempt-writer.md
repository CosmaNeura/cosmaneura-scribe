# ADR 0029: Add a dormant translation-attempt writer

**Status:** Accepted for dormant synthetic implementation

## Context

Revisions `0012` and `0013` can retain immutable Spanish-to-English attempts and complete working
projections, but no repository operation may write an attempt. A raw insert is unsafe: `0012`
requires the live session to be `translation_pending`, while `0013` requires every newly inserted
attempt to appear in the current working projection before commit.

## Decision

Add one internal operation that records one result for a Scribe-reserved translation identity and
publishes the replacement working transcript in the same caller-owned transaction. The command
pins the expected current source and segment versions and the expected prior attempt version. It
contains the bounded result and syntactically bounded opaque adapter/model profile identifiers, but
cannot set
locale direction, the new version, creation time, session state, working identity/version,
fingerprint, or readiness. The writer derives `es-US` to `en-US`, allocates the next version while
holding the session lock, and uses the database clock.

Authorization remains a future caller responsibility; this packet adds no caller. Persistence
always takes the consent advisory lock before the configured-session row lock and then revalidates
consent, current lineage, retention, purge, status, and the existing working pointer. A new attempt
requires a current `translation_pending` projection. A failed latest attempt or a successfully
rejected latest attempt may be retried. An unreviewed successful attempt or an accepted translation
cannot be superseded.

An exact replay of the same Scribe identity converges after binding tenant, session, current source,
segment, expected version, result, and profile. Reuse with different lineage or payload is a bounded
identity conflict. The PostgreSQL writer uses a savepoint so a cross-session race on the tenant-wide
translation identity can read back the winner after `23505` without leaking database text.
The receipt binds the immutable attempt fields but reports the current working projection. Replaying
an older attempt after a later retry therefore returns the older attempt version and creation time
alongside the current projection and status; it does not reconstruct a historical whole response.

After a real insert and one audit record, the writer calls the existing canonical projector on the
same repository and transaction and requires a replacement publication. Any projection failure
rolls back the attempt and audit. The projector forces translation and working constraints, runs
the final live/fingerprint gate, and rearms the session fence for caller-owned commit. Exact replay
requires a projector replay and adds no row, version, or audit.

The initial missing-translation projection remains an orchestration prerequisite. No provider
network call may occur under the consent/session locks. Purge removes the attempt, its replay
identity, and dependent working evidence through the existing cascade.

## Consequences

- The stored evidence can now be exercised through memory and PostgreSQL repository code, but it
  remains unreachable from routes, workers, providers, deployed roles, and clients.
- The future translation job must reserve and durably retain the Scribe translation identity and
  expected prior version before making its provider call. Its activation boundary must admit the
  configured adapter/model profiles; this dormant writer validates identifier syntax only.
- Creator review remains a separate Core-reauthorized writer packet. A later transaction-owning
  wrapper must sanitize deferred failures raised by outer commit.
- Grants remain forbidden until source correction can atomically clear only the current working
  version and the broad trigger reads are replaced with least-privilege explicit columns.
- Real-PHI activation remains blocked on the accepted adapter/model evaluation, retention policy,
  least-privilege grants, and end-to-end race evidence.

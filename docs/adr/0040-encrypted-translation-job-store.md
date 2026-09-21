# ADR 0040: Dormant encrypted PostgreSQL translation jobs

**Status:** Implemented for owner-approved disposable-local qualification only.

## Authority and scope

On 2026-09-21 the owner approved a Scribe-only encrypted job store and dormant
migration, tested only in a disposable local database. This is the bounded
amendment to ADR 0037. No cloud/shared-platform changes, new auth path, runtime
registration, provider call, new dependency, push, PR or deployment are included.

## Design

`PostgresTranslationJobStore` implements the existing four-state execution
contract. Each operation owns a PostgreSQL transaction. It reuses the existing
consent advisory lock and session row lock before locking a job. Tenant identity
is trusted internal worker context; this class is not an end-user API and does
not replace Core's creator authorization or native authentication.

Before claim, re-read current consent, source version/segment/locale/exact text,
retention, session status, previous attempt and accepted/pending review state.
Reserve only one job identity per source/next-attempt slot. Claim only `reserved`;
never automatically reset or repeat an uncertain `provider_call_started` job.
The linearization point is committed claim admission, not an assertion that a
later revocation can retract a request already sent. Recheck authority on result
storage and commit reconciliation; subsequent revocation blocks both.

The immutable completed result remains encrypted until the existing writer
commits it and produces its existing working projection. The commit marker checks
the exact persisted attempt, not just a caller-supplied success assertion. Review
remains a separate, creator-only decision. No new clinical note generator.

`TranslationJobCipher` uses the existing RSA-3072/OAEP-SHA256 public-key and server
unwrap interfaces. Every write generates a fresh AES-256 key and 96-bit nonce.
It never reads/reuses a capture session key. `SessionAudioKey` is reused solely
as the existing unwrap transport, not written to the audio-key table. Authenticated
additional data binds contract, tenant/session/job, source lineage, state, times,
expiry, key version and wrapped key. The full reservation/result/call token is
encrypted; there is no plaintext source, result or content fingerprint column.
Payload/ciphertext sizes are bounded. Mutable key buffers are cleared, but Python
and cryptography may retain immutable copies: this is not secure-memory erasure.

The new table has forced tenant RLS, source-lineage foreign keys, monotonic state
guards and a deferred current-consent/source/retention fence. Existing source
retention deletion cascades to jobs, including unknown-outcome jobs. Direct job
deletion/reset while source remains is rejected. This prevents ordinary SQL
rollback/reinsert replay; it cannot protect against a database superuser restoring
an entire old database or someone controlling both the database and wrapping key.
Key/network failures fail closed. Audit contains only fixed actions and entity
IDs. Public errors discard raw validation/SQL/driver exception context.

## Migration and integration

Revision `0018_translation_jobs` adds one table and two guard functions. Its parent
is `0014` on this local branch; the separate integration checkout already owns
0015–0017. Reconcile that graph and rehearse it before integration. No other
checkout was edited and no runtime/bootstrap permissions were added. Existing
permission gates remain closed. A future worker needs reviewed, least-privilege
access to this table and the already-approved source/attempt surfaces; never
grant review-writing or consent-mutation access to the translation worker.

Expand recovery leaves the table dormant. Downgrade rejects non-`_test` databases
and any nonempty job table. Empty-table removal is only the approved disposable
test rehearsal, not live rollback or authorization for contract cleanup.

## Qualification and remaining limits

Tests use generated local RSA keys and real disposable PostgreSQL, including a
non-owner RLS role and fresh Python-process restoration. They exercise tampering,
competing claims, revocation-before-admission, stale source, retention cascade,
wrong tenant/session, immutable attempt/creator review, rejected reset/downgrade,
and lost claim/result/writer/marker acknowledgements. No real model or cloud key
is called by these tests. See the real-services checkpoint for measured results.

A separate disposable role test reuses the existing translation bootstrap's
column-scoped grants and restrictive session policy, adding only job-table
SELECT/INSERT and lifecycle/envelope-column UPDATE. It completes the store/writer
path with no consent UPDATE, review INSERT or job DELETE privileges. The test
role/policy/grants are removed afterward; no runtime bootstrap is changed.

Still required before runtime activation: independent review, combined migration
graph rehearsal, constrained worker grants/key access, wiring into the current
standalone and CosmasOS receiver/review paths, operator UX for unknown outcomes,
end-to-end mixed-language device acceptance, and release qualification. Storage
connectivity and a passing synthetic corpus are not clinical fidelity certification.

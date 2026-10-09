# Resume a paused recording after background upload

Owner: MCD operational beta owner. Tier 2, within the approved staging-only
repeatable recording workflow. No production promotion or new identity access.

Mac build 30 accepted a fresh recording but rejected Resume after its first
chunks uploaded. Read-only metadata confirmed a stopped native source, retained
chunks and a session in `capturing`. Both the API source-start gate and the
database history trigger still required `created`. The existing renewal and
reservation paths already support `capturing`.

Accept `created` or `capturing` at those two gates. Preserve exact creator,
consent, current lease and reservation checks, one active native owner, immutable
stop history, native once-only consumption and finalization rejection. No
capture authority is added to the renderer. No request/response, dependency,
credential, key, audio format or permission changes.

Migration `e9c4b7220d31` follows `b0d93127cafe`. It replaces exactly one status
predicate in the existing function and rejects an unexpected definition.
Function identity, ownership, grants, other predicates and triggers stay intact.
It writes no recording or encounter rows. Rehearse over a clone containing the
failed test's registered audio and stopped source; compare all retained row
hashes, table security, policies, triggers and function attributes.

Validation uses the real local PostgreSQL repository and normal capture API:
register a synthetic chunk, confirm `capturing`, stop, optionally renew and
reserve the next position, then prepare/authorize a new interval. Cover desktop
mixed audio and iPhone microphone; deny competing ownership, foreign creators,
foreign tenants and starts after finalization. Preserve prior chunk count and
idempotent authorization. Existing native ownership/ACL tests remain applicable.
This is software evidence, not proof of an actual microphone or Zoom call.

Release order: merge tested source, publish immutable API image, reconcile live
staging image/configuration/schema, apply the guarded migration, then update
only the API image. The older API remains compatible while the database guard
is expanded. The installed native clients and Core/receiver are unchanged.
Preserve the currently deployed companion Session Prep configuration.

The existing immutable API image is the release control, owned by the beta
owner for the staging cohort until the next reviewed candidate. Recovery rolls
the API back to its observed prior digest and leaves the migration/history in
place; it restores the previous resume restriction. Never erase or rewrite
retained source attempts, recordings or keys. Physical acceptance must retry
the retained paused visit through the product UI, then verify stop/upload and
saved-note reopening. Three complete fresh visits and the consented two-person
Zoom test remain distinct operational acceptance requirements.

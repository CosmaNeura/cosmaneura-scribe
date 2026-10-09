# Versioned creator corrections and confirmed speaker names

Tier 2. The owner approved the complete transcript/note UX implementation on
September 30, including explicit corrections, preserved source/history and
confirmed provider/patient/interpreter names. Authentication, consent gates and
the canonical clinician/patient/other/unknown roles remain unchanged.

## Expand and receiver-first sequence

1. Validate the additive migration, exact database grants, existing working
   projection behavior and creator-edit API against a fresh disposable database.
2. Deploy the backward-compatible Core receiver/parser before Scribe begins
   returning `editing_allowed` or `review_edits`. Old unedited views remain valid.
3. Apply Scribe migration 0024 and refresh existing derived-writer database grants
   as one maintenance rung before permitting working-transcript publication.
   The lineage trigger now reads the new table; those publishers need its SELECT
   grant even when no edit exists. Only the existing creator runtime receives
   INSERT. No new principal, role membership or external service is introduced.
4. Deploy the Scribe receiver, then native/browser consumers with encrypted,
   creator/environment/session-scoped pending-edit journals. A client lacking
   that journal must not offer editing. Validate synthetic save/reopen and exact
   lost-response recovery through the paired deployment.

## Invariants

The immutable original transcript, translation decisions and previous working
versions remain intact. Each explicit correction has exact source and working
lineage and produces the next working version in one transaction. GET never
publishes, edits, retranslates, regenerates a note or claims clinical review.
Confirmed interpreter is display detail on canonical role `other`.

Corrections apply only to already-resolved English wording; they cannot resolve
unknown language, accept a translation or remove quality blockers. Display names
are user confirmations, never inferred from a login or a detected voice. The
request has no creator/tenant authority fields and is capped at 1 MiB of UTF-8
JSON before encrypted pending storage. History is current-source scoped, limited
to 1024 operations and one million correction characters, and follows the
existing transcript retention purge through cascading foreign keys.

Consent/creator/retention checks precede idempotency recovery. The same key and
payload recover the original receipt even after a later edit. Changed payloads,
unknown or stale lineage conflict. Existing drafts are not silently overwritten;
the caller must compare their recorded working version with the new version.

## Recovery

Leave table, immutable history and migration 0024 in place. Disable the UI entry
point or restore a compatible prior client. After any edit exists, rolling back
to a receiver that ignores edit evidence is unsafe: keep the corrected working
projection reader and lineage trigger deployed. Do not downgrade, delete edits,
reset recording state or erase native pending journals to recover a UI release.

## Local evidence

`test_creator_transcript_edits.py` covers publication, source preservation,
later-version receipt recovery, stale conflicts, creator/consent checks,
unresolved translation rejection, closed DTOs, immutable database rows, tenant
visibility and retention purge. Existing working/migration/bootstrap suites
cover compatibility and exact role permissions. Browser fixtures are synthetic
component tests, not a clinical fidelity or physical-device acceptance claim.

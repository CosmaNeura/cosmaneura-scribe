# ADR 0013: Retain by policy and erase with a separate authority

**Status:** Proposed

## Context

Scribe now persists encrypted audio, a wrapped per-session data-encryption key, transcripts,
delivery receipts, job state, consent evidence, and audit metadata. None of those stores has a
complete retention workflow. An unconditional Blob age rule is unsafe because Azure Storage cannot
see a legal hold, an active session, a transcription lease, or a pending delivery. Giving the API or
transcription worker `DELETE` would also collapse custody and erasure into the identities that create
and consume the data.

Deleting `session_audio_keys.wrapped_dek` makes the corresponding audio unavailable to the online
service without deleting a shared Key Vault version. It is the first erasure action, but it is not a
claim that old database backups or Blob versions have already expired. Restore procedures must
replay acknowledged erasure intents before restored data can serve traffic.

## Proposed decision

PostgreSQL is the source of truth for retention deadlines, holds, and purge progress. Add a
false-by-default Container Apps retention job with independent report and enforce gates. Report mode
may calculate aggregate due counts but cannot delete or tag data. Enforce mode uses a dedicated
user-assigned identity and PostgreSQL principal. The API runtime and transcription identities keep
their current grants and never receive `DELETE` on custody tables.

The retention principal receives only `EXECUTE` on versioned, security-definer retention routines
and a custom Blob role limited to tag, version-list, and delete operations on the audio container. It
receives no general table access, Blob content-read action, or Key Vault unwrap role. A trusted
control-plane invocation supplies one tenant UUID; there is no global tenant scan. Retention
routines live in a locked schema, are owned by a dedicated `NOLOGIN NOBYPASSRLS` definer,
schema-qualify every relation, and use a fixed trusted `search_path`. Migrations revoke routine
execution from `PUBLIC` and grant it only to the retention principal. Each routine sets
transaction-local tenant context, keeps row security enabled, selects a bounded batch with `FOR
UPDATE SKIP LOCKED`, and is tested for cross-tenant denial.

Audit expiry preserves the existing rejection of direct `UPDATE` and `DELETE`. Only the
owner-controlled retention routine or a future partition-retirement mechanism may remove expired
audit data; no caller-settable flag may bypass the append-only guard. The routines emit
metadata-only retention events. This keeps RLS active for application queries while avoiding a
broad cross-tenant `BYPASSRLS` maintenance role.

The initial policy is:

| Record class | Proposed deadline | Required gate |
| --- | --- | --- |
| Wrapped session DEK and encrypted raw audio | 30 calendar days after a terminal session or successful handoff | No hold, no active lease, no pending delivery |
| Abandoned or failed capture audio | 30 calendar days after the last custody activity | No hold and no live capture/transcription lease |
| Upload grants, chunk metadata, idempotency records, transcription jobs, and delivery receipts | 90 calendar days after their dependent workflow is terminal | Audio purge confirmed; no replay or delivery remains possible |
| Transcript and session | Seven calendar years from the later approved encounter/closure anchor or record creation | No hold; legal schedule approved for the tenant and jurisdiction |
| Consent evidence and audit record | Seven calendar years from their own legally approved effective dates | No hold; every referencing session deadline has passed |
| Retention actions and erasure tombstones | Seven calendar years after the action | Never removed in the same run as the records they attest |

These are conservative product defaults, not legal advice. Enforcement remains false until counsel
confirms whether the master platform or Scribe is the legal record, the jurisdictional start event,
minor-patient rules, and any tenant-specific extension. A configured tenant policy may extend a
deadline but cannot shorten the approved baseline without a separately reviewed policy version.
Calendar arithmetic, not a fixed day count, determines the seven-year deadline.
Implementation persists the approved terminal/closure timestamp instead of inferring it from the
current session status. Consent remains until its own deadline and all referencing-session
deadlines pass; audit retention starts at `occurred_at` or a later legally required effective date.

A tenant-scoped hold records its policy version, scope, reason code, start time, and optional release
time. Holds may cover a tenant, session, or canonical encounter and win over every scheduled purge.
Active capture, a non-expired transcription lease, a retryable delivery, or an incomplete Blob purge
also blocks dependent database deletion. Hold creation/release, lease claim/renewal, and purge claim
use the same tenant/session fencing lock. A hold committed first blocks purge; after wrapped-key
deletion commits, a later hold records and alerts that the irreversible point has passed. Before
deletion, enforcement fences new claims and proves that no target Container Apps execution remains
active. Consent revocation stops new processing immediately; it does not silently discard evidence
and instead requests the earliest purge allowed by holds and the approved legal policy.

Enforcement runs in this order:

1. Persist an immutable erasure intent in an append-only store outside PostgreSQL's backup and
   failure domain, to which the retention identity has no delete permission, and wait for durable
   acknowledgement. Keep mutable retry state in a separate ledger or append progress events.
2. In a new transaction, lock and revalidate the session, hold, lease, active-execution fence, and
   acknowledged intent, then delete the `session_audio_keys` row. Crash recovery replays
   acknowledged intents idempotently and errs toward completing deletion.
3. Delete every registered Blob version and snapshot for the session. Retry from the acknowledged
   intent until Azure confirms absence; never log an object name, URL, wrapped key, audio, or
   transcript.
4. After Blob absence is confirmed, delete upload-grant and chunk metadata. Delete operational job,
   idempotency, and delivery rows only after their 90-day replay window.
5. At the approved clinical-record deadline, delete the transcript and session in foreign-key order,
   delete consent only when no retained session references it, and retire old audit rows only after a
   later retention event records the purge.

Azure Storage lifecycle management is a backstop, not the authority. It may delete only versions
tagged `purge-approved` by the retention workflow and may never apply an unconditional container-age
rule. Storage soft delete, version retention, PostgreSQL backup retention, and any geo-replicated
copies define the physical-purge SLA. Track `live_absent` separately from `physically_expired`.
`live_absent` requires no readable current Blob, version, or snapshot. `physically_expired` requires
expiry of Blob soft-delete/version recovery, PostgreSQL backup, and replica windows plus a confirming
scan. Do not delete locator metadata needed for that scan before physical expiry; alternatively keep
equivalent opaque locators in the protected tombstone.

A restore is quarantined until the externally durable erasure-intent feed has been replayed through
a high-water mark newer than the backup recovery point and the retention report is clean. Acceptance
injects failure at every intent, acknowledgement, wrapped-key deletion, Blob deletion, and progress
boundary. Activation also requires an approved numeric physical-purge SLA and a real-account test
covering base blobs, versions, snapshots, and lifecycle-tag behavior.

Key rotation is reference-driven. New sessions bind only the current enabled RSA wrapping-key
version. A rotated version remains enabled while any `session_audio_keys` row references it and until
every bound session has either completed transcription or been erased. At zero references,
automation may disable that version after a reviewed rollback window and proof that no retained row
or hold needs it. Azure Key Vault cannot delete an individual version: deleting or purging is allowed
only when every version under that key name is unreferenced and the entire key name is retired.
Rotation automation receives update/disable permission, not key delete or purge permission.

If compliance requires physical deletion per key generation, use a distinct Key Vault key name for
each deletion epoch and persist that key identifier with the wrapped DEK. That is a future custody
schema/protocol change; the current immutable row stores only the version under one configured key
name. Rotation never rewrites an immutable wrapped DEK and never disables a version merely because
of age.

## Activation and acceptance

Implementation requires a reversible schema migration, PostgreSQL/RLS tests against the real
database, a report-only production-equivalent run, and a restore drill. Acceptance must prove:

- the API and transcription principals cannot erase data;
- holds and active leases block every layer of purge;
- after in-flight processors are fenced or terminated and wrapped-key deletion commits, every new
  unwrap/read attempt fails; deletion cannot revoke plaintext already held by a running process;
- Blob versions and snapshots are eventually absent and retries are idempotent;
- a database restore cannot resurrect an erased session into a serving environment;
- an in-use Key Vault version cannot be disabled or deleted; and
- logs and diagnostics contain only fixed codes, counts, policy versions, and opaque IDs.

Until those checks and the legal schedule are approved, this ADR authorizes design work only. It
does not enable a lifecycle policy, retention job, deletion endpoint, or additional database grant.

## Consequences

- Erasure is separated from capture and transcription and remains auditable and retryable.
- Online cryptographic unavailability occurs before slower Blob and backup cleanup.
- The design preserves legal holds and process-restart safety, but adds a retention ledger, an
  external tombstone durability requirement, and restore-runbook work.
- Seven-year storage may be unnecessary if the master platform is the sole legal record; confirming
  that boundary can materially reduce Scribe's PHI footprint before enforcement is built.

# Bounded configured capture across practices

Risk: Tier 2 (tenant admission and worker database security policy). Source-only
preparation; no live activation, grant update, migration, image publication, or
deployment is included. Owner: John. Proposed control expires 2026-12-04 unless
John renews or replaces it after qualification. Initial live cohort: unchanged;
additional practice UUIDs require an explicit owner decision.

## Problem and source behavior

Core gives each practice its own stable Scribe tenant UUID. The existing API and
worker settings accept one configured UUID, and each scheduled worker accepts
one exact tenant target. A newly created or grandfathered practice with another
UUID can therefore finish activation while configured recording or pending
processing remains unavailable. Sharing an existing admitted practice is a
valid immediate synthetic demo route when the owner chooses it; it does not
qualify recording for every new or existing practice.

`COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_MULTI_TENANT_ENABLED` defaults to `false`.
The default retains the existing maximum of one explicit nonzero UUID. Opting
in permits at most 32 nonzero UUIDs in the existing
`COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS` JSON setting. This list bounds
server admission; it never registers a tenant, adopts accounts by email, changes
Core's authoritative membership, or grants a caller permission. Core-resolved
request tenancy, workload authentication, per-request tenant RLS, consent,
capture ownership, retention, claims, and stage separation remain required.

The legacy worker arguments remain `TENANT_UUID --pending` or
`TENANT_UUID SESSION_UUID`, with exactly that configured tenant as the target.
The new exact argument `--cohort-pending` additionally requires the opt-in flag,
an enabled worker, managed-identity credential selection, and a nonempty bounded
cohort before clients or database resources are created. Both scheduled stages
can use this mode without creating more jobs or services.

Each cohort execution creates one set of worker clients, discovers work in a
separate transaction for each exact tenant, and processes at most one unseen
session per tenant in each round. Seen targets are `(tenant, session)` pairs.
One aggregate batch budget remains 8 by default (maximum 32), and one aggregate
65-second pickup deadline includes discovery waits. Accepted work may finish
after pickup expires, as in the legacy path. Existing durable leases arbitrate
overlapping scheduled executions; failed targets are not retried within a run.

Sorted UUIDs rotate by `schedule_minute` modulo cohort size, independently of
batch size or how much accepted work fits the pickup window. Across N successive
schedule minutes, each of N configured tenants gets first pickup preference once,
including when the first accepted task runs beyond 65 seconds. Later preferences
are visited only while the shared deadline and batch budget permit. Rotation is
fairness only, never permission, and does not promise execution or completion
within a particular minute.

The retained speech observer is bound to a tenant when its provider is built.
Cohort CLI mode refuses any configured speech observation scope before resource
setup rather than attaching the first tenant's observer to another tenant.
Normal speech processing works with observation unset. Legacy exact-target
observation remains unchanged. The optional Core bundle remains singleton-only
and explicitly rejects a multi-tenant configuration before initialization.

## Receiver-first qualification and owner rollout

1. Independently review the final source commit and preserve exact-head local
   tests and size evidence. Actions remains disabled. Merge and artifact release
   require their existing owner-controlled process; this document performs none.
2. Reconcile actual API and separate speech/translation image digests,
   configurations, and database grants against the selected merged source.
   Preserve each accepted prior artifact/configuration for recovery. Do not
   blindly replace deployed drift or assume three different current images have
   equivalent contracts.
3. Qualify the API and worker artifacts with the new mode still off. Existing
   single-tenant admission, pickup, authentication, consent, and owner review
   behavior must pass before any client or broader cohort is enabled.
4. Obtain separate approval for the exact synthetic practice UUID cohort and
   the live database grant/policy update. The existing configured worker
   bootstrap emits sorted validated UUID literals for an opt-in cohort. It
   retains singleton SQL, all existing grants, request-tenant equality RLS, and
   stage/source restrictions. Applying these live grants and restrictive
   policies is a security configuration change and is not automatic or covered
   by source preparation. No migration is added.
5. With intake held, qualify matching API and both worker configurations and
   exact cohort predicates. Switch the existing two scheduled jobs to
   `--cohort-pending` only after their matching artifacts, flags, roles, and
   explicit lists are qualified. Keep speech observation unset for cohort mode.
6. Test two synthetic practices: separate valid consent, admission, microphone
   upload, speech, translation, creator review, and draft-note paths. Reject an
   unconfigured practice, foreign consent/session/claim, expired or revoked
   consent, invalid role, and mismatched request tenancy. Preserve evidence
   without patient content, object names, or secrets. Enable a client/cohort only
   after this receiver/API/worker sequence is accepted.

This bounded implementation does not admit unknown future practices by itself.
General availability requires a separately approved authoritative cohort
maintenance/rollout policy within this limit, or a new architectural decision
for a larger model. Grandfathering preserves existing namespace correspondence
and access decisions; it does not silently bypass downstream admission.

Account cancellation and queued remote processing are separate boundaries.
This change neither creates a cancellation fence nor claims that already queued
speech/translation work consults the Core account cancellation ledger.

## Recovery

Hold configured intake and client cohort enablement first. Stop new cohort job
pickup through its worker enable gate while accepted durable claims finish or
expire under the existing lifecycle. Preserve pending sessions and evidence;
do not delete records or revoke patient consent to simulate rollback.

Restore the accepted singleton list, opt-in flag `false`, legacy exact-tenant
job arguments, and prior accepted API/worker artifacts through the owner release
process. Restore the exact prior live restrictive grant/policy configuration
only under its separately approved security runbook. The ordinary grant reset
and disabled configured permission gate retain their existing closed behavior.
Other admitted practice namespaces remain closed until an approved forward
recovery requalifies them. No database structure is dropped or downgraded.


## Dormant worker renderer follow-on — 2026-11-05

Tier 2 source-only preparation for Goal 1's new-practice/legacy admission work.
The existing schema1 binding and complete output bytes remain the singleton
format, including previously accepted tenant UUID spellings. Unknown/mixed
fields and duplicate JSON keys now fail closed before an output directory is
created. Both worker identity/stage/resource/reference checks remain intact.

Explicit schema2 uses `configured_capture_multi_tenant_enabled: true` and
`tenant_ids` in place of `tenant_id`. It requires 1–32 unique, canonical lowercase,
nonzero UUID strings and preserves their exact selected order. False/missing
opt-in, invalid schemas, unknown top/nested fields and mixed formats are refused.
Both disabled jobs receive the same exact JSON list, the existing multi-tenant
flag and exactly `--cohort-pending`; all remaining output fields are unchanged.
The renderer neither registers tenants nor qualifies an image's support.

This supplies the existing #538 worker mode's missing renderer representation.
It does not enable workers, capture, billing, intake, a practice or unknown future
accounts. The immediate physical build 97 JOIN demo uses the existing singleton and
needs no new native build. Goal 1's selected CREATE/unlinked-practice plan still
requires actual authoritative UUIDs, source-bound API/job artifacts, exact
approved Core/Scribe cohorts and rehearsed complete database permissions, as
specified by this flight plan. Missing lawful BAA/enrollment facts remain a
separate block; global admission-maintenance policy remains unresolved.

Local qualification compares whole schema1 CLI job bytes for both stages and
legacy UUID spellings to the merged #542 baseline, proves only the schema2 list/
flag/arguments delta, and refuses malformed/mixed/duplicate input before output
mkdir without exposing values. Independent final-push review is required.

Recovery before any release is revert this follow-on or render the preserved
schema1 format. After a separately approved rollout, hold new pickup/intake and
restore qualified prior job/image/args/cohort and restrictive role policies via
its approved recovery, retaining pending work and namespace correspondence.
This source change performs no live configuration, grant, schema, activation,
publication, deployment or Core operational preparation. The blocked 350b Core
operator is outside its scope and has no alternate route in this change.

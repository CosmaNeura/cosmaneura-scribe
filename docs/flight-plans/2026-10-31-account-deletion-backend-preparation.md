# Account deletion: concrete backend preparation, policy pending

Tier 2. This is an implementation proposal, not a ratified retention policy,
endpoint implementation, migration, service/access grant, or activation.
The owner has not selected shared-account versus Scribe-only deletion, retained
record handling, or last-owner governance. No account operation may start while
those decisions are pending. Ordinary users receive no new access/onboarding wall.

Sources: Scribe base `0222d1a1cd9cd01761a14fd021551fa270bfbeb6`; Core base
`05f39397f66847fc9b66f9b151fdd286ea3bece3`. The isolated UI diff is preserved.
Relevant local decisions were read: Scribe ADRs 0007, 0013, 0038, 0053, 0096 and
0097. No architecture document from another chat is used as authority.

## Reuse seams and constraints verified in source

- `app/configuration/clerk.py` owns the configured Clerk SDK and normalizes
  verified sessions. `app/routes/embed_context.py` exposes the existing verified
  Clerk identity dependency. Vendor verification stays in configuration;
  application code receives a normalized issuer/subject/session fact.
- `app/routes/scribe_provider_context.py` is the existing native-facade pattern:
  fixed Entra workload plus verified Clerk session, bounded closed JSON,
  view-as rejection, deadline, no-store response and a false-default gate.
  A proposed self-only hook should follow this pattern; do not add global claim
  parsing, a browser impersonation bypass or an arbitrary target-user parameter.
- `app/routes/dependencies/doctor.py:inject_doctor_record` upserts a Doctor and
  rejects a disabled/tombstoned identity. A delete-preview/status hook must not
  call it to create a missing account, and must not require ordinary practice
  admission after an accepted deletion has deliberately revoked it.
- `app/services/doctor_account_closure.py` already has deterministic no-write
  planning and an audited, idempotent operator-only closure. It retains Doctor,
  clinical/legal records and Clerk, soft-disables local access, revokes reviewed
  membership/authority state, removes local video OAuth integration rows, and
  records retained evidence. It is not an in-app self-delete operation.
- That closure preserves Practice-before-Doctor locking and rechecks ownership
  after locks. It requires practice membership; rejects protected superadmin
  capabilities and outstanding Checkout state; requires owner transfer when
  other active members remain, an explicit non-solo wind-down, and resolution of
  a nonterminal final-owner subscription. Do not expose the operator function
  directly, call its private helpers to bypass these gates, or reinterpret its
  seven-year access-evidence retention as a new legal decision.
- `app/celery.py` and `app/jobs/__init__.py` provide existing worker/scheduler
  coordination and metadata-only framework logging. Each job module needs the
  existing callable `perform` convention. A coordinator may reuse these
  containers; no additional hosting is implied.

## Minimal Core self-only contract proposal

One fixed native-facade hook, proposed
`POST /service/v1/agent/scribe/account-deletion`, accepts a closed action union:
preview, request, receipt acknowledgement, and status. Operation IDs and the exact
route are to be reviewed before implementation; nothing is registered here.

Preview/request use the existing verified workload and Clerk-session dependencies.
Require the configured issuer, the original non-view-as session and an existing
exact Doctor binding; resolve authoritative actor, tenant and immutable provider
links server-side. No email lookup, Doctor upsert or client-supplied doctor,
actor, tenant, patient, practice, session or blob prefix can select the target.
A caller may delete only itself; an administrator/view-as session is not a
shortcut to another account.

Preview returns an opaque revision bound to the current owner-approved policy,
original identity, reviewed scope and governance facts. Request sends only the
revision, exact confirmation and an idempotency key. Reject stale scope/policy or
reuse of the same key with different content before any mutation. Request limits,
duplicate-key rejection, no-store headers and fixed error codes follow the native
facade. The actual policy determines the final UI copy; the dormant shared-account
example is not approval to delete Cosmaneura sign-in.

An accepted operation must be durable before any irreversible side effect. Persist
the original-account request key natively before submission. A receipt-acknowledge
stage lets native persist its recovery receipt before a worker may erase content
or revoke Clerk. An initial lost response is then recoverable with the still-valid
session and the same key. This is a proposed recovery protocol, not current UI
behavior or an implemented endpoint.

After Clerk revocation, an expired/deleted JWT cannot authenticate a retry or prove
`already_deleted`. Status therefore needs a separately reviewed, original-operation
read-only recovery proof held by native secure storage. It may disclose only fixed
operation status, never records, account facts or another mutation. Store only its
digest server-side, bound to the original issuer/operation. Such a proof is a new
credential-bearing contract requiring review; none is generated or registered by
this preparation. Keep it out of URLs, logs, browser storage and general APIs.

## Durable operation and step ledger proposal

Use new additive Core structures only after an approved expand rung; do not add a
fictional Scribe user table. Suggested structures are:

| Structure | Required immutable facts and constraints |
| --- | --- |
| `scribe_account_deletion_operation` | original issuer/subject digest, retained Doctor FK, authoritative actor/tenant/provider-link scope, owner-approved policy version and scope, preview/request digests, caller-key digest, requested/acknowledged timestamps, monotonic phase and sequence |
| `scribe_account_deletion_step` | operation FK, unique step code, input-manifest digest, committed result code, bounded attempt/lease state, retry-after, timestamps and metadata-only audit reference |
| `scribe_account_deletion_resource` | operation FK, exact session/binding/admission/object IDs or protected opaque locators, policy classification/hold fact and locator-manifest digest; no arbitrary prefixes or clinical text |

Use actual generated Alembic IDs later. No migration IDs, ORM registration, model,
SQL routine or production schema are created in this lane. Preserve retained
Doctor/authority/custody rows with restrictive FKs; no cascade erasure or silent
reparenting of legacy clinical data. A full manifest and its classification must
be reviewable before it can authorize an eligible-content step.

Suggested monotonic stages: accepted, recovery_receipt_acknowledged, scope_fenced,
inventory_sealed, erasure_intent_acknowledged, eligible_live_erasure_confirmed,
selected_account_action_confirmed, server_complete. Failure records the exact
unfinished stage and remains retryable/blocked; it never becomes success by
advancing the status alone. Physical recovery-copy expiry is tracked separately.

The Core coordinator claims bounded batches under a short lease transaction,
releases that transaction, and uses existing scope-specific lock order for fresh
validation. External calls never hold a PostgreSQL transaction open. Each external
step has a stable idempotency identity plus durable acknowledgement; an uncertain
provider result requires exact read-back rather than a blind second destructive
call. Worker death after any boundary resumes that one original operation.

## Ownership map: attribution is not erasure authority

There are 33 Scribe tables verified from tracked migration CREATE TABLE statements.
The exact names/source lines/source hashes are in the accompanying evidence
inventory. The UI foundation flight plan lists every name; it is not a delete list.

- Core `ScribeCaptureProviderLink` binds actor/authority tenant/source identity,
  Doctor/practice and Scribe tenant UUID. `ScribeCaptureBinding` binds the immutable
  creator, patient/appointment and reviewed scope digest. `ScribeCaptureAdmission`
  joins that binding to exact Scribe tenant/session and consent receipts. Build
  the candidate scope from these authoritative chains, not a whole Scribe tenant:
  multiple creators can share a tenant UUID.
- `scribe_sessions` and `consent_records` retain practitioner, patient,
  appointment and tenant identifiers. `creator_actor_id` was added for configured
  sessions; legacy rows can have it null. Creator equality is useful attribution,
  not sufficient proof of legal erasure. An unresolved legacy mapping remains
  retained/blocked for review rather than being inferred from a name/email/string.
- Audio chunks, session keys, transcripts, normalized source/translation/working
  content and creator edits are processing/content classes. Their session links,
  master acknowledgement, holds and approved deadlines determine eligibility.
- Capture leases/reservations, upload grants, job/start/terminal records, delivery
  receipts and idempotency records are workflow/replay evidence. Do not remove
  them while capture, a lease, retryable delivery, external execution or a dependent
  erasure/restore check remains live. Consent and audit have separate schedules.
- Core `scribe_private_note` is expressly author-only encrypted reminder content;
  its receipt has no reminder text and is retry evidence. Treat reminder content
  and its receipt separately under the still-pending approved policy.
- Core Patient, Appointment, VisitAudioFile, AIVisitTranscript, AIVisitNote and
  retained note versions have Doctor/encounter FKs. They are not generically
  practice-keyed, and account closure does not establish new practice custody.
  Keep the Doctor tombstone and existing clinical relationships. A separately
  reviewed custody/access decision is needed where legal records must outlive
  login; do not claim the UI moves those records to a practice.

Audio locator construction is verified in `storage.py`:
`tenants/<tenant UUID>/sessions/<session UUID>/<channel>/<8-digit sequence>-<object UUID>.enc`.
Resolve exact registered locators under the fixed manifest; never list/delete a
whole tenant/container or log object names/URLs. Keep locators until all required
version, snapshot, backup and replica checks are complete.

## Preserve accepted erasure authority and retention boundaries

ADR 0013 is accepted design-only: Core is the sole legal clinical record, Scribe
is bounded processing, and API/transcription identities do not gain custody DELETE.
The coordinator must call a separately reviewed erasure authority; it must not
execute unrestricted SQL/blob deletion with the existing API credentials.
That authority/routines/grants are not implemented or activated by this proposal.

ADR 0013 requires an immutable acknowledged erasure intent outside PostgreSQL's
backup/failure domain before irreversible work, shared hold/lease/execution fences,
per-session key erasure followed by Blob-version/snapshot absence, ordered metadata
expiry, and quarantined restore replay. Deleting a shared wrapping-key name or
version would affect other users and is never an account-delete step. Existing
`purge_normalized_source_content` also refuses early retention and enforces a purge
marker; do not rewrite expiry or disable its triggers to make a test pass.

Track `live_absent` separately from `physically_expired`. ADR 0013 approves a
14-calendar-day physical-expiry ceiling after live absence; its proposed operational
schedules still require legal approval before enforcement. The attachment's
24-hour full-deletion promise is not an implemented or proven guarantee. Holds,
unacknowledged handoff or recovery copies must be reported truthfully. A UI deadline
must come from an actually supported approved schedule; never invent one locally.

## Receiver-first implementation slices and open gates

1. Approve policy/scope and resolve conflicts with accepted retention design and
   current last-owner/billing constraints. Review exact retention classifications.
2. Add a dormant Core operation/step/resource ledger via approved expand rehearsal,
   without endpoint installation or erasure grants. Test uniqueness, immutability,
   same-key/different-body refusal, leases and crash-resume boundaries.
3. Add the self-only Core hook and coordinator, initially disabled. Verify caller,
   issuer, view-as denial, no upsert, receipt recovery and exact cross-tenant denial.
   Existing owner-closure checks stay intact; any governance change is separate.
4. Implement the ADR-aligned independently authorized erasure path and restore feed
   after its own schema/access approval. Test holds, active leases, handoff/replay,
   every intent/key/blob/backup failure boundary and second-member preservation.
5. Implement native original-account durable request/receipt recovery and scoped
   normal SDK cleanup, then register the optional UI capability. Current
   `application.accept` closes the dialog on native revision/phase change and
   `sameAccountSession` requires ready; this unused UI does not solve revocation
   or restart recovery. Never clear staging storage during production cleanup.
6. Run an explicitly authorized disposable synthetic account/practice test and
   an authorized physical-phone test. Activation/Apple acceptance require real
   service receipts, preserved legal records/other members and truthful deadlines.

Shared-account policy would eventually need the retained closure/Clerk action;
Scribe-only policy must preserve Doctor, membership, authority and Clerk access.
Neither branch is selected here. No ordinary account changes before explicit
user confirmation and reviewed activation.

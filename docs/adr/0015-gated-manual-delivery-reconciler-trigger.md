# ADR 0015: Gate manual delivery reconciliation on identity and claim fixes

**Status:** Proposed

## Context

Scribe has a tenant-scoped `DeliveryReconciler` that can rebuild the canonical handoff payload,
verify its hash and consent, and retry the master-platform request with the delivery receipt's
stable idempotency key. It is deliberately not connected to a route, scheduler, or Container Apps
Job. The current library tests are useful, but they do not make a production trigger safe.

Five gaps block activation:

1. The master platform authorizes one exact `SCRIBE_CALLER_CLIENT_ID`. A reconciler must not share
   the API Container App's managed identity, but a dedicated identity would currently be rejected.
2. Master-platform receipt uniqueness is scoped to the authenticated physical caller:
   `(caller_client_id, idempotency_key)` and `(caller_client_id, scribe_session_id)`. The API and a
   dedicated reconciler can therefore create separate receipts for the same logical Scribe
   delivery. Reusing the existing transcript row does not close the gap because each receipt can
   independently dispatch downstream work.
3. Scribe's direct API claim accepts both `pending` and `retryable` rows without requiring a
   `pending` row to be stale. A second request can increment the attempt and start another network
   call while the first call is still running. The reconciler accepts a caller-provided
   `stale_before`, so the two entry points do not share one claim policy.
4. The reconciler claims an entire batch in one transaction and then performs its network calls
   sequentially. Later rows remain marked `pending` while earlier calls run and can age past the
   stale boundary before this process reaches them.
5. Repository tests do not prove that an execution in the Container Apps subnet can resolve and
   reach the master platform on its private address through both VNets' peerings, routes, private
   DNS links, and NSGs. The current Container Apps NSG and planned peering are configuration
   evidence, not a wire-level acceptance test.

Using the API identity for the job would hide the first two defects by collapsing two security
principals into one. It would also give a background repair process the API's broader database and
Azure authority. Shipping a dedicated job before the master and claim fixes would instead expose
duplicate-delivery races. Neither choice is acceptable.

## Proposed decision

Do not add a runner, job, role assignment, schedule, or activation setting until the following
cross-repository prerequisites are merged and accepted.

### Make logical delivery identity independent of the physical caller

The master platform will authorize exactly two configured managed-identity client IDs for the
`Scribe.Transcript.Write` application role: the Scribe API identity and the delivery-reconciler
identity. It will continue to verify the token signature, issuer, audience, tenant, expiry,
`idtyp=app`, role, and exact client-ID allowlist. Invalid, missing, duplicate, or partially
configured allowlist entries fail closed. This remains an application-role assignment to the
platform API service principal, not Azure subscription IAM.

Both authorized identities map server-side to one versioned logical producer,
`cosmaneura-scribe-v1`. No request header, token extension, payload field, or job argument may
select that producer. Master-platform receipt uniqueness moves to `(logical_producer,
idempotency_key)` and `(logical_producer, scribe_session_id)`. The authenticated client ID remains
available only as the actual caller: the master records it on every create, replay, conflict, and
rejection audit event, while deduplication never uses it as a namespace.

The master migration must backfill existing Scribe receipts to the logical producer, prove there
are no conflicting keys or sessions, and create the new unique constraints before accepting the
second identity. A request through one identity followed by a byte-identical retry through the
other must return the same receipt and platform transcript ID and dispatch the note and engagement
pipelines once. A changed payload, encounter, or session binding remains a conflict. The encounter
lock remains defense in depth; it is not the idempotency boundary.

### Use one canonical, one-row claim operation

Scribe will have one repository claim operation shared by the direct delivery route and the
reconciler. It uses database time and a versioned, deployment-owned in-flight timeout; neither an
HTTP caller nor a job invocation supplies `stale_before`, a retry limit, or a timestamp.

The claim rules are:

- a new delivery may make its first attempt immediately;
- a `pending` delivery is in flight and cannot be reclaimed until its last claim is older than the
  canonical cutoff;
- a `retryable` delivery is eligible only when `updated_at` is older than its versioned,
  server-owned retry delay; and
- `delivered` and `terminal` deliveries are never claimable.

Each transaction selects and claims exactly one oldest eligible row for the supplied tenant using
`FOR UPDATE SKIP LOCKED`, increments its attempt generation, writes a metadata-only attempt audit,
and commits before network I/O. The reconciler completes that row before it claims another. A
bounded, deployment-owned maximum controls work per execution, but the job still owns at most one
in-flight delivery at a time. Concurrent executions may claim different rows; they cannot claim the
same fresh row.

Every failure or terminal completion is a compare-and-set on delivery ID, tenant ID, `pending`
status, and the exact attempt generation returned by the claim. A late failure from an older
generation becomes a no-op. Remote success is monotonic: a valid success may advance a matching,
non-delivered receipt to `delivered`, but no later failure or rejection may regress it. Repeated
success must agree on the bound payload and opaque platform transcript ID; disagreement is a fixed
conflict requiring operator review and never changes the stored success.

Remote acceptance and local session synchronization remain separate transactions. The first
transaction commits the delivered receipt and audit. A second best-effort transaction advances the
session to `handed_off`. A replay repairs that session transition without another effective master
delivery. This avoids rolling back a durable remote acceptance because a later local session write
failed.

Consent, session state, transcript presence, and the canonical payload hash are revalidated after
each claim and before network I/O. Logs contain only fixed actions, fixed error classes, counts,
durations, attempt generations, and opaque tenant/delivery/session IDs. They never contain
transcript text, encounter display data, tokens, endpoints, URLs, or payloads.

### Add a dedicated, false-by-default manual job only after those fixes

The eventual trigger will be an Azure Container Apps Job controlled by two independent settings,
both defaulting to false:

- `deploy_delivery_reconciler_job` creates the manual job, its dedicated user-assigned identity,
  and only the identity's ACR pull role; and
- `enable_delivery_reconciler_job` changes the runner's hard gate and permits creation of the
  database principal and master-platform application-role assignment.

The enable setting is valid only with PostgreSQL, complete master-platform handoff configuration,
the two-caller logical-idempotency migration, and reviewed private connectivity. The runner reads
the raw enable value before parsing arguments, loading application settings, opening PostgreSQL, or
requesting an Entra token. A disabled execution emits one fixed metadata-only event and exits
nonzero.

The base template has no arguments. A governed operator starts an execution with exactly one
positional argument: a tenant UUID. A custom parser rejects missing, extra, or malformed arguments
without echoing them. The stale cutoff, batch bound, endpoint, scope, caller identity, and delivery
or session ID are never runtime arguments.

The job has a commit-SHA image, one completion, parallelism one, platform retries zero, a bounded
timeout, and no ingress, schedule, event rule, queue consumer, or autoscaling trigger. This
configuration grants no person, service, platform identity, or Scribe workload permission to start
it. Container Apps start permission can replace the image, command, arguments, and environment, so
that permission remains separately governed trusted-code-execution authority.

The reconciler identity is distinct from the API, migration, transcription, retention, and Speech
smoke identities. It receives no Blob, Key Vault, Speech, storage-account, or subscription role.
Its PostgreSQL principal has `LOGIN` only through Entra mapping, `CONNECT` on the one database,
`USAGE` on the application schema, and only these column grants:

- `SELECT` on `consent_records (id, tenant_id, appointment_id, practitioner_id, patient_id,
  modality, all_parties_consented, revoked_at)`;
- `SELECT` on `scribe_sessions (id, tenant_id, appointment_id, practitioner_id, patient_id,
  consent_record_id, modality, status)`;
- `SELECT` on `transcripts (id, tenant_id, session_id, segments)`;
- `SELECT` on `transcript_deliveries (id, tenant_id, session_id, idempotency_key,
  payload_sha256, status, attempt_count, platform_transcript_id, last_error_code, updated_at)`;
- `UPDATE (status, attempt_count, platform_transcript_id, last_error_code, updated_at)` on
  `transcript_deliveries`;
- `UPDATE (status)` on `scribe_sessions` solely for the monotonic `handed_off` repair; and
- `INSERT (id, tenant_id, action, entity_type, entity_id)` on `audit_events`, using the database
  default for `occurred_at`.

It receives no `INSERT` on delivery receipts, no access to audio chunks, upload grants, wrapped
keys, idempotency records, transcription jobs, or transcript mutation, and no `DELETE`, sequence,
routine, DDL, ownership, default privilege, role membership, `CREATEROLE`, or `BYPASSRLS` authority.
Dedicated SQL statements must fit these grants rather than reusing a broader API update. Every
transaction sets and tests the one tenant context; there is no global scan.

### Prove the private path before enablement

The job cannot be enabled from Terraform topology alone. Acceptance must inspect both sides of the
peering and route path, link the required private DNS zone to the Scribe VNet, and allow only the
necessary TCP 443 flow from the Container Apps subnet to the platform's private ingress. The
platform-side NSG must allow that exact source; broad internet egress or public fallback is not an
acceptance substitute.

From a disabled-by-default acceptance revision in the same environment and subnet, a synthetic run
must resolve the approved platform hostname to an expected private address, reject any public or
unexpected answer, obtain a token for the exact platform audience with the reconciler identity,
and deliver then replay one synthetic transcript. It reports only fixed pass/fail events. The
master must return one transcript ID, record both authenticated callers when the cross-identity
replay test is exercised, and dispatch downstream work once. Container Apps, platform, proxy, and
network diagnostics must be inspected to prove that authorization headers, transcript content,
request bodies, and query strings are absent or safely scrubbed.

## Activation and acceptance

Implementation is not accepted until automated and live evidence proves all of the following:

- the master admits only the two exact app-only callers with the correct role and rejects all
  other app, delegated, tenant, audience, and role combinations;
- the same logical session and stable key deduplicate across both physical identities, while a
  changed binding conflicts and the actual authenticated caller is audited;
- two PostgreSQL workers cannot claim the same fresh row, a fresh `pending` row cannot be reclaimed,
  and a crashed attempt becomes claimable only after the canonical database-time cutoff;
- a runner claims one row at a time, honors the bounded execution limit, and never leaves a
  preclaimed batch waiting behind network calls;
- generation-fenced late failures cannot overwrite a newer result, success is monotonic, and a
  replay repairs a failed session synchronization without a second effective platform import;
- PostgreSQL RLS denies cross-tenant reads and writes and the reconciler principal has exactly the
  grants listed above;
- disabled, missing-argument, extra-argument, and invalid-UUID executions touch no database, token
  endpoint, or master endpoint and emit no supplied value;
- the deployed job has no schedule, ingress, event trigger, platform retry, embedded argument, or
  Terraform-granted start authority; and
- a live synthetic execution proves private DNS, NSG, TLS, Entra, delivery, replay, downstream
  single-dispatch, safe diagnostics, and fixed metadata-only logs from the real job subnet.

The cross-identity master tests and the Scribe PostgreSQL race tests are release gates, not mocked
substitutes for the live network test.

## Rollout and rollback

Rollout is ordered:

1. Merge and deploy the master logical-producer migration and two-caller authentication while only
   the existing API identity has the application role. Verify existing API delivery and replay.
2. Merge the canonical one-row claim and completion fencing in Scribe. Exercise the direct API
   path and PostgreSQL race suite with no job resource.
3. Deploy the job and dedicated identity with both job settings false. Review the exact image,
   command, empty arguments, identity, NSGs, DNS, peerings, and absence of start assignments.
4. Configure the dedicated database principal and master app-role assignment, enable one reviewed
   revision, and run the live synthetic acceptance for one synthetic tenant.
5. Return the job to disabled after acceptance. Later manual repair runs require an approved tenant
   UUID and separately governed operator start permission; scheduling requires a new ADR.

Rollback first removes operator start authority, cancels active executions, and deploys a revision
with the hard gate false. It then revokes the reconciler's master application-role assignment and
database login/grants. Existing receipts, audits, the identity, and the corrected master logical
deduplication schema remain in place. The direct API delivery path continues to own normal handoff,
and retryable receipts remain durable for governed repair. Rollback never deletes receipts,
transcripts, or audit evidence and never reintroduces physical-caller-scoped uniqueness.

## Consequences

- A background repair process gets its own narrow identity without weakening cross-identity
  idempotency.
- Crashes and concurrent manual starts are recoverable without parallel calls for one fresh
  receipt or stale failures regressing success.
- Repair remains tenant-scoped, bounded, manual, false by default, and operationally slower than a
  schedule.
- Activation requires coordinated master-platform, Scribe, Entra, PostgreSQL, and private-network
  changes plus a live synthetic proof.
- This ADR adds no runner, Container Apps Job, role assignment, database grant, schedule, client,
  clinical transcription enablement, or `PLAN.md` change.
- ADR 0016 continues to own the separate authenticated client-capture path; client completion does
  not start this reconciler or a transcription job.

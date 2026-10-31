# Account deletion: dormant UI foundation and verified ownership map

Tier 2. Source-only; no self-delete backend, host adapter, migration, deployment,
Clerk mutation, account deletion, model/configuration/secrets change, or Apple
upload is included. No PR is published yet. The CTO document is design input,
not a production or destructive-action authorization.

## Result of this slice

`apps/capture/src/provider/account-deletion.ts` owns exact DELETE confirmation,
stop-before-request fencing, same-account checks, one in-flight request,
idempotent retry, pending status, and local-cleanup completion. The separate
full-screen dialog uses those states. `application.ts` prepares a capability-gated
Account entry below Sign out. No current native, iPhone or Desktop app host
registers that capability, so existing sessions gain no button or access wall.
A future reviewed native host and authenticated Core endpoint must supply it.

A server preview supplies the deletion scope, retention statement and sole-owner
fact. The UI explicitly warns that shared Cosmaneura sign-in deletion also removes
platform access. It never claims a 24-hour deadline from a local fixture or shows
completion until both a completed server receipt and owned native cleanup succeed.
No identity is accepted in the deletion request body. Cancellation before a
request performs no workspace, server or credential action. Cancellation cannot
undo a submitted request; the UI offers status/retry instead.

## Verified source ownership

Scribe snapshot:0222d1a1cd9cd01761a14fd021551fa270bfbeb6.
Core snapshot:05f39397f66847fc9b66f9b151fdd286ea3bece3.

- Core `app/configuration/clerk.py` owns the existing Clerk backend SDK/key;
  `Doctor.clerk_id` mirrors that shared identity. Deleting it removes the whole
  Cosmaneura sign-in, rather than an independent Scribe identity.
- Scribe `service_auth.py` authenticates the Core Entra workflow caller and its
  verified tenant context. It does not accept a native Clerk JWT directly on a
  general self-delete endpoint. A minimal Core self-delete orchestrator must
  normalize the caller and resolve authoritative actor/tenant/provider mappings;
  its Scribe operation is service-authenticated and fixed to that resolved scope.
- There is no Scribe user table. `beta_ingest_store.py` is process-local synthetic
  preview persistence, not production account or recording storage.
- Core `Patient` and `Appointment` contain Doctor foreign keys. `AIVisitNote` and
  `AIVisitTranscript` retain Doctor/Appointment references; notes also retain
  prior generated versions. Those rows cannot simply be deleted or silently
  reparented to a practice. `ScribeCaptureBinding` has an immutable reviewed
  practice mapping. Legal custody and legacy records must be decided explicitly.
- Core `scribe_private_note` is explicitly author-only content and is separate
  from clinical notes/source models. Its `scribe_private_note_receipt` is retry
  evidence. Eligibility to purge these is still an owner retention decision.
- Native `ClerkKitWorkspaceDriver.signOut()` calls the pinned SDK's normal
  sign-out. `NativeWorkspaceAuth.signOut()` persists an app-local access fence
  and confirms cleanup before returning signedOut. `KeychainAccessBlock` is one
  Boolean; it explicitly does not clear Clerk credential records. Do not use it
  as a token-purge API or delete the new production recovery journal blindly.
- `provider-preferences.ts` has one account-hash-scoped localStorage entry,
  `scribe-preferences-v1:<SHA256(account)>`, containing only language, modality and
  audio selection. Any deletion must remove only that original account's entry.
  Native workspace/patient-match journals use protected host storage and are not
  a broad localStorage purge target.

## Exact Scribe table/blob inventory requiring a retention decision

These names are verified from tracked migration CREATE TABLE statements. This is
an inventory for implementation review, **not a delete list or authorization**.

- Primary custody/content: `consent_records`, `scribe_sessions`, `audio_chunks`,
  `transcripts`, `session_audio_keys`.
- Capture/lease and upload metadata: `audio_upload_grants`, `capture_leases`,
  `capture_lease_receipts`, `audio_chunk_reservation_batches`,
  `audio_chunk_reservations`, `audio_chunk_reservation_batch_items`,
  `audio_upload_authorization_receipts`, `capture_channel_finalizations`.
- Derived content/evidence: `normalized_source_transcripts`,
  `normalized_source_segments`, `normalized_source_receipt_keys`,
  `normalized_translation_attempts`, `normalized_translation_reviews`,
  `normalized_working_transcripts`, `normalized_working_translation_inputs`,
  `normalized_working_review_inputs`, `normalized_working_segments`,
  `normalized_working_blockers`, `encrypted_translation_jobs`,
  `creator_transcript_edits`.
- Dispatch/state and durable retry/audit evidence: `transcription_jobs`,
  `transcript_deliveries`, `external_session_terminal_events`,
  `source_start_attempts`, `source_start_extensions`, `source_start_retirements`,
  `idempotency_records`, `audit_events`.

Audio blob names are built by `storage.py` as
`tenants/<tenant UUID>/sessions/<session UUID>/<channel>/<8-digit sequence>-<object UUID>.enc`
in the configured container. The storage interface currently issues upload grants;
there is no account-scoped blob deletion operation. Do not list/delete a whole
container, tenant, practice or arbitrary user-supplied prefix.

The existing normalized-source purge requires actual retention expiry, a session
purge marker, locks and lifecycle/audit updates. Normalized-source, working and
creator-edit tables have delete fences; terminal/audit evidence is retained.
A deletion request must use an explicitly reviewed retention/custody path rather
than weakening those gates or merely dropping session rows.

## Next deployable slices and required policy

1. Owner confirms whether the shared Clerk account itself is deleted, which
   clinical/consent/delivery/audit records remain, and whether a last-owner
   practice can become ownerless. A deleted-login Doctor tombstone can preserve
   clinical FKs; it is not proof that practice custody/access is solved.
2. Minimal Core self-only orchestrator + durable pending request/outbox and
   metadata-only audits; use the existing worker/scheduler after a reviewed
   migration, not a new service. Revalidate caller/ownership before mutations.
   Reconcile any cross-service step independently and do not delete Clerk until
   the eligible-content work is durably completed. A lost response after Clerk
   revocation needs a narrowly scoped native-held status receipt; expired Clerk
   credentials cannot be treated as valid authentication for retry. Persist the
   original-account request key and receipt across dialog closure and app restart;
   the dormant controller's in-memory key is not a durable deletion saga.
3. Service-authenticated Scribe eligible-content operation with exact immutable
   scope and reviewed retention handling; retain clinical/custody/audit evidence.
   Use existing credentials only. Failure does not become a false success.
4. Exact normal native cleanup and account-scoped preference/journal cleanup;
   adapter mounted in the signed-in iPhone Account panel only after backend
   readiness. Native must retain the original-account deletion recovery binding
   when Clerk revocation closes ordinary access. No current host implementation
   changes are part of this slice.
5. Disposable synthetic staging user/practice/second-member test, then an
   owner-authorized physical-phone test. The attached phone remains off limits
   for this parallel workstream. No production user is a deletion test target.

The actual controller has nine passing dependency-free Node lifecycle checks,
including an independently identified late-retry terminal-completion regression.
Native TypeScript stripping plus JavaScript syntax checks pass for the controller
and dialog; these are not TypeScript type checks. The actual dialog was rendered
with a synthetic host at a real 390-pixel same-origin iframe viewport and a
1280-pixel viewport. Both show no horizontal overflow, exact DELETE gating and
the qualified warnings; no deletion request was submitted. Screenshots were
visually inspected. Chrome's direct requested 390-pixel window produced a
500-pixel layout, so that render is not claimed as a 390-pixel check.

The cloud-backed dependency folder stalled and its initial attempts were
terminated. A new owned local cache uses pinned npm 11.5.2 and Node 24.22.1;
`npm ci --ignore-scripts` preserves both dependency locks. Building the existing
secure-queue TypeScript declarations restores its normal prepare prerequisite.
All six repository TypeScript workspaces now pass. The changed-source ESLint
check passes after the test mocks retain their typed mock callbacks.

The complete capture Vitest suite passes 77 files / 958 tests, including the
17 deletion cases. The four targeted deletion/identity/iOS-host/native-backend
suites pass 109 tests. The capture script-tool fixtures pass seven Node checks.
The 13 existing Account/sign-out Playwright cases pass in official Chrome against
the unchanged synthetic account fixture, with no real backend or phone. Small
screen screenshots were visually inspected. The sandbox-only full-suite attempt
timed out; targeted tests exposed loopback EPERM. Repeating with only the needed
synthetic loopback access passes; the failed attempt is not relabeled as success.

Repository-wide ESLint still reports 225 errors in 36 files, all proven byte-
unchanged from the base; none belongs to this diff. Those unrelated files and
lint rules are preserved. This is not a claim that repository-wide lint passes.
Final pushed-head independent review/durable PR evidence, backend, staging,
physical-phone and Apple acceptance remain open. Checks and render artifacts are
in `/private/tmp/scribe-account-deletion-checks-20261031-01`. Concrete backend
preparation and accepted retention-design constraints are in
`2026-10-31-account-deletion-backend-preparation.md` alongside this plan.

Recovery: omit/revert these unused UI exports and CSS. They change no persisted
state or current app behavior. Future irreversible deletion has a separate
reviewed recovery policy; deleted identity/content cannot be promised reversible.

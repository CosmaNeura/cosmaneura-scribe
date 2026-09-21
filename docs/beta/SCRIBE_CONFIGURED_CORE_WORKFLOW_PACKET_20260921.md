# Configured admission and existing Core SOAP — next local packet

Status: explicitly approved by the owner ("I approve the configured admission
and Core soap packet") and implemented locally, 2026-09-21. The latest
real-services checkpoint records qualification and retained evidence.

Starting gap: the review consumer was locally verified, but a new Core admission
creates the older `SessionCreate` contract. The Scribe configured capture runtime
had no ordinary authenticated admission route. Core's note reader also required
the older raw/working-source envelope. A review URL change cannot make these
contracts compatible, and existing sessions must not be converted.

## Approved scope

Approve completing the **local configured capture → review → existing Core SOAP
and creator encounter flow**, in the same two checkouts with synthetic data only.
Include the smallest additive local schema/contract work needed to retain exact
admission and reviewed-source lineage. No hosted or native activation is included.

1. Expose Scribe's existing `CapturedSourceRuntime.admit` through a closed,
   default-off receiver using its existing Entra workload boundary. Reuse its
   immutable creator, consent, language and source-profile validation. No changes
   to `service_auth.py`, new identity parsing, or provider calls at admission.
2. Extend Core's existing admission route, protocol/client and phase journal to
   retain an explicit configured session request and digest. Bind the existing
   internal actor server-side; accept only supported language selections as
   preferences. Keep legacy admission separate, replay the exact original
   request after interruption, and reject changes after reservation. Inspect
   `ScribeCaptureAdmission` and its retained JSON/constraints before choosing the
   smallest additive migration; do not repurpose legacy consent evidence.
3. Read the reviewed English source through the verified creator contract and
   adapt its current source/working/review lineage to Core's existing canonical
   transcript import and SOAP path. Primary touchpoints are
   `scribe_capture_notes.py`, its source contracts/mapping, and the existing
   `scribe_transcript.py` importer. Preserve original source and translation
   history in Scribe. Do not manufacture raw-source, interruption or acceptance
   evidence to satisfy an older envelope. If a new immutable mapping is needed,
   add it locally rather than reinterpret old mapping rows.
4. Reuse existing note preparation, creator reads, edits and recovery. Reauthorize
   before protected reads and note publication. An explicit accepted translation
   does not approve a clinical note. Keep Scribe free of clinical reasoning.
5. Compare the two existing migration lineages read-only, then rehearse the exact
   candidate contracts and any generated additive revisions only in new owned
   disposable databases. No reconciliation or apply to either shared schema.
   Test admission interruption, mismatched identity/configuration, stale source,
   lost replies, revocation, accepted-only English note input and same-encounter
   canonical persistence, using the existing synthetic note-model fixtures.

Recovery leaves the new paths disabled and additive local structures unused.
Preserve the current foreign Core changes and capture this increment separately.
Do not import another branch, push, create a PR, merge or contact another task.

## Explicit exclusions

No Core auth/session-policy changes, Clerk/IAM, native token custody, founder
invite/grant changes, live services, clinical data, existing-session conversion,
shared/cloud migration, environment settings, deployment, cohort enrollment,
phone-reachable backend, device/signing qualification or release. No repeat of
completed private Speech/translation trials. Physical desktop/iPhone and real
identity/release acceptance remain open after this local packet.

The prior review-consumer packet explicitly excluded configured admission,
migration reconciliation and the canonical SOAP consumer. Handoff §4 required
new exact authority for these additional Core edits; the owner's subsequent
approval authorized the local scope above. Migration reconciliation, shared apply
and every listed activation exclusion remain outside it.

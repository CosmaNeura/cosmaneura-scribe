# Recover preparation after consent expires before admission

Installed qualification exposed a Core image missing aiohttp. Core18 fixes that
dependency. While it was corrected, the saved preparation exceeded Core's
ten-minute freshness window. Retrying the original attestation strands the
installed app before a recording is admitted.

Recovery first sends the existing supported null-attestation admission request.
An existing admission is resumed with its retained key and original Core consent.
Only Core's exact, versioned `CAPTURE_CONSENT_REQUIRED` refusal can offer a fresh
consent confirmation. Other conflicts, timeouts and revoked access remain closed.
The receiver and native bridge expose one fixed code, never arbitrary error data.

The clinician explicitly confirms the same displayed language, modality and
regions. Only this action supplies a fresh timestamp. The retained journal and
idempotency key remain immutable; Core stores the new attestation. If the reply
is lost, the null-attestation recovery finds the existing operation. The client
does not automatically refresh consent or start a source.

Scope: provider client/UI, receiver error mapping and mirrored native response
sanitizer. No Core policy/schema change, credential, identity, entitlement,
journal-format, proof-retention or authority-boundary change. Preserve the
approved synthetic practice and current installed signing identities.

Release the compatible receiver first, then the rebuilt desktop and iOS clients.
Older clients retain their generic error behavior. Before the receiver update,
new clients fail closed. Roll back to the recorded receiver/client predecessors;
retain Core18 and all existing server/journal records. Validate exact and false
refusals, explicit UI confirmation, lost-response resume and immutable journal,
then continue the actual installed capture-to-note workflow.

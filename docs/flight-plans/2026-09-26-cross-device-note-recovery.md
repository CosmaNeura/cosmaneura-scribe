# Reopen uploaded work on another device

Tier 2. A Mac without the iPhone's local journal showed recording setup for an
encounter whose note was already saved. When no local progress exists, ask the
existing authorized Core facade for `provider_encounter`. Only its explicit
not-prepared receipt opens recording setup. Errors retain the recovery screen.

Uploaded sessions open the existing creator review and Core note workflow.
Unfinished recording stays with its original device. Discovery never submits
consent, obtains a recording key, starts recording, uploads, or creates a note.
Keep pending local preparation/save intents first and reuse the discovery review
once to avoid a duplicate opening request.

The encrypted workspace journal gains version 2 for uploaded-only recovery:
`admission: null`, verified session ID, uploaded true and existing pending-save
format. Do not invent a consent attestation. Version 1 remains unchanged for
original-device capture. Recovered work cannot transition to recording or
replace its session. Older clients fail closed on the new journal version.

Release Core's provider_encounter receiver first, then this Scribe receiver
allowlist and Mac/iPhone bundles. Recovery preserves both journal versions and
uses a compatible client; never reset data or replace keys. Local tests cover
server discovery, scope/cancellation, encrypted persistence and compiled UI on
the existing iOS 17 compatibility fixture. Device acceptance follows packaging.

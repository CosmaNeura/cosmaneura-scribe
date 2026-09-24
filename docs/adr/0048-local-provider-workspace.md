# ADR 0048: Local configured provider workspace

Status: accepted for the owner-approved local provider flow, 2026-09-21.

## Decision

Extend the separate provider entry with `mountProviderWorkspace`. It composes
Core-owned encounter selection and creation, manual language and all-party
consent, the retained encrypted recorder, creator transcript review, existing
Core template/note generation, versioned edits, save resolution and encounter
navigation. No second note engine or browser identity authority is introduced.

The authorized host supplies a fresh Core binding, its existing server-side
request transport, abort signals, scoped encrypted journals and exclusively
locked recorder resources. Workload/mount credentials remain outside the view.
Core reauthorizes every operation. The default preview does not mount this entry.
The owner retains activation; the local-only composition has no tester cohort
and must be reassessed before native/hosted activation, by 2026-09-30.

Configured recorder preparation persists its admitted UUID before key or lease
work. It never calls legacy consent/session admission or raw transcript APIs.
Restoring confirmed upload proceeds to fresh creator review without requiring an
expired recorder capability or audio key. Acquisition still requires an explicit
start. Deactivation stops acquisition and retains recoverable work without
starting upload. An unconfirmed stop prevents switching to another recorder.

Admission and pending note edits use the existing encrypted native queue's
revision-checked create/CAS operations in a separate reserved namespace. Recovery
records bind environment/creator recovery scope, workspace, appointment and Core
binding. A pending request must retain its exact key, language, attestation or
note edit. There is no plaintext/native-to-browser fallback. The browser rehearsal
uses an explicitly separate WebCrypto test plugin; it does not qualify Keychain.

Note receipts must match fresh reviewed source lineage, template, session and
Core's ordered-field hash. Save resolution verifies Core's canonical request
hash, then reads the current note; a past receipt is never current authorization.
If an unsaved request is fenced and its base is unchanged, restore those edits
for an explicit new save. Translation acceptance does not approve a clinical
note. Notes remain labelled unreviewed. Abort clears protected DOM and ignores
late requests; pending encrypted recovery survives.

## Verification and recovery

Use focused negative/recovery tests and the actual rendered provider entry over
local Core and Scribe HTTP routes with invented data and generated WAV audio.
Verify exact RSA/AES decryption, explicit translation review, canonical Core
transcript/note history, lost admission/save responses and sign-out clearing.
Use a newly owned private-socket cluster, with unique restricted test roles and
no TCP. Keep failed fixture runs and the final passing evidence.

No production backend/schema/auth changes are part of this increment. Core's
previously approved dirty checkout is byte-for-byte preserved. Recovery leaves
the provider entry unmounted and preserves encrypted pending records. Do not
activate the published preview, deploy, change native auth policy, repeat live
service trials, or claim device/release acceptance from local browser evidence.

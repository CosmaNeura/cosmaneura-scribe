# Repeatable mobile and desktop encounters

Tier 2: patient selection and creation through existing verified native accounts.
Owner: John; staging release and idle native updates authorized on 2026-09-29.
Production is excluded. No new dependencies or changes to microphone consent.

Core owns exact patient, appointment and provider correspondence. Its additive
receipt makes a caller-retained creation UUID idempotent. Scribe only forwards
normal verified human authentication to a fixed Core endpoint. The receiver
continues to read the existing registry; it receives no registry writer grants.
Legacy workspaces and their recovery scope identifiers remain unchanged.

The same New encounter screen serves iPhone and desktop. It defaults the visit
to now, offers exact patient selection or explicit name/date-of-birth creation,
and opens the existing consent/recording pathway. No timezone field is shown.
The active account and Staging destination come from the authorized catalog.
Desktop IPC accepts closed setup actions and does not expose credentials.

Before submission, the creation intent is retained with the existing encrypted
SecureQueue (mobile) or Keychain-protected durable record store (desktop).
Uncertain replies retain the key and input across restart. A confirmed reply
opens the exact returned appointment. Parallel/different intents are rejected
until the first outcome is resolved. Recording and note journals are separate.

Release Core and rehearse its additive receipt migration first. Then deploy the
compatible receiver, enable `encounter_creation_enabled` for reviewed staging
provider mappings, and install matching idle desktop/mobile bundles while
preserving their identities and data. Owner review of this release control is
due 2026-10-30. Roll back by disabling creation and restoring the prior immutable
receiver/Core images and native bundles. Retain all receipts, created records,
keys, recordings, uploads and notes. Do not drop the Core receipt table.

Acceptance: three fresh supported encounters without fixture repair; lost
response/restart and duplicate retry; current account and read-only support
scoping; consent, recording/upload, transcript, prepare/edit/save/reopen; prior
recordings and recovery retained. Record automated, simulated, physical and real
two-party Zoom evidence separately. Human sign-in or workforce agreement is not
manufactured. No invitations or messages are sent to other users.

Physical acceptance found that iPhone build 46 could load the catalog but its
native action parser lacked `encounters`, rejecting patient discovery before a
server request. Match the reviewed desktop contract in the iPhone bridge and
require both connection and transport files to match before native assembly.
Native checks must exercise patient discovery and creation through that parser,
including request/response size limits. JavaScript mocks alone do not qualify it.
This correction needs a same-identity iPhone update; Core, receiver and desktop
remain on the deployed compatible release. Preserve build 46 and all app data
for recovery. Repeat physical creation through the consent screen, then the
recording-to-saved-note check; compilation is not physical acceptance.

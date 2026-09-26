# Native provider recorder integration

Tier 2: connect the existing native key, lease, PCM and source owners to the
provider controls and existing ciphertext uploader. No Core protocol, consent,
identity or storage migration changes. Owner authorization is the long-visit
implementation request; local checks and implementer review are the merge gate.

New iPhone recordings select this controller only when the authenticated native
plugin advertises version 1 and the native app declares audio background support.
The standalone candidate assembler adds that declaration while retaining its
existing disabled provider profile. This change does not install, activate or
deploy a build. Existing browser flow intents or keys select their original
recorder. Unknown native custody is refused by the native host, never overwritten.

The process owns a single native host. Every command binds a recorder handle and
native auth revision; opening rechecks the Core mount/context. Closing retains
failed stop proof and returns no recording data after revocation. The renderer
keeps its existing exclusive lock until native close confirms. Backgrounding the
WebView does not own capture lifetime. Account changes and deliberate exit fence
capture. Resume is always explicit.

The UI reuses the microphone selector, signal meter, recording controls and Core
review flow. Opening preloads key custody; a matching microphone preference adds
no bridge request. Start feedback is immediate and can be cancelled. Native sealed
completion metadata freezes the final sequence, lease and idempotency intent.
Uploads reuse CaptureQueue and its bounded ciphertext reads. Completion requires
every recorded sequence registered; only registered bytes may be purged. Lost
responses and reopening replay the same completion intent and preserve keys.

Validate native command parsing, scope/handle fences, failed open/close custody,
late acquisition, legacy selection, upload/reopen retry, the actual compiled UI,
full TypeScript suite and complete unsigned iOS plugin. Component tests do not
qualify installed screen-lock behavior or live Zoom/Chrome capture.

Recovery: stop and confirm active capture before changing builds. Retain native
journals and keys. An older build cannot recover new native custody, so rollback
must retain this native recovery capability or finish pending uploads first.
Staging reconciliation, same-identity native candidate activation and physical
acceptance remain separately tracked; no fixture/data or deployment authority
is added here.

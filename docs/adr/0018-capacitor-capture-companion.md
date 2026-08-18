# ADR 0018: One Capacitor codebase supersedes the React Native mobile decision

**Status:** Accepted (Phase 2 foundation implemented; product recording pending)

Phase 1's server-side reservation, lease, capability, receipt, and generated wire contract is
specified by ADR 0019 and merged with its PostgreSQL/RLS gates and cross-language vectors before
this Phase 2 scaffold was created. All server and client activation flags remain false.

## Context

ADR 0009 made web and mobile capture separate first-class clients, chose React Native for mobile,
and required that "the mobile app is not a webview." ADR 0016 then defined the full client capture
path — platform BFF authentication, chunk reservations with server-issued AAD, the encrypted
envelope protocol, the private upload edge — and assumed the native client would hold key custody in
native modules.

The product owner has directed a scope change: a focused recording companion (record a consented
visit → secure upload → server-side transcription → read-only transcript view) built with
Capacitor, so one TypeScript codebase serves both the P1a web/PWA client and the P1b iOS/Android
shells. ADR 0016 already requires the clients to share generated protocol code and visual
components; Capacitor takes that sharing to its limit by collapsing two client builds into one.

## Decision

- Build one Capacitor application at `apps/capture/` in this repository, replacing the
  `apps/web-capture` and `apps/mobile-capture` stubs. It is the P1a PWA and, through the Capacitor
  iOS and Android platforms, the P1b native shells. It talks only to the master platform BFF
  (authorization-code + PKCE on native; the platform's same-origin session on web) and implements
  the ADR 0011/0016 client protocol via the generated protocol package. It never calls Scribe,
  Blob Storage, or Azure control-plane endpoints directly except through the separately governed
  ciphertext-upload capability defined by ADR 0016. Nothing in ADR 0016 is weakened by this
  decision; it remains binding in full.
- This supersedes ADR 0009's framework choice and its "not a webview" constraint, and refines the
  native implementation described by ADR 0016's "Separate web and native custody" section.
  Everything else in ADR 0009 survives unchanged and binding: platform-specific acceptance tests for
  background/lock/audio-route/interruption behavior, signed native builds, the encrypted offline
  queue, local purge, and the prohibition on PHI in analytics, crash reporting, notifications, and
  unencrypted caches.

### The custody model change, stated honestly

One source tree does not create one custody profile. ADR 0016's web/native distinction remains
binding; Capacitor changes the native implementation boundary, not the browser's security model:

- **PWA profile:** the PWA runs in a normal, allowlisted platform web origin. Its active DEK is a
  non-extractable WebCrypto `CryptoKey`. A tested browser may persist that origin-bound key in
  IndexedDB only under ADR 0016's browser allowlist and recovery controls. It has no access to a
  native secure-storage plugin, remains exposed to same-origin script compromise, and is never
  described as device-bound or hardware-backed custody.
- **Native iOS/Android profiles:** the packaged first-party webview
  (`capacitor://localhost` and the Android equivalent) executes the protocol's WebCrypto operations
  while a DEK is active. Phase 3 must protect the DEK at rest with a separately reviewed native
  wrapping-key design: a this-device-only, non-synchronizing Keychain-backed design on iOS and a
  non-exportable AndroidKeyStore key on Android, with cloud backup and device migration disabled.
  This ADR calls that OS secure-storage, device-bound protection. It makes no blanket
  hardware-backed claim unless platform attestation and device acceptance tests later prove one.
- Both profiles ship no third-party script or analytics and enforce a strict CSP. Code executing in
  either active origin can use an active DEK, exactly as ADR 0016's threat model concedes for a
  compromised client process. No capture client of any framework is safe after full client-process
  compromise.
- Native modules own native audio capture, background/lock behavior, and secure storage. A separate
  PWA foreground adapter must produce the server-advertised raw PCM WAV profile through a tested
  browser path such as an `AudioWorklet`; the existence of a Swift/Kotlin PCM plugin does not prove
  the PWA path. Lossy `MediaRecorder` output and lossy-to-WAV relabeling are rejected. Any required
  lossless PCM sample-format or sample-rate conversion must be versioned, bounded, and proven
  against golden audio vectors rather than guessed by the client.

### Generated protocol boundary

The generated protocol package requirement in ADR 0016 is literal. Phase 1 must establish one
versioned authoritative protocol source and generated Python and TypeScript implementations with
cross-language golden vectors. Independently hand-maintained "thin" implementations are not an
acceptable substitute; choosing one would require an explicit amendment to ADR 0016 before code is
written.

The client protocol surface includes the encrypted-envelope header and framing, relevant enums and
limits, and the exact `chunk_additional_data` encoding used for AES-GCM AAD. The
`track_additional_data` function is a server-only worker detail for encrypting assembled temporary
tracks. It is not part of the client package or reservation contract.

### Phase 2 implementation record

The shared foundation uses Vite 8.2.1, Lit 3.3.3, and strict TypeScript 5.9.3 without a router or
state-management runtime. TypeScript is pinned to the newest release supported by the locked
OpenAPI generator. Capacitor core, CLI, iOS, and Android are pinned together at 8.5.0. The
permanent native identity is `com.cosmaneura.capture`, displayed as **Cosmaneura Capture**.

The client imports the authoritative generated capture-protocol workspace package and generated
OpenAPI types. Its explicit durable queue implements `reserved -> encrypted -> uploading ->
uploaded -> registered -> purged`; unknown upload results are resolved from the server receipt,
expired upload credentials are refreshed without changing reservation/AAD/envelope bytes, and at
most two ciphertext uploads run concurrently. One origin-wide Web Lock serializes drains across
PWA tabs; a browser without that primitive fails closed pending a reviewed alternative. The local
mock BFF and upload target use synthetic data only and are not a production proxy.

The durable Phase 2 queue starts at the canonical server reservation receipt. Phase 3 must add a
separate durable pre-request intent for the reservation idempotency key and exact body before it
sends that mutation; storing the key only in the returned `reserved` record does not close a lost-
response window and is not claimed as complete here.

The PWA queue is encrypted with AES-GCM under an origin-bound, persisted non-extractable WebCrypto
key. Native queue records are encrypted by a narrow first-party Capacitor plugin. On iOS its
native-generated AES key is held in a non-synchronizing, this-device-only Keychain item; on Android
the AES key is non-exportable in AndroidKeyStore. Records use no-backup storage on both platforms.
This storage key protects already-encrypted queue records; it is not the per-session audio DEK and
does not satisfy Phase 3 active-DEK custody by itself. The plugin never sends its key over the
JavaScript bridge.

Capacitor 8.5.0 has no sync dry-run. CI therefore builds the web bundle, runs the real platform sync
in a clean checkout, and rejects any tracked or untracked delta. It also compiles the Android app on
JDK 21/SDK 36 and the unsigned iOS simulator app with Xcode 26. The repository still makes no claim
about physical-device audio, interruption/background behavior, signing, store distribution, or
hardware-backed keys; those remain Phase 3 acceptance work.

### Server prerequisites confirmed after Phase 1

Phase 1 made PCM16 mono 16 kHz WAV the authoritative capability profile and the assembler now
rejects any other channel count, sample width, frame rate, or compression type. The native audio
plugin and PWA adapter do not exist in Phase 2; Phase 3 must prove each produces byte-for-byte input
conforming to that generated contract before recording can be enabled.

The focused companion also depends on three server/platform operations that do not yet exist as
client-callable contracts:

- a governed internal trigger that claims a completed upload, revalidates consent, and starts the
  leased transcription path without exposing Container Apps Job control to a client;
- a tenant-scoped, metadata-only transcription status/receipt operation suitable for bounded BFF
  polling; and
- an authenticated, audited consent-revocation mutation that immediately closes capture authority
  and makes subsequent worker revalidation fail closed.

Those are activation prerequisites, not permissions for Phase 0 to invent client workarounds. They
must be designed behind false-default gates and exposed to the companion only through the master
platform BFF.

### What this ADR does not do

It does not implement recording controls, native/PWA raw-PCM capture, session DEK creation or
wrapping, production BFF routes, the ciphertext edge, transcript UI, signing/distribution, or
clinical activation. It does not change server behavior, expose Scribe publicly, alter the custody
or envelope protocol, or enable any tenant flag. Governed transcription trigger/status and consent
revocation remain activation prerequisites even though the false-default capture protocol has
merged.

## Consequences

- One source tree serves the PWA and both native shells; platform-specific builds, releases, and
  acceptance evidence remain separate while protocol fixes land once.
- Web and native retain materially different custody and runtime promises. The native profiles use
  OS secure-storage, device-bound wrapping at rest and WebCrypto in the packaged webview while
  active; the PWA remains a general-origin WebCrypto application.
- Capacitor's webview is a platform dependency: OS webview updates can change recording-adjacent
  behavior and are covered by the ADR 0009 acceptance-test obligation that survives this decision.
- A future need for capabilities Capacitor cannot deliver (for example, guaranteed long-running
  background capture) reopens this decision explicitly rather than being worked around.

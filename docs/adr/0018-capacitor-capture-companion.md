# ADR 0018: One Capacitor codebase supersedes the React Native mobile decision

**Status:** Accepted (implementation pending; no client code exists yet)

Phase 1's server-side reservation, lease, capability, receipt, and generated wire contract is
specified by ADR 0019. No `apps/capture/` implementation may begin until that false-default
contract and its cross-language vectors have merged with all PostgreSQL/RLS gates green.

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
  while a DEK is active. A native secure-storage plugin protects the DEK at rest with a
  non-exportable, this-device-only Keychain/Keystore wrapping key; cloud backup and device migration
  remain disabled. This ADR calls that OS secure-storage, device-bound protection. It makes no
  blanket hardware-backed claim unless platform attestation and device acceptance tests later
  prove one.
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

### Server prerequisites confirmed during Phase 0

The current assembler accepts valid uncompressed WAV chunks and requires chunks in a track to have
the same channel count, sample width, frame rate, and compression type. It does **not** yet enforce
mono, 16-bit samples, or 16 kHz. Before client implementation, Phase 1 must make the authoritative
media profile explicit in the capability contract and enforce PCM16 mono 16 kHz at the server
boundary. The native plugin and PWA adapter must then prove byte-for-byte conformance to that
contract.

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

It does not implement a client, change server behavior, expose Scribe publicly, alter the custody or
envelope protocol, enable any tenant flag, or activate clinical capture. The server prerequisites
(reservations, capability bootstrap, capture lease, generated versioned protocol package with
cross-language golden vectors, governed transcription trigger/status, and consent revocation)
precede product client code.

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

# ADR 0018: One Capacitor codebase supersedes the React Native mobile decision

**Status:** Accepted (implementation pending; no client code exists yet)

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
  the ADR 0011/0016 client protocol via the generated protocol package. Nothing in ADR 0016 is
  weakened by this decision; it remains binding in full.
- This supersedes ADR 0009's framework choice and its "not a webview" constraint, and narrows
  ADR 0016's "Separate web and native custody" section as described below. Everything else in
  ADR 0009 survives unchanged and binding: platform-specific acceptance tests for
  background/lock/audio-route/interruption behavior, signed native builds, the encrypted offline
  queue, local purge, and the prohibition on PHI in analytics, crash reporting, notifications, and
  unencrypted caches.

### The custody model change, stated honestly

In the ADR 0016 native design, the session DEK lived in native code backed by Keychain/Keystore.
In Capacitor, protocol cryptography executes as WebCrypto inside the application webview:

- The webview is first-party only (`capacitor://localhost` / the equivalent Android scheme), ships
  no third-party script or analytics, and enforces a strict CSP — so the web threat model's
  third-party-script exposure does not apply.
- The DEK is held as a non-extractable WebCrypto key while in use. At rest it is protected by a
  non-exportable, this-device-only Keychain/Keystore key reached through a native secure-storage
  plugin; cloud backup and device migration remain disabled.
- This is stronger custody than a general web origin and weaker than pure-native custody: code
  executing inside the application webview can use an active DEK, exactly as ADR 0016's threat
  model already concedes for a compromised client process. No capture client of any framework is
  safe after full client-process compromise.
- Native modules still own what the webview cannot do: audio capture (PCM16 WAV chunks at the
  capability-endpoint format — a custom Capacitor plugin if no maintained plugin yields raw PCM;
  lossy capture or transcoding is rejected), background/lock behavior, and secure storage.

### What this ADR does not do

It does not implement a client, change the server contract, expose Scribe publicly, alter the
custody or envelope protocol, enable any tenant flag, or activate clinical capture. The server
prerequisites (reservations, capability bootstrap, capture lease, versioned protocol source with
cross-language golden vectors) remain ADR 0016 rollout step 2 and precede any client code.

## Consequences

- One codebase, one release train per store instead of three client builds; protocol fixes land
  once.
- The web and native custody distinction ADR 0016 drew becomes a single intermediate model that
  must be presented accurately: hardware-backed at rest, webview-executed in use.
- Capacitor's webview is a platform dependency: OS webview updates can change recording-adjacent
  behavior and are covered by the ADR 0009 acceptance-test obligation that survives this decision.
- A future need for capabilities Capacitor cannot deliver (for example, guaranteed long-running
  background capture) reopens this decision explicitly rather than being worked around.

# Cosmaneura Capture

`apps/capture` is the single P1 capture client for the web/PWA, iOS, and Android. Its permanent
identity is **Cosmaneura Capture** with native application ID `com.cosmaneura.capture`. The current
Phase 2 build is a foundation only: clinical capture is false by default, recording controls are not
implemented, and no tenant or production route is enabled.

## Deliberately small web layer

The app uses Vite 8.2.1, Lit 3.3.3, and strict TypeScript 5.9.3. TypeScript is pinned to the newest
release supported by the locked OpenAPI type generator. Lit provides standards-based,
accessible components without introducing a router, state-management runtime, or a large application
framework. That fits a focused recording appliance with a small number of explicit states and keeps
the security-sensitive dependency and script surface narrow. Vite supplies the local and production
build only; the shipped application loads no third-party scripts, analytics, or crash-reporting SDKs.

Capacitor core, CLI, iOS, and Android are pinned as one reviewed set at exactly **8.5.0**, the latest
stable release when this scaffold was created on 2026-08-17. The repository requires Node 24 and npm
11.5.2; npm's lockfile is authoritative. Capacitor upgrades must update all four packages together and
regenerate both native projects in the same reviewed change.

## Security and system boundaries

- Authenticated API and control operations go only to the master platform BFF. The client never
  receives a Scribe workload token and never calls the private Scribe API, Azure AI Speech, Key Vault,
  or Azure control-plane endpoints.
- The only governed direct data operation is a complete encrypted-envelope upload through the
  separately controlled ciphertext upload capability. No Azure SDK, connection string, account key,
  Blob hostname, object path, resource ID, or Entra client secret belongs in this app.
- Client wire behavior comes from the pinned `@cosmaneura-scribe/capture-protocol` workspace package.
  Do not duplicate its envelope framing, AAD encoding, JSON ordering, enums, or limits in app code.
  Protocol v1 currently requires PCM16 mono 16 kHz WAV with a **10-second** target chunk duration;
  the superseded planning stubs' 30–60-second language was stale.
- Consent accepted by the server, session creation, DEK binding, and a valid capture lease must all
  precede recording. The product flow remains disabled until Phase 3 implements and proves those
  gates.
- No audio, raw DEK, upload credential, token, object path, patient display value, transcript text,
  or patient identifier may enter logs, analytics, crash reports, notifications, unencrypted local
  storage, or service-worker caches. Local history is metadata-only. Transcript display is read-only
  and active-session-only.
- Offline records follow the durable protocol state sequence `reserved -> encrypted -> uploading ->
  uploaded -> registered -> purged`. A complete encrypted envelope is durable before network I/O,
  retries reuse the identical bytes, and purge follows a confirmed server receipt.
- Queue drains take one origin-wide Web Lock before starting their two workers, so multiple PWA tabs
  cannot multiply the server-advertised upload concurrency. Browser runtimes without that primitive
  fail closed; their support requires a separately reviewed coordinator.

The Phase 2 queue begins only after the server returns a canonical reservation. It does not yet
orchestrate the pre-reservation request. Before Phase 3 sends that mutation, it must durably persist
the reservation idempotency key and request intent so a crash or lost response can replay the exact
request. The post-response `reserved` record is not evidence that this activation prerequisite has
been implemented.

## Web and native profiles

The PWA is a responsive, foreground-only capture surface for provider computers and exam-room
tablets. It must educate users about microphone permission, keep recording state visible, handle
offline/retry and refresh recovery within bounded limits, and use a tested raw-PCM browser adapter
such as an `AudioWorklet`. Lossy `MediaRecorder` output must not be relabeled as WAV. Browser clients
must not promise lock-screen or unrestricted background recording. Their active DEK is a
non-extractable, origin-bound WebCrypto key; the PWA has no native secure-storage claim.

The native profiles are signed Capacitor shells. WebCrypto executes the protocol in the packaged
first-party webview while native modules own raw-PCM capture, background/lock behavior, OS secure
storage, and network recovery. The current queue plugin keeps its iOS AES key in a
non-synchronizing, this-device-only Keychain item and its non-exportable Android AES key in
AndroidKeyStore; records are excluded from backup. That is device-bound queue protection, not a
hardware-backed claim and not the still-pending Phase 3 session-DEK custody proof.

Native acceptance must cover explicit consent before audio APIs, a persistent recording indicator,
airplane-mode capture and ordered recovery, screen lock/background behavior, app termination during
a queued upload, and predictable handling of calls, alarms, Bluetooth, and audio-route changes.
Recording pauses visibly when continuity cannot be guaranteed; it never invents missing continuity.
Local audio is retained until server receipt confirmation and then purged within the bounded policy.
Remote sign-out or consent revocation stops capture and applies the required local purge behavior.

Before distribution, Cosmaneura must control the Apple and Google developer accounts, bundle IDs,
signing certificates and keys, privacy declarations, and release approvals. Physical-device testing,
store signing, privacy forms, and any device-management policy remain activation work rather than
claims made by this scaffold.

## Commands

Run commands from the repository root with Node 24 and npm 11.5.2:

```sh
npm ci
npm run generate:api
npm run check:api
npm run test:golden
npm run lint
npm run typecheck
npm test
npm run build
npm run dev
npm run mock:bff
```

The mock BFF uses synthetic data only and exists for local protocol-flow testing. Run it beside the
Vite server; Vite proxies same-origin `/api/capture` and `/mock-upload` requests to the loopback mock
on port 4174. The mock is not a proxy to Scribe or Azure and must never be pointed at production.

Native platforms are committed under `ios/` and `android/`. Synchronize them with real Capacitor
commands after the web build:

```sh
npm run build
npm run cap:sync:ios --workspace @cosmaneura-scribe/capture
npm run cap:sync:android --workspace @cosmaneura-scribe/capture
npm run cap:sync:check:ios
npm run cap:sync:check:android
```

Capacitor 8.5.0 has no `cap sync --dry-run`. CI therefore runs the real platform sync on a clean
checkout and fails if tracked or untracked native files change. iOS sync/build validation requires a
macOS runner with Xcode 26 or newer. Android validation requires JDK 21, Android SDK 36, and the
project's committed Gradle wrapper. Simulator and physical-device evidence belongs to Phase 3.

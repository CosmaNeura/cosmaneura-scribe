# Electron desktop companion foundation

2026-09-22 continuation: a separate, dormant
[native macOS audio source](native/ScribeDesktopAudio/README.md) now implements
ScreenCaptureKit/AVFoundation input and host-clock-aligned mixed 16 kHz PCM for
the full provider workflow. Its source compiles and 23 local checks pass, with
independent exact-rational PCM goldens. A main-process PCM adapter now reuses
the existing WAV/encryption/upload/recovery flow; eleven local desktop checks
include decrypting the retained WAV and reopening/uploading mixed capture once.
The actual Swift-to-main transport, durable host stores/UI, native lifecycle and
physical Meet/Zoom acceptance remain open. See
[ADR 0056](../../docs/adr/0056-desktop-pcm-encrypted-capture-adapter.md).
It is not mounted in this Electron foundation. The
historical pilot description below describes its existing mock and Recall plan;
no Recall dependency or live service has been added.

This directory contains the disabled-by-default Phase 3 foundation for an Electron desktop
companion that will eventually host Recall.ai's Desktop Recording SDK in the Electron main process.
It is not a recorder, is not clinically deployable, and currently uses a metadata-only mock adapter.
It does not capture audio, receive transcripts, contact Recall, or contain a Recall workspace API
key.

Electron is the pilot shell prioritized by central architecture ADR 0018 because Recall supports it
directly and it removes a native process bridge from the critical path. The provider-neutral
`DesktopCaptureAdapter` remains the seam for the long-term native implementation that can preserve
separately encrypted microphone and system-audio channels. The pilot Recall adapter will use mixed
audio only; a later Tauri/native shell remains an option when that native adapter is built.

## Supported pilot envelope

- Apple Silicon macOS 14.2 or later, distributed directly as a signed and notarized application.
- Windows 10/11 x64, distributed as a signed installer.
- Zoom Desktop and Google Meet in Chrome.
- Audio-only mixed capture, one active meeting per machine.
- Explicit clinician start and stop controls with a persistent recording/failure indicator.
- An interruption ends the capture. Resume requires reconciliation and a new backend grant.
- Bot capture remains a mutually exclusive fallback selected by the backend.

Intel macOS, mobile, Teams, Meet PWA/companion mode, offline capture, video, separate participant
tracks, automatic start, in-place pause/resume, and app-store distribution are outside the pilot.

## Pinned Recall placeholders

The real main-process adapter must use exactly the pinned values in `src/config.ts`:

| Setting | Placeholder |
| --- | --- |
| npm package | `@recallai/desktop-sdk` |
| pinned SDK version | `2.0.28` |
| capture output | `video_mixed_mp4: null`, `audio_mixed_mp3: {}` |
| feature flag | `COSMAS_RECALL_DESKTOP_COMPANION_ENABLED=false` |

The Recall package is deliberately absent from `package.json`. Add it only after provenance,
integrity, license, transitive dependencies, and supported Electron-version compatibility have been
reviewed and its exact package and native binary checksums can be locked. Do not use a floating or
nightly version.

Immediately before capture, an injected main-process authority must revalidate the actor, consent,
session, `desktop_companion` source, and source lease with the Cosmas backend. Its authorization
window cannot exceed five minutes. A successful response carries a provider-neutral, one-time
`captureCapability` containing only an identifier, opaque secret, and expiry. The Recall adapter may
interpret that secret as its upload token internally; shared contracts do not name the provider.

The renderer IPC surface has no initialization or authority method and its schemas cannot carry a
capability. The controller never caches the capability, rejects local replay, and scrubs its mutable
secret reference immediately after the adapter start attempt. A Recall workspace API key must never
be bundled, passed to the renderer, accepted by runtime configuration, written to logs, or included
in crash telemetry.

## Electron trust boundary

`electron-security.ts` defines the mandatory BrowserWindow baseline:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `webviewTag: false`
- production developer tools disabled
- packaged `app://cosmas` content only
- new windows, webviews, downloads, external navigation, and renderer permission requests denied
- restrictive CSP with no renderer media access or remote connections

Register the exported `PACKAGED_APP_SCHEME` privileges before Electron becomes ready, then serve the
renderer only from `app://cosmas`. `file://` is not an approved production origin.

The future Electron bootstrap must apply this policy before loading content. Recall SDK access and
backend communication belong in the main process; the renderer must not receive Node, Electron,
filesystem, shell, process-launch, raw network, SDK, token, or arbitrary IPC capabilities.

`installElectronPreloadBridge` exposes one frozen `cosmasDesktop` object through `contextBridge`.
Its complete surface is `getState`, `refreshPermissions`, `start`, `stop`, and `onStateChanged`.
Channels are fixed constants, inputs and outputs are exact-key runtime validated, payloads are
limited to 16 KiB, and every main-process handler requires the expected webContents identity plus
its exact top-level `app://cosmas` frame origin. Subframes are rejected. There is no generic `send`,
`invoke`, command, URL-opening, or shell function.

## Capture safety contract

The main-process controller exposes only these states:

`permission_required`, `meeting_detected`, `ready`, `recording`, `stopped`, `failed`.

Starting requires the feature flag, a cached session context, a detected supported meeting, a
process-wide recording lease, and a fresh backend authority decision covering actor, granted
consent, authorized session, desktop source lease, and one-time capability. Authority is requested
only after local readiness and immediately before adapter start; timeout, revocation, changed fields,
staleness, a validity window over five minutes, or capability replay fails closed.
Each controller has a unique lease owner, so duplicate controllers cannot record even if they are
given the same capture-session identifier. Electron startup must also acquire
`app.requestSingleInstanceLock()` before creating a window or adapter so a second operating-system
process cannot bypass the in-memory lease.

The persistent indicator becomes visible before native capture can begin. A network loss, device
change, SDK failure, start/stop uncertainty, or indicator failure is terminal. The controller revokes
the in-memory grant, never accepts a later ready signal, and never silently resumes. It retains the
lease and a persistent failure warning until main-process shutdown positively confirms that the SDK
can no longer capture. If termination remains uncertain, the application process must be killed and
the backend session reconciled before a fresh grant is issued.

All native adapter lifecycle calls are bounded to 15 seconds and receive abort signals. The real
adapter must guarantee that initialization and permission refresh cannot capture and that an
aborted or timed-out start cannot begin capture later; its idempotent `abort` remains the second
termination barrier. A timeout is terminal and retains any process-wide lease until bounded
shutdown confirms that capture is impossible. If shutdown also times out, the operating-system
process must be terminated.

The mock adapter uses synthetic identifiers and records operation names only. Tests contain no
patient data, meeting URLs, audio, object names, or transcript text.

## Packaging constraints

The real Electron packaging change must:

1. Pin Electron and the Recall SDK exactly, lock registry integrity, and produce an SBOM and signed
   provenance attestation.
2. Keep Recall and all privileged modules in the main process; bundle a small preload with only the
   reviewed bridge and a renderer with no Node polyfills.
3. Package with ASAR integrity/fuses where supported while assuming ASAR provides no secret storage.
4. Sign and notarize the macOS app and nested native code with the minimum audio/accessibility
   entitlements; sign the Windows app, native modules, and installer.
5. Keep the indicator outside ordinary page navigation (menu bar/tray plus persistent recording
   surface), and prevent close/minimize from obscuring uncertain capture.
6. Add signed updates, downgrade protection, separate release channels, crash-report scrubbing,
   dependency scanning, and a tested kill switch.

## Exit criteria

- The backend creates the Recall upload and returns only a scoped, expiring, one-time opaque
  capability to the trusted main-process authority path.
- The pinned SDK package/native artifacts pass provenance and vulnerability review.
- Synthetic Zoom and Meet capture passes on both supported operating systems.
- Permission denial/recovery, duplicate starts, explicit stop, device change, network loss, app
  crash, forced termination, and OS restart have deterministic reconciled outcomes.
- The persistent indicator cannot be hidden while capture is active or termination is uncertain.
- No workspace key or protected health information appears in the bundle, renderer, IPC, logs,
  crash reports, screenshots, updates, or telemetry.
- Backend webhook verification, transcript ingestion, explicit retention, deletion evidence,
  reconciliation, audit events, and bot/desktop mutual exclusion pass acceptance.
- HIPAA/security review runs continuously for every boundary change and a final end-to-end review
  signs off before any PHI pilot or feature-flag enablement.
- Clinical safety, privacy, release signing, support, incident response, and rollback owners approve
  rollout.

Until all criteria pass, keep `COSMAS_RECALL_DESKTOP_COMPANION_ENABLED` false outside isolated
synthetic development.

The current evidence, threat boundaries, and unresolved compliance blockers are tracked in
[`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md).

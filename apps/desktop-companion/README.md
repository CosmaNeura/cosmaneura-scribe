# Electron desktop companion foundation

This directory contains the disabled-by-default Phase 3 foundation for an Electron desktop
companion and a provider-neutral Recall.ai Desktop Recording SDK adapter. It is not clinically
deployable. The checked-in application bootstrap always constructs a disabled controller with a
metadata-only mock adapter; it does not load or invoke the Recall SDK, capture audio, receive
transcripts, contact Recall, contact the Cosmas platform, or contain a Recall workspace API key.

The trusted main-process integration foundation now implements the exact custom-protocol launch,
system-browser PKCE handoff, `/desktop/v1` token and lifecycle client, and encrypted desktop state
store. `main-entry.ts` now composes that trusted runtime with Electron `safeStorage`, the system
browser boundary, a native tray indicator, and the mock adapter. The checked-in release manifest
keeps both product and clinical release decisions false and uses `.invalid` origins. Deep links are
registered and strictly parsed on macOS and Windows, but the disabled router performs no browser,
credential, storage, API, or controller work. Synthetic tests prove the separately enabled launch →
code exchange → local start → heartbeat → local stop → durable stop-receipt flow.

Electron is the pilot shell prioritized by central architecture ADR 0018 because Recall supports it
directly and it removes a native process bridge from the critical path. The provider-neutral
`DesktopCaptureAdapter` remains the seam for the long-term native implementation that can preserve
separately encrypted microphone and system-audio channels. The pilot Recall adapter will use mixed
audio only. Electron is the sole delivery framework through 2028-08-23. Tauri remains the long-term
shell for a wholly owned native vertical stack after CosmaNeura owns the capture engine; it is not a
parallel implementation target during this 24-month horizon.

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

## Pinned and isolated desktop runtime

The main-process adapter uses exactly the pinned values in `src/config.ts`:

| Setting | Placeholder |
| --- | --- |
| npm package | `@recallai/desktop-sdk` |
| pinned SDK version | `2.0.28` |
| pinned Electron version | `43.4.1` |
| pinned fuse utility | `@electron/fuses@1.8.0` |
| regional SDK API | `https://us-west-2.recall.ai` |
| automatic native restart | disabled |
| capture output | `video_mixed_mp4: null`, `audio_mixed_mp3: {}` |
| checked-in release gates | product `false`, clinical `false`, packaging `false` |

Electron and Recall are deliberately isolated from the root workspace in `vendor-runtime`. This
prevents existing web/mobile `npm ci` jobs from running desktop vendor lifecycle code. Its separate
lock pins both exact versions and registry integrity. Never run an ordinary install in that
directory: use `npm ci --ignore-scripts --workspaces=false --prefix
apps/desktop-companion/vendor-runtime` in the dedicated desktop packaging lane.

The upstream Recall installer is not trusted to fetch native code because it does not verify the
published native archive. `scripts/prepare-recall-sdk.mjs` instead requires separately obtained
registry and native archives, checks their exact SHA-256 values against
`vendor/recall-desktop-sdk.provenance.json`, rejects unsafe archive paths, and only then extracts the
native artifact. It also applies an exact-source patch that disables the installer, removes ambient
`RECALL_*` forwarding, removes the Windows GStreamer override, disables automatic restarts, and
suppresses command, event, native stdout, and native stderr payload logging. Runtime loading verifies
the retained archives, patched files, and extracted tree again and still rejects the manifest while
`clinicalReleaseApproved` is false.

## Secure sign-in and credential storage

Clinicians do not paste a password, Clerk secret, Recall key, or Azure credential into the desktop
application. The companion receives a short-lived launch ticket from the authenticated platform,
creates PKCE material locally, and opens the existing Cosmas sign-in/consent page in the system
browser. The callback contains only a one-time authorization code and matching random state. The
Electron main process exchanges that code for a short-lived desktop bearer; neither the callback nor
the bearer crosses preload IPC into the renderer.

`DesktopSecureStateStore` requires Electron `safeStorage` and has no plaintext fallback. On the
supported platforms, the encrypted state file contains the installation secret, pending PKCE state,
short-lived desktop session, and durable stop receipts. `NodeEncryptedStateFile` writes it atomically
with owner-only file permissions inside an application-owned user-data subdirectory. If operating-
system encryption is unavailable, decryption fails, or the file schema is unexpected, the companion
fails closed and requires a new browser handoff.

For development, configure only the reviewed platform application and API origins in the packaged
build configuration. Do not put bearer tokens, launch tickets, SDK upload tokens, Clerk credentials,
Azure credentials, or Recall workspace keys in `.env`, command-line arguments, application logs, or
the renderer. Production signing identities are supplied only in the isolated release workflow's
secret store and are never bundled as runtime configuration.

The secure credential handoff for a future signed build is:

1. Create separate protected GitHub Environments for macOS and Windows desktop releases with
   required reviewers. Do not use repository-wide plaintext variables for private key material.
2. On macOS, import the Developer ID Application certificate into an ephemeral CI keychain and use
   a `notarytool` keychain profile or App Store Connect API key held by that protected environment.
   Never commit a `.p12`, `.p8`, keychain password, Apple password, or notarization token.
3. On Windows, prefer GitHub OIDC into Azure Artifact Signing so no long-lived Azure client secret
   is stored. Keep the account/profile identifiers as protected configuration and grant the release
   identity only the signing role on that profile. East-coast placement can be selected when the
   separately reviewed Azure signing resource is created.
4. Release jobs must build on clean, isolated OS-native runners; harden Electron fuses before code
   signing; sign every nested/native binary and installer; notarize and staple macOS artifacts; and
   verify signatures again before publishing. Neither credential set is needed for source builds.

Source-only review can run without native code:

```sh
npm run vendor:recall:verify-source --workspace @cosmaneura-scribe/desktop-companion
```

The full preparation command requires `--package-archive`, `--native-archive`, and an exact
`--platform` of `darwin-arm64` or `win32-x64`. It has intentionally not been run in this slice, and
no native binary was invoked.

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

`main-entry.ts` registers and serves three fixed renderer assets from `app://cosmas`, applies this
policy before loading content, and fails closed with capture hard-disabled. It acquires the
single-instance lock, registers `cosmaneura-capture`, handles macOS `open-url`, and handles Windows
cold-start/`second-instance` command lines without logging their secret-bearing values. Recall SDK
access and backend communication belong in the main process; the renderer does not receive Node,
Electron, filesystem, shell, process-launch, raw network, SDK, token, or arbitrary IPC capabilities.

`electron-diagnostics.ts` makes the application-controlled no-PHI diagnostics policy executable
before Electron becomes ready. The application never starts Electron Crashpad—turning upload off
would still write local dumps—and rejects Chromium logging, NetLog, tracing, remote-debugging, Node
inspection, diagnostic-report, and heap-snapshot launch arguments. Application analytics and
support-bundle surfaces do not exist. Operating-system crash facilities and any native SDK dump
behavior remain separate endpoint/native acceptance gates; this source policy does not claim to
disable them.

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

`ElectronTrayRecordingIndicator` now renders fixed red recording and amber uncertainty signals in
the macOS menu bar or Windows notification area. Tooltips and menus contain only fixed status text,
never a capture, tenant, patient, or appointment identifier. While that signal is visible, native
window close and minimize events are prevented and the trusted window is focused. A deliberate
application quit still enters bounded controller shutdown before the process exits. The same native
menu contains **Stop capture and quit**. That action uses the trusted shutdown boundary and applies
a 20-second process-level deadline; if the SDK wedges, the Electron process exits with failure so
the backend can reconcile an uncertain segment. Signed native acceptance must still prove that any
vendor child process is owned and terminated with the application process on both operating
systems.

All native adapter lifecycle calls are bounded to 15 seconds and receive abort signals. The real
adapter must guarantee that initialization and permission refresh cannot capture and that an
aborted or timed-out start cannot begin capture later; its idempotent `abort` remains the second
termination barrier. A timeout is terminal and retains any process-wide lease until bounded
shutdown confirms that capture is impossible. If shutdown also times out, the operating-system
process must be terminated.

The Recall adapter accepts only the opaque one-time upload token created by the server and the
locally detected window identifier. Its init configuration explicitly selects the US West endpoint,
sets `restartOnError: false`, and has no workspace API key. It normalizes vendor events into the
small provider-neutral signal set and discards titles, URLs, messages, realtime payloads, and other
vendor fields. Upload-token references are scrubbed immediately after the synchronous SDK call.

Tests use only synthetic identifiers and contain no patient data, meeting URLs, audio, object names,
or transcript text.

## Packaging and signing gate

`release/package-policy.json` is the machine-checked source of truth for the two supported package
targets. It requires ASAR, embedded ASAR integrity, signed distribution, macOS notarization and
stapling, Windows timestamping, and a complete fuse set that disables Run-as-Node, `NODE_OPTIONS`,
CLI inspection, unexpected non-ASAR application loading, and extra `file://` privileges. Packaging,
capture, and clinical approval are all false. `scripts/harden-electron-package.mjs` refuses to touch
an executable while that packaging gate is false; after a separately reviewed approval it applies
and reads back every fuse before signing.

`scripts/verify-signed-desktop-artifacts.mjs` is the post-signing, pre-publication gate. On macOS it
requires the configured Apple Team ID, hardened runtime, secure timestamp, absence of the debug
entitlement, strict deep code-signature validation, Gatekeeper acceptance, a valid stapled
notarization ticket, the expected bundle ID/protocol, ASAR-only application code, and the exact fuse
wire. On Windows it requires both the application executable and installer to pass Authenticode
policy with no timestamp warning, match the configured publisher subject, carry a timestamp, use
ASAR-only application code, and match the exact fuse wire. The verifier emits only a fixed pass or
failure message. It deliberately fails now because packaging is false and both expected signing
identities are `UNCONFIGURED`.

After the separately reviewed release policy and identities are configured, run it only on a native
release runner:

```sh
npm run release:artifacts:verify --workspace @cosmaneura-scribe/desktop-companion -- \
  --target darwin-arm64 --application /absolute/path/Cosmas.app

npm run release:artifacts:verify --workspace @cosmaneura-scribe/desktop-companion -- \
  --target win32-x64 --application C:\\absolute\\path\\Cosmas.exe \
  --installer C:\\absolute\\path\\CosmasSetup.exe
```

Electron Forge 7.11.2 was evaluated on 2026-08-23 but removed from the lock because its current
packaging-only dependency graph produced high/critical audit findings. No audit exception was added.
The isolated runtime currently retains only the official `@electron/fuses@1.8.0` hardening utility,
whose installed graph passed the moderate-or-higher audit gate. Selecting or implementing the final
packager/installer remains blocked on a clean reviewed dependency graph.

The signed release lane must still:

1. Consume the isolated exact locks and reviewed provenance manifest, add a complete generated SBOM,
   and produce a signed provenance attestation.
2. Keep Recall and all privileged modules in the main process; bundle a small preload with only the
   reviewed bridge and a renderer with no Node polyfills.
3. Package with the checked-in ASAR integrity/fuse policy while assuming ASAR provides no secret
   storage.
4. Sign and notarize the macOS app and nested native code with the minimum audio/accessibility
   entitlements; sign the Windows app, native modules, and installer.
5. Verify the implemented native tray indicator, close/minimize guard, emergency shutdown, native
   child-process termination, and OS crash behavior on both operating systems.
6. Add signed updates, downgrade protection, separate release channels, dependency scanning, and a
   tested kill switch.

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

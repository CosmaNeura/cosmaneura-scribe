# Local provider workspace — 2026-09-21

## Desktop provider recorder controls — 2026-09-22

The existing provider UI now accepts a desktop recorder command/state view.
Main composes its native helper, encrypted capture/recovery flow and existing
fresh-authority/lease/indicator controller. Startup cancellation, confirmed stop
before upload, failed-stop retry and interrupted reopening are connected. The
view shows startup, source scope and incomplete coverage without receiving audio,
keys, storage handles, window IDs or credentials. Default preview and the iOS
resource/foreground path remain unchanged.

All 63 desktop/202 capture checks, types/lint, provider/main builds, three compiled
desktop DOM checks and ten existing application checks pass. The new main checks
use real Swift/Node pipes and encrypted SQLite with explicitly invented audio,
consent and a local BFF. See [ADR 0059](../adr/0059-desktop-provider-recorder-composition.md)
and `/Users/jw/Desktop/Cosmas/scribe-desktop-provider-20260922.vqbwAd/`.

Next assemble the actual standalone desktop main/preload runtime with its native
picker/indicator, device key custody and provider backend/journal ports. Actual
Core runtime configuration and the pending standalone identity decision remain
external dependencies. No Electron app was installed/launched; desktop/mobile
physical, session/fidelity and signed release/operations acceptance are unfinished.
W13, Mac R2, private receiver, Core/OS source and protected authority files are
unchanged; no completed live-service trial was repeated.

## Durable desktop capture and provider recovery — 2026-09-22

Desktop main-process storage now retains encrypted flow/queue records, locally
wrapped session keys, existing provider/review journals and native coverage.
A real-file check records through the qualified Swift generated-audio helper,
SIGKILLs its writer with SQLite open, recovers the ciphertext/key from WAL and
uploads once through the existing capture controller. Reopening is paused and
does not start a source. Five new storage checks, all 57 desktop/200 capture
checks, typechecks and affected lint pass.

See [ADR 0058](../adr/0058-durable-desktop-provider-storage.md) and
`/Users/jw/Desktop/Cosmas/scribe-desktop-durable-20260922.nt9C50/`.
This uses an ephemeral fixture custody key, not Keychain or actual native key
provisioning. The default browser/iOS key path remains unchanged. No installed
app, service, Core/OS tree or completed live trial was changed/repeated.

Next compose the provider recorder in the trusted desktop main process and
connect its commands/snapshots to the existing provider UI. Actual native key
custody, complete Core runtime, standalone identity/packages and device/release
acceptance remain open. Source, store, key and upload handles must remain outside
the renderer. W13, Mac R2 and the private receiver stay preserved.

## Actual desktop native process transport — 2026-09-22

The Swift microphone/system producer now has a dedicated helper and a Node
driver consumed by the existing PCM/WAV adapter. The actual cross-language pipe
passes generated-audio delivery, final partial WAV, cancellation, backpressure,
failed-stop retry and discard-upgrade checks. A deliberately unresponsive source
also proves that parent loss ends the dedicated process at its cleanup deadline.
The production helper compiles but was not activated against physical audio.
All 52 desktop and 26 native checks pass, along with typecheck, affected lint and
the Node driver build.

The driver verifies the packaged helper path/hash, bounds startup before native
spawn and waits for process exit before confirming stop. It carries fixed source
selection/limits and metadata/PCM only; credentials and raw audio stay outside
the renderer. Acknowledgement includes completed WAV persistence; partial chunks
remain bounded in memory until completion/drain. See
[ADR 0057](../adr/0057-desktop-native-process-transport.md) and
`/Users/jw/Desktop/Cosmas/scribe-desktop-native-pipe-20260922.eMXizG/`.

Next compose durable main-process stores and provider controls/authority. The
desktop host is still uninstalled; this is not physical Meet/Zoom, native
permission/indicator, complete Core runtime or signed release acceptance. W13,
Mac R2, private receiver and pending standalone identity remain unchanged.
No completed phone or live-service trial was repeated.

## Desktop PCM into encrypted capture — 2026-09-22

The desktop main-process source now adapts mixed PCM into the existing
WAV/encryption/reservation/upload workflow. A Node check encrypted generated PCM,
decrypted and verified its WAV samples, reopened retained mixed capture state,
uploaded once and reached configured processing. Native input, BFF and IndexedDB
are explicit offline fixtures; this is not installed-app, real Core authorization
or operating-system storage acceptance.

The iOS PCM lifecycle was extracted for reuse; foreground policy and
Capacitor/native auth/storage bridges are unchanged. Eleven desktop and 47 iOS
checks pass, with typecheck/lint. See
[ADR 0056](../adr/0056-desktop-pcm-encrypted-capture-adapter.md) and
`/Users/jw/Desktop/Cosmas/scribe-desktop-encrypted-capture-20260922.uS0Pdu/`.

Next bind the actual Swift-to-main transport, durable main-process stores and
provider UI/authority. Start/tail coverage must be retained and shown. W13,
Mac R2, private receiver, Core and pending standalone identity remain unchanged.
No native app or live trial ran.

## Desktop clock alignment and PCM conversion — 2026-09-22

The native desktop producer now carries source sample positions into a mixed
16 kHz mono PCM sink. It aligns microphone/system audio by observed host times,
checks sample continuity independently of clock drift, and reports the actual
common start and unmatched tails. Normal stop can drain accepted input; failures
discard it. Missing audio is never filled with silence or replaced by a source.

This is native source functionality, still unmounted in an app. Main-process
WAV/encryption/upload and recording-UI integration remain the next desktop work.
Physical timing/silence/Meet/Zoom behavior and native lifetime acceptance remain
open. See [ADR 0055](../adr/0055-host-clock-aligned-desktop-pcm.md) and
`/Users/jw/Desktop/Cosmas/scribe-desktop-mixer-20260922.IPmHEd/` for exact local
conversion/delivery checks and the independently calculated PCM goldens.
The complete native source compiles with warnings as errors; 23 Swift checks and
two exact-rational golden cases pass. This does not establish physical fidelity.
W13, Mac R2, private receiver, Core and pending standalone identity configuration
remain unchanged; no native source, permission prompt or live service ran.

## Native desktop audio source preparation — 2026-09-22

The desktop foundation still has its original mock adapter, but a separate native
macOS 14.2 source now implements selected-window ScreenCaptureKit audio plus
AVFoundation microphone input. It preserves source timestamps and channels,
bounds/clears native delivery, and retains partial-start/failed-stop resources.
It requires the existing main-process authority/indicator and is disabled by
default. No raw audio is exposed to the renderer.

Ten Swift checks and the complete native source compile pass with warnings as
errors, using generated samples and in-memory AVFoundation buffers. No physical
source, permission prompt or app was started. See
[ADR 0054](../adr/0054-native-macos-meeting-audio-source.md) and
`/Users/jw/Desktop/Cosmas/scribe-desktop-audio-20260922.uiZP2V/`.

Main-process alignment/mixing, encryption/upload, native lifetime fault checks,
actual host packaging, Windows and physical acceptance remain open. Chrome window
selection does not prove tab-isolated audio; its actual capture extent must be
qualified and disclosed before activation. The separate iOS identity packet
remains unapplied while the owner's decision is pending.

## Standalone application startup — 2026-09-22

The provider entry now exports `mountNativeProviderIOSApplication` to compose
native sign-in, the receiver backend, iOS recorder host and complete provider
workspace. It owns restored sessions, explicit reopen, immediate clearing on
access changes, sign-out while connecting, late connection disposal and retry of
unconfirmed recording cleanup. The native authentication implementation remains
unchanged; a failed sign-out cannot silently reopen the old ready session.

Ten checks against the actual compiled UI and eight backend checks pass. The
native startup reaches recording preparation using explicit offline Capacitor
responses, without fetching a token in JavaScript or requesting a microphone.
Typecheck, lint, provider build and preview isolation checks pass. See
[ADR 0053](../adr/0053-standalone-provider-application-lifecycle.md) and
`/Users/jw/Desktop/Cosmas/scribe-provider-application-20260922.FhyAep/`.

The reconnected iPhone was verified ready by a read-only query. No new app has
been installed. The [standalone identity packet](SCRIBE_STANDALONE_IOS_IDENTITY_PACKET_20260922.md)
contains the exact, unapplied native configuration change; the owner's decision
is pending. Real Core runtime/account correspondence, upload, Core navigation and
native packaging remain open. Existing Core/Scribe checkout roots contain no
active local `.env` configuration; the old full browser fixture directory is
absent as already recorded. No running/shared Core service was selected or
modified to fill that gap.

## Native provider receiver connection — 2026-09-22

The iOS backend now connects the current provider host to the fixed receiver
through the existing native session owner. Native code obtains each fresh SDK
token and keeps it out of JavaScript. The bridge handles request cancellation,
logout/session changes, late replies, stable server recovery scope and Core
conflicts. It reports provider readiness only when its receiver profile is valid
and Capacitor bridge logging is disabled.

Eight backend checks, nine compiled native checks, the complete iOS-17-targeted
bridge typecheck and built provider UI check pass. A real native HTTPS roundtrip
also passes with an offline signed identity and an isolated database: catalog,
mount, configured admission, review and note templates reach the receiver/Core
wire fixture; a wrong TLS pin and post-logout request are rejected.
See [ADR 0052](../adr/0052-native-provider-receiver-bridge.md) and evidence at
`/Users/jw/Desktop/Cosmas/scribe-provider-native-bridge-20260922.WPYCoIZE/`.

W13 and Mac R2 remain unchanged. This is not a standalone app installation or
live Core acceptance. The retained authentication configuration permits only
CosmasOS synthetic bundle identities; the standalone Scribe identity/callback,
reviewed Core runtime/account correspondence, upload target and Core navigation
still need their concrete app configuration and end-to-end acceptance.

## Standalone provider receiver preparation — 2026-09-22

The server transport's fresh-authority callback is now bound to the existing
verified identity, active human, creator workspace, confirmed Core encounter and
reviewed Core account records in a separate FastAPI receiver. Its six fixed native
routes cover catalog, mount, recorder reauthorization and configured capture,
review and Core note requests. Workload credentials stay server-side; Core still
decides each clinical operation. W13's working receiver/app are unchanged.

Fourteen local checks pass against an isolated socket-only PostgreSQL fixture
with the actual retained schema/verifier, offline signing keys and Core wire
responses. The current TypeScript provider client completes its admission,
review and note sequence through the receiver. Revocation and changed creator
correspondence during Core I/O suppress the result. This is source preparation;
no standalone endpoint or real Core configuration has been activated.

See [ADR 0051](../adr/0051-standalone-provider-receiver.md) and
`/Users/jw/Desktop/Cosmas/scribe-provider-receiver-20260922.pnahj9UO/`.
The actual native request/upload binding, existing Core creation/navigation,
reviewed runtime configuration and physical end-to-end acceptance remain open.

## Desktop audio-channel preparation — 2026-09-22

The recorder now preserves an authorized source's mixed/system-audio channel
through reservation, encrypted retention, interruption, reopening and capture
completion. It previously labeled every recording as microphone audio. Retained
work rejects a different source channel and cannot be rewritten as microphone
work. Existing microphone records and the default preview keep their version-2
shape; new non-microphone flow records use version 3, which older clients reject.

Both channel recovery checks and all 192 capture checks pass locally, with
invented consent/audio and the existing loopback protocol fixture. See
[ADR 0050](../adr/0050-capture-channel-bound-recovery.md) and evidence at
`/Users/jw/Desktop/Cosmas/scribe-provider-channels-20260922.ulHYxlkX/`.
The actual desktop audio producer, app hosting and physical Meet/Zoom acceptance
remain open. No native app, service, consent policy or shared schema changed.

## Server-side Core provider transport — 2026-09-22

`ProviderCoreTransport` now connects the current provider request contracts to
Core's existing user-context exchange, server workload/mount resolution and
creator/encounter capture binding. It supports configured admission, creator
review decisions and existing Core SOAP read/prepare/save/recovery. Each operation
reauthorizes the current identity and encounter before and after I/O; workload
and mount credentials remain on the server. There is no automatic mutation retry.

The actual TypeScript `CoreCaptureClient` executes its admission, review and
note request sequence through this Python transport in the focused local check.
All seventeen checks pass with Node 24, including changed identity, revocation,
concurrency, lost replies and cancellation. Core and identity responses are
explicit offline fixtures: this is client/transport interoperability, not a new
Core/database/model trial or live authentication acceptance. See
[ADR 0049](../adr/0049-standalone-provider-core-transport.md) and evidence at
`/Users/jw/Desktop/Cosmas/scribe-provider-core-20260922.bRpB0BTG/`.

The component is unregistered and disabled by default. The actual standalone
native/server host must still bind its fresh identity/grant/creator authorizer,
reviewed Core origin/workload credential source, encounter list/creation and
native request lifetime. W13's catalog receiver and installed build remain
unchanged. No protected Core/OS source or authentication policy was modified.

## iOS provider host composition — 2026-09-22

`createProviderIOSHost(existingConnection)` now assembles the real iOS recorder,
provider/review journals, scoped audio queue, encrypted flow store, exclusive
recording lock and configured upload target for `mountProviderWorkspace`.
The existing authenticated Core/native connection still owns encounter listing,
creation, mount authorization, recorder reauthorization and Core navigation.
It supplies the stable server-bound environment/creator recovery UUID and
`AuthorizedCoreRequest`; the new host never acquires a workload credential or
turns a Clerk token into Core workload authority.

Recorder acquisition requires native iOS, IOSPCM and SecureQueue, then locks and
freshly reauthorizes before opening retained stores. Construction never requests
microphone permission or starts audio. The current controller retains explicit
consent/admission and Start. Queue keys bind recovery scope, workspace and
session; foreign/legacy records are never fetched. A mismatched saved session
fails without clearing it. Failed native stop retains the same source and lock
until explicit retry succeeds. Cancellation during asynchronous store opening
closes only the failed acquisition's handles.

Audio queue and provider/review journals use the existing device-encrypted
SecureQueue. Flow records and session keys retain the existing encrypted
IndexedDB/WebCrypto profile; this increment does not claim native Keychain
custody for those keys. It introduces no native storage implementation or
credential namespace change. The unscoped queue reader excludes the new reserved
provider namespace, preserving separation from its previous records.

Local evidence:
`/Users/jw/Desktop/Cosmas/scribe-provider-ios-host-20260922.ocw3v6ik/`.
Six new host checks cover reopening retained state, creator/workspace/session
separation, pending-session preservation, unconfirmed-stop ownership,
reauthorization/native-store failure and cancellation during storage open.
All **190 capture checks** are accounted for: 177 passed in the initial run;
13 HTTP fixture checks initially failed with sandbox `listen EPERM`, then all
13 passed with loopback socket access in `capture-http-tests.log`. The original
failure log remains. Typecheck, affected lint and provider build pass.

`rendered-host.log` verifies the actual built entry with `AbortSignal.any`
absent: native-host composition reaches the provider recording preparation
view, uses the scoped journal, reauthorizes recorder acquisition, excludes
foreign records, releases its lock and clears on revocation. Native/Core calls
are explicit offline fixtures; no audio or live provider operation runs.

The default preview was rebuilt separately at `9bbf7d1`; its preview guard passed.
The provider host and its flow-store namespace remain absent from that preview,
whose microphone mode remains disabled. `preview-build.log` and
`preview-guard.log` retain these local checks; no preview was deployed.

This closes the native resource-composition gap in source and the provider
bundle. The standalone native identity/authorized Core connection still must be
bound to it, then packaged and qualified on devices. This code is not installed
in W13 build 4. W13 remains the separately approved OS native-session snapshot,
not a relabeled standalone Scribe release. Complete desktop hosting, native
lifecycle, physical capture, real-service fidelity and distribution remain open.

### Next connection boundary

Read-only reconciliation found the protected Core checkout still at
`e21ba4c1fb1027de8123aca9b8aee25b8a11b612`; all 82 dirty file paths, statuses and
hashes match the retained recovery manifest. The shorter default Git status
count groups untracked directories. `provider-ios-host-final-checkpoint.json`
preserves this comparison and verifies the source/artifact hashes above.

Core already provides the required identity path: a native user session reaches
`/embed/v1/context-tokens/exchange`, then server-held workload authority resolves
`/service/v1/agent/mount-context/resolve` and
`/service/v1/agent/scribe/capture-bindings/resolve`. Reuse that separation for
the standalone connection. The read-only OS client
`src/cosmas_os/adapters/core_capture_admission.py` demonstrates this exchange,
but its admission payload lacks `configured_capture` and its operation contract
lacks `creator_review`/`decide_translation`. It cannot be selected unchanged as
the configured provider backend. The current Scribe `CoreCaptureClient` and
approved Core receiver already carry those contracts.

The next implementation must bind that current client to freshly authorized
Core encounter context through the actual standalone native/server host.
W13's two-route catalog receiver supplies neither Core mount authority nor
workload credentials. This inspection changed no Core/OS source, identity
configuration or running receiver and grants no new activation authority.

## Native iOS provider source — 2026-09-22

The provider bundle now exports `createProviderIOSCaptureSource()` for the real
host's recorder acquisition. It reuses the existing Scribe native PCM source and
Capacitor bridge, requires native iOS plus `IOSPCM`, and never falls back to a
synthetic source. Construction does not start audio. The existing configured
consent/admission and explicit Record action still gate capture. No native
Swift/auth source, external package or default preview source changed.

Integration exposed and fixed a real stop-handling gap: after interruption, the
controller previously ignored the native source's unconfirmed-stop failure and
could continue uploading. It now retains the encrypted recording and same native
handle, stays paused, and retries stop before upload/completion. The provider
screen no longer claims an interrupted recorder is stopped; it shows explicit
stop/retry guidance. The existing web source's terminal-error behavior remains.

Evidence is retained at
`/Users/jw/Desktop/Cosmas/scribe-provider-native-20260922.zi6kceir/`:

- `baseline.log`: the new configured-native integration check reproduces the
  incorrect completion after failed stop.
- `corrected-tests.log`: 69 focused native/provider/flow checks pass.
- `capture-tests.log`: all 184 capture checks pass after the shared stop change.
- `provider/`: actual compiled provider entry, including the native source.
  `rendered-native.log` verifies the actual bundle's unconfirmed-stop guidance,
  retry, disabled Record, clearing on revocation and absent-plugin rejection.
  `rendered-ios17.log` repeats the necessary compatibility check against this
  changed bundle with `AbortSignal.any` absent.
- Lint, typecheck and provider build pass. The integration fixture uses invented
  PCM only after an explicit synthetic consent/session and exercises the real
  encrypted queue and loopback upload path. No device microphone or live
  Speech/translation call runs in these checks.

This completes the provider source connection at the code/bundle level. It does
**not** complete the native provider host: real encounter/mount authorization,
Core transport, native storage composition and device acceptance remain. W13
build 3 is now installed and launched; the reconnected phone reaches private
TLS but reports `app_binding_missing` before catalog loading. The signed
[build 4 native-session correction](W13_NATIVE_SESSION_CORRECTION_20260922.md)
was explicitly approved and is now installed and launched, with the corrected
private receiver active. The physical catalog gate passed: the receiver returned
the authenticated catalog at **13:16:35 UTC**, and the owner confirmed the
invented encounter visible. Neither W13 package mounts this complete provider
bundle yet; native lifecycle and full provider workflow acceptance remain open.

## iOS 17 host compatibility correction — 2026-09-22

The provider entry previously called `AbortSignal.any` when opening an encounter.
Early iOS 17 WebViews do not provide that API, so the existing build could fail
before reaching the host's encounter authorization. The corrected entry uses one
owned AbortController per encounter, forwards host/current-encounter revocation,
and removes upstream listeners when that encounter closes. No global polyfill,
auth-policy change or native-app update is required for this source correction.

`scripts/check-provider-ios17.mjs` renders the actual built provider entry with
`AbortSignal.any` unavailable. The retained baseline fails opening; the corrected
bundle reaches recording preparation, clears on logout/revocation, cancels the
previous encounter on switching, and rejects an opening that finishes after
logout before reading its recovery journal. Evidence and both bundles are at
`/Users/jw/Desktop/Cosmas/scribe-provider-ios17-20260922.dPhRFH/`.
Focused provider tests, lint, typecheck and build pass. This proves removal of
one compatibility blocker, **not physical iOS 17 acceptance or complete native
host composition**. W13 build 2 subsequently reached the private backend from
the phone but failed native session verification before catalog loading; see
[the private connection checkpoint](W13_PRIVATE_CONNECTION_20260922.md).

## Existing local workflow

The owner approved completing the local configured capture → review → existing
Core SOAP and creator encounter flow. The separate provider bundle now exposes
that UI as `mountProviderWorkspace(root, host)`. Providers can choose an
authorized encounter, select English or English/Spanish, attest all-party
consent, explicitly record/upload, review Spanish translations beside preserved
source, choose a Core template, prepare/edit/save the existing Core note, recover
an unconfirmed save and open the same encounter in Core.

This is a local integration result. Its production composition still needs the
real authenticated native host. The live standalone beta URL remains the older
synthetic preview. No deployment, login/session-policy change, device acceptance,
distribution signing or new Speech/translation trial occurred. The separately
approved W13 sign-in attempt was resumed; its current result is recorded below.

## Host composition

Build with the pinned Node 24/npm 11.5.2 toolchain:

```sh
npm run build:provider --workspace @cosmaneura-scribe/capture
```

The artifact is `apps/capture/dist/provider/provider-capture.js` plus its CSS.
`apps/capture/src/provider-entry.ts` exports the mounting function, host/resource
interfaces and native journals. Mount it only after the existing native/BFF host
has authenticated and established the current creator's authorized context.

The `ProviderWorkspaceHost` performs the existing Core encounter listing and
creation. `openEncounter` reauthorizes the selected appointment and returns its
server-bound `CoreCaptureScope`, display values and an abort signal. It supplies
`AuthorizedCoreRequest`, which forwards the fixed Core facade path/body/key
through the existing server-side workload/mount authority. Never attach a
workload token, creator assertion or tenant from the UI. The facade remains
`/service/v1/agent/scribe/{capture-admissions,capture-operations,capture-notes}`.

For each encounter, provide a `NativeProviderWorkspaceJournal` using the retained
secure queue plugin and a stable server-bound environment/creator recovery UUID.
Provide `NativeCreatorReviewJournal` for review decisions. The host must
reauthorize before opening either journal. Retain these scopes across restarts
and do not share them between environments or creators. Native queue enumeration
excludes both reserved journal namespaces from audio decoding.

`recorder` reauthorizes, obtains the existing exclusive flow lock and returns
creator/session-scoped flow and queue stores, the approved source, and the
configured upload target. It does not start the source. `release` closes only
those owned handles after the controller confirms source stop. The host's native
recording indicator must remain accurate even if the view disappears. Abort on
logout, revoked access, encounter change or host teardown, and await the returned
workspace disposer. An unconfirmed stop retains the close operation and prevents
opening another recorder. `openInCore` uses the host's existing encounter route.
Disposal also waits for an in-flight recorder acquisition. If native stop fails,
the disposer rejects and retains ownership for an explicit retry; it never reports
successful release while late handles remain open.

Admission, upload, accepted translation, generated note and clinical approval are
distinct states. No retry invents a new consent time or changes a pending note
edit. Successful generation and editing leave notes unreviewed. Unsupported
legacy source/gap/recovery endpoints are not used for configured capture.

## Local evidence

Retained root: `/private/tmp/scribe-configured-core.provider.wtRDMA/`.
The passing browser and server run is `recheck/`:

- `browser-evidence.json`: manual consent/language/start, lost admission recovery,
  review gate, lost save resolution, creator encounter read, logout clearing and
  390-pixel layout without horizontal overflow.
- `scope.evidence.json`: one offline Speech call, one offline translation call,
  and exact decryption of 48,000 generated PCM frames through the real recorder,
  RSA-wrapped session key, AES envelope and audio assembler.
- `core-evidence.json`: one canonical transcript and two retained note versions;
  Core's existing outline then JSON-note calls; no legacy transcript reads.
- `core.xml` and `scribe.xml`: both HTTP server fixtures passed. Desktop/mobile
  screenshots show the actual provider components. All source/identity/model
  inputs are invented fixtures; this is not physical-device or live fidelity
  acceptance.
- `capture-tests.log`: complete capture regression, 135 tests. Review UI: 18
  tests. `focused-final.log` covers the final teardown and boundary assertions.
- `workspace-lifetime.json` and `workspace-lifetime.mjs`: actual compiled browser
  entry, late recorder acquisition after logout, failed native stop, rejected
  disposal, and successful explicit retry. All requests are locally fulfilled;
  no database or provider is used. Final capture lint/typecheck pass in
  `lint-resume.log` and `typecheck-resume.log`.
- `core-preservation.json`: all 82 pre-existing Core files match the prior packet
  manifest. Core HEAD remains detached `e21ba4c`.

The test-only browser host lives in
`apps/capture/e2e/fixtures/provider-workspace.{html,mjs}`. It never participates
in a product build. The Scribe server fixture is
`tests/test_provider_workspace_wire.py` and skips without explicit local fixture
environment. Core orchestration and browser driver are retained as
`test_provider_core.py`, `run-core.py` and `browser.mjs` under the evidence root.
They use the existing isolated Core fixtures and exact owner-approved checkouts.
Do not run them against an existing or shared database. Native credentials and
the Core new-encounter UI are supplied by the host; the fixed browser fixture
qualifies selecting and reopening an existing invented creator encounter.

Earlier attempts are retained: an external pytest registration/driver mismatch,
an incorrect fixture blob-ID extraction, the shared legacy test role's cleanup
assumption, and a final evidence assertion that initially expected one Core model
call instead of its existing two-stage pipeline. The first successful browser
run is `final/`; its server assertion failed. `recheck/` passes all three layers.
No failed run is represented as acceptance and no live trial was repeated.

The newly owned PostgreSQL cluster uses only its private socket at port 55458;
it has been stopped, with data/logs retained. No earlier cluster was restarted.
Recovery leaves the product entry unmounted and retains pending encrypted work.

## Full goal still open

The connected physical iPhone 12 was rechecked as paired, with Developer Mode and
developer services available, running iOS 27.0. The installed W13 identity is
`com.cosmasos.synthetic.w13`, version 1.0/build 1. One Apple Development signing
identity is available; distribution signing remains unqualified. These refresh
the older device-unavailable observation without qualifying device behavior.

The owner reported that Tester sign-in was not complete and requested a W13
restart. The retained Mac candidate at
`/private/tmp/cosmas-w13-auth-work/activation-signin/CosmasOS Sign-In Trial W13.app`
was quit and reopened. Retry sign-out returned its signed-out page; explicit Sign
in opened the helper, then ended at “Secure session is unavailable.” Hosted
credential entry, successful callback and token custody remain unverified.
The existing diagnostic files recorded HTTP 200 for client/environment/hosted-auth
creation at the attempted sign-in; this does not prove browser presentation or
login. The local API port 8046 had no observed listener. No profile, Keychain,
callback, account, auth policy or saved package was reset or changed.

Bind the same entry to the real standalone and CosmasOS authenticated hosts,
complete Tester sign-in and actual token/Keychain/refresh/restart/logout evidence,
qualify physical iOS 17+ and desktop capture/interruption/recovery, reconcile
runtime/deployment inputs, and produce reproducible signed distribution artifacts.
The local facade and browser fixture are not substitutes for those requirements.

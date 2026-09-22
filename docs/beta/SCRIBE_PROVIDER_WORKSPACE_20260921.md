# Local provider workspace — 2026-09-21

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

This closes the native resource-composition gap in source and the provider
bundle. The standalone native identity/authorized Core connection still must be
bound to it, then packaged and qualified on devices. This code is not installed
in W13 build 4. W13 remains the separately approved OS native-session snapshot,
not a relabeled standalone Scribe release. Complete desktop hosting, native
lifecycle, physical capture, real-service fidelity and distribution remain open.

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

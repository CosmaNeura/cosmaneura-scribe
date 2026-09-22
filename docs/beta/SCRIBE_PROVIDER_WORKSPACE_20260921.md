# Local provider workspace — 2026-09-21

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
host composition**. The installed W13 build 2 and its pending phone catalog
trial are unchanged; see [the private connection checkpoint](W13_PRIVATE_CONNECTION_20260922.md).

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

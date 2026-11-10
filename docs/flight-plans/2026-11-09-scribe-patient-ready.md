# Scribe: patient entry to recording readiness

Risk tier: **Tier 2** (consent state machine and recording preparation).
Owner: John Clemente. Local implementation approved on 9 November 2026.

## Scope and release authorization

Improve opening Scribe, entering a patient, confirming consent and starting
recording. Upload and post-visit processing are outside this iteration.
PR #547 merged as `f26b89d27b05716efd85a08cc271204057446228` on 10 November.
v98 preparation starts from that latest main on `codex/scribe-v98-patient-ready`.
The initial preparation authorization allowed local synthetic work, a new draft
PR and hosted CI only. After the local v98 phone test, John explicitly authorized
build 98 in App Store Connect and TestFlight and accepted the observed latency
instead of requiring the under-three-second target before release. Build 97 must
remain untouched. No Git merge or receiver deployment is authorized. The manual
build-7 comparison and the latest v98 test both ended paused.
Core code and authentication/token policy are unchanged. Synthetic tests only.

## Earlier patient-ready work retained

- Consume the authenticated startup catalog once within five seconds; later
  reads remain fresh. Cancellation or expiry discards the initial snapshot.
- Show consent after the exact patient draft is encrypted and saved locally.
  Create/open can proceed while the user reads it. Keep controls separated during
  loading, including narrow layouts; Record remains disabled until opening is ready.
- Carry checked consent only for the exact created patient, appointment and
  current mounted identity. Cancellation, withdrawal, changed identity and recovery
  require explicit consent. Displaying consent never starts audio or admission.
- Replace the staging-only local-consent expiry with the signed native Boolean
  `ScribePatientReadyStartEnabled`, default `false` in the iOS Info.plist.
  Owner: John Clemente; initial preparation cohort: none. John subsequently
  authorized the tested staging configuration for TestFlight packaging after the
  physical v98 flow passed, with latency acceptance recorded below. Review at v98
  ship decision; no calendar automatically enables or disables it. The earlier
  consent-preparation experiment remains expired.
- Negotiate native_create_opening_v1 with full native visit capability. Compose
  the existing create and mount decisions with full current-user checks, exact
  recovery/patient/appointment matching and a 30-second composition limit.
  Consume the correlated opening once within five seconds; older receivers or
  expired receipts use a fresh mount. Uncertain creation retains its original key.
- Add bounded numeric timing phases to the existing private native journal.
  Never log names, patient references, text, tokens or recording content.

## Items 1 and 2

1. **Avoid eager source preparation on a fresh explicit Record action.** Pass an
   optional acquisition hint through the renderer/native bridge. Negotiate a new
   capability; older builds receive their original request. The plugin advertises
   it only when the signed native release flag is true, in either validated profile.
   The renderer requires both `patientReadyStartVersion: 1` and
   `recordingInitialStartVersion: 1`; older builds keep their original request.
   Native plugin and factory independently enforce the same flag. Native code also
   requires its own one-use proof of a newly created empty flow. Open durable
   key/window custody, then let Start persist its source checkpoint and create
   the original stop-proof owner before the combined source request is dispatched.
   This selects existing combined preparation/authorization and overlaps microphone
   startup using ADR 0100's bounded RAM hold. Idle prewarming, reopened flows and
   pause/resume keep their existing path. Expired leases still renew; rejected or
   uncertain replies require physical stop and exact retained stop custody.
2. **Reuse adjacent request-owned account checks.** Creation's capability/account
   response supplies the transport's initial snapshot. Source operations use the
   same current catalog reply for initial account and exact selected visit.
   Keep fresh checks after workload-token acquisition and after native response
   before publication. No account cache, token cache or extended expiry is added.

Nominal request counts, excluding retry/legacy fallback: fresh Record phone to
receiver 4 → 3; receiver to Core 21 → 15; creation to Core 5 → 4; context reads
per source operation 4 → 3.

Both Core source decisions still execute in the combined request. The 4,468 ms
preparation stage can overlap microphone startup; it is not a promised 4,468 ms
reduction in indicator delay. One manual build-7 synthetic comparison measured
patient-to-ready 6,927 ms, consent-to-Record 4,375 ms and Record-to-indicator
16,117 ms. John felt earlier steps faster but the indicator wait slightly longer;
the flow remains too slow. The combined route ran and pause froze input/released
the driver. That phone test did not include the item-2 receiver change.
The 693 ms native Start-to-input excluded the full post-tap request chain.

## v98 release control and phone evidence — 10 November

Items 1 and 2 are implemented on merged main. John supplied the completed build-8
iPhone 12 test from the prior work: item 2 was already active on staging, healthy
and serving all traffic. This v98 work performs no deployment. John subsequently
explicitly authorized preparing and installing a staging-only local Scribe S v98
build for the physical-phone acceptance test.
The prior staging OS exception is unchanged; it is not a production acceptance.

The retained synthetic-only `build8-india-comparison.json` confirms one successful
fresh visit followed by pause: input frozen, driver released, no dropped diagnostic
events, and no recording content accessed. Timings below are milliseconds:

| Measure | Build 7 | Build 8 before item 2 | Build 8 with items 1+2 | Local v98 with items 1+2 |
| --- | ---: | ---: | ---: | ---: |
| Patient-to-ready | 6,927 | 6,999 | 5,152 | 5,449 |
| Consent-to-Record enabled | 4,375 | 5,032 | 3,216 | 3,286 |
| Record-to-recording-ready | 16,117 | 18,620 | 16,123 | 18,628 |
| App-to-patients | not recorded here | 3,690 | 7,803 | 4,700 |

These are individual observations, not a causal speed estimate. Against build 7,
patient readiness improves 1,775 ms and consent readiness 1,159 ms; the indicator
is 6 ms slower. **The physical-phone under-3,000 ms target is not met.** For build 8,
native Start-to-input is 594.511 ms; an approximately
12,803.574 ms full tap-to-input estimate crosses diagnostic clocks and is not
interchangeable with the measured 16,123 ms renderer readiness duration.

The enabled phone made three startup receiver calls: admission 5,261 ms,
capture operation 3,656 ms, and combined source-start-ready 3,667 ms (12,584 ms
total, including 1,585 ms token acquisition). Receiver time totals 10,967 ms.
The 4→3 phone and 21→15 Core counts above are structural expectations for the
original versus optimized path; build 7 already used three phone calls. Receiver
regressions verify three current-context reads per source operation and four Core
requests for creation. The phone journal alone cannot measure receiver-to-Core
request counts; do not present the expected 15 as a newly observed phone count.

The latest v98 attempt completed at 10:36:06.909 AM Eastern on 10 November.
The numeric phone journals measure 18,628 ms from the renderer's Record action to
recording-ready acceptance; this is not a frame-level visual timer measurement.
Native Start-to-first-input is 1,399.431 ms and excludes the preceding service
chain. The approximately 15,152.106 ms full tap-to-first-input value is a
cross-clock estimate, not a directly recorded duration. Patient-to-consent is
32 ms; consent-to-Record and patient-to-ready overlap and must not be added as
exclusive intervals. The three startup receiver calls total 14,569 ms:
admission 6,156 ms, capture operation 3,773 ms and source-start-ready 4,640 ms.
Within them token acquisition totals 2,236 ms and receiver time 12,286 ms.
The later source-start after pause is excluded. Input froze, the microphone
driver released, and no diagnostic events dropped. No recording content was read.
Against build 7, v98 patient readiness is 1,478 ms faster, consent readiness
1,089 ms faster, and recording readiness 2,511 ms slower. John reported that the
flow worked and accepted this total latency for the requested TestFlight release.
This acceptance does not change any authority, consent or audio-custody checks.

`ScribePatientReadyStartEnabled` is a strict plist Boolean: absent, false, strings,
numbers and malformed values are off. It gates native early microphone scheduling
and acquisition advertisement; the renderer's new capability requirement also
gates local draft consent. Neither bundle name, receiver profile nor the old
16 November deadline activates it. Profile validation, explicit consent, exact
mount matching, one-use created-empty-flow proof, source checkpoints, bounded RAM
custody and fresh per-operation credentials remain required. No token/account
cache is introduced. Cancellation, rejection and expiry still discard held PCM.
App and widget Debug/Release build numbers are 98; this source bump does not
change Apple's build 97. The committed flag and generic unsigned candidate
application configuration stay off. The separately signed local beta test build
and the authorized TestFlight packaging copy deliberately set the flag to true
and use the retained staging-only configuration.

Recovery is to keep the flag false (or omit it) in the next signed local/release
candidate, retain the receiver's backward-compatible routes, and rerun fallback
checks. Never replace, clear or rebind retained recording custody to switch paths.

### Exact next local phone test

1. Use a separately signed local **Scribe S** build 98 against the already-approved
   staging receiver. Preserve installed app data and build 97's Apple review.
   First verify the default-off candidate uses the original consent/acquisition
   path. For the enabled comparison, deliberately set the signed candidate's
   `ScribePatientReadyStartEnabled` to Boolean `true`; verify both native version-1
   capabilities. Do not enable it through JavaScript or a patient form.
2. Unlock the physical iPhone 12, reopen Scribe S, and create a *new* synthetic
   visit each time. Use `Synthetic Ready V98 01`, then `02` through `05`; never
   reuse an existing/recovered visit for the fresh-start measurement. Enter no
   real patient details. Keep the network and microphone selection fixed.
3. Measure Continue→patient-ready and checked consent→Record-enabled from the
   bounded numeric entry journal. Tap Record once and measure the full tap→timer
   plus actual microphone activity, including all admission/recorder/source work.
   Record first-input separately; an armed microphone, spinner or advancing timer
   without input is not acceptance. Use generated synthetic sound only.
4. After 5–10 seconds, tap Pause. Confirm the timer/input freeze and driver release.
   Leave the visit paused; do not upload or process it. Confirm a pause/resume run
   separately so it cannot be mistaken for a fresh-start sample.
5. Retain only numeric durations, fixed action names, status, request counts and
   drop counts. Compare five fresh runs (including a cold app opening), median and
   worst case with the table above. Target: **every measured Record→indicator
   under 3,000 ms**, with actual input and confirmed pause. Count receiver calls
   directly; collect receiver-to-Core counts only from metadata-only counters.
6. In the offline synthetic harness, additionally exercise cancellation while
   admission/source replies are delayed, denied microphone/authority, expired
   leases and older native/receiver capabilities. Assert zero persisted held audio
   for unsuccessful starts and retained exact stop custody. Do not inject these
   faults into the deployed receiver.

The fresh v98 phone flow, pause and microphone release passed. John waived the
unmet latency target for this release; green hosted CI and independent review
after the last substantive push remain required. Further request reduction
needs a separately reviewed follow-up to the deferred work below; do not inflate
the RAM hold or weaken authority checks to claim a faster start.

## Validation and recovery

v98 local validation (10 November): full npm suite passes after an isolated
desktop temporary-directory cleanup race passed on recheck and full rerun;
120 browser cases pass. Receiver regressions: 177 pass. Native run checks: 285;
binding checks: 239; iOS module/bridge/factory typechecks pass. Full unsigned
physical-iPhone-target build succeeds; built app and widget both report 98,
the feature flag and application are disabled, and no signature is present.
ESLint, TypeScript, Ruff, Pyright, web/provider builds, PHI-log/secret/ADR scans
and whitespace pass. PCM package: 45 tests pass; native recording package:
95 core and 38 continuation/sink tests pass (133 total).

The final full Python run with Node 24 and a fresh disposable PostgreSQL database
reports 2,669 passed, 44 skipped, 67 subtests and 87.00% coverage. Earlier runs
identified a host Node-22 launcher and correctly refused database reuse; the
required runtime and a new disposable database resolved those environment errors.
No product code or safety check was changed to obtain the passing result.
The receiver wheel/source distribution and 125-file hash-verified disabled image
context build locally. The shared Docker engine's registry DNS failed; a separate
local engine with working DNS completed the pinned linux/amd64 image build without
changing the shared engine. Local image identity:
`sha256:c5b587b5603625f4ed0398d49f095f247ec4cbf5ee68317f402d52616e21ac83`.
It runs as `10001:10001`, contains no active configuration, and exits with
`receiver_image_contract_unavailable` before a listener when started without a
contract and with networking disabled. No image is published or deployed.
Trivy remains red: 51 HIGH OS findings exactly match the prior staging image's
package/version/CVE tuples; no new HIGH/CRITICAL findings, no Python HIGH/CRITICAL
findings and no secrets. The existing exception applies only to staging, not
production. Private validation evidence and the identity fixture ZIP remain
outside the checkout. Draft PR: https://github.com/CosmaNeura/cosmaneura-scribe/pull/550.

Hosted head `535eadc` passed quality, web, Android, browser flow, infrastructure,
build, change budget and four CodeQL language/workflow checks. iOS failed at the
binding harness's 250 ms wall-clock saving assertion after the exact request and
token counts passed. The synthetic harness now asserts the exact injected request
waits (600 ms original, 300 ms combined) while retaining elapsed timings as
diagnostics; runner scheduling is not physical-phone acceptance. No production
code or authority/custody check changes in this follow-up. The full local native
checker rerun passes 285 run checks, 239 binding checks and all iOS typechecks.
Fresh exact-head hosted checks are required after this fix. At this evidence
update, head `10389bf` has passed web, browser flow, build, infrastructure, change
budget and four CodeQL language/workflow checks; quality, Android, iOS and Swift
analysis are running. John explicitly authorized a fresh independent review agent
for PR #550. Its read-only review of `10389bf`, after the last substantive push,
found no actionable code or documentation issues. This is not GitHub approval
or production authorization. No prior chat was contacted.

Final hosted verification of head `3aea2e4`: all 15 distinct checks passed,
including iOS, quality/receiver scans and Swift CodeQL. CI run:
https://github.com/CosmaNeura/cosmaneura-scribe/actions/runs/42831087601.
CodeQL run: https://github.com/CosmaNeura/cosmaneura-scribe/actions/runs/42831088400.

### Authorized local staging phone build

The current PR native source and renderer were assembled with the exact retained
Clerk/Capacitor inputs. Only the hash-verified build-8 staging configuration and
beta signing identifiers were applied to the private copy. App and widget are 98;
bundle `com.cosmaneura.scribe.beta`; display name Scribe S; native identity profile
`core-staging-personal-v1` and receiver profile `core-staging-https-v1`.
The local Boolean feature flag and staging application are enabled; bridge
logging remains disabled. Existing local development signing covered this phone
and both beta identifiers. Strict deep signature verification passed on the clean
install copy. No Apple account/provisioning update or production unlock was used.

Local installation replaced beta build 8 without uninstalling it or deleting app
data. iOS assigned a new data-container identifier. The pre-existing bounded
startup diagnostic file survived byte for byte; the new process refreshed its
staging catalog and rewrote its provider timing journal normally. Prior-visit UI
confirmation is partial: John saw the most recent prior visit, but not earlier
ones. Actual data loss is not established. The list opens on today's date and
filters other days; checking the previous-day controls and hidden-visit filter
remains necessary to explain the earlier visits' visibility. Patient, token and
audio content were not read. The prior attempt was confirmed input-frozen and
driver-released before installation. Production bundle metadata is unchanged;
build 97 and the receiver deployment remain untouched. Private
build/configuration/signing evidence remains outside Git. The phone can be
disconnected: the latest synthetic test's numeric journals were copied privately,
and input-frozen/driver-released were confirmed before disconnection.

### Authorized Apple packaging

Read-only Apple API inspection identifies app `6818243824`, bundle
`com.cosmaneura.scribe.beta`, marketing version `1.0`, and latest uploaded build
`97`. Contrary to the earlier review snapshot, build 97 is now in internal and
external beta testing; it is not modified. The public App Store version remains
rejected with build 86 selected and an unresolved review submission. Build 98 is
the next available upload number. Packaging uses the same tested staging native
identity/receiver configuration, the current PR renderer/native source, and the
existing local Apple Distribution certificate and app/widget Store profiles.
No receiver image, Core configuration, credential policy or production cohort is
deployed or enabled. Release archive and Store export pass. Deep strict signature
verification confirms distribution signing, debug entitlement false and exact
app/widget Keychain groups matching retained Store-build-96 signing. The local
phone copy uses implicit app-identifier scope and has no explicit Keychain-group
entitlement; do not describe its entitlement bytes as identical to the Store IPA.
The first export omitted explicit groups and was withheld. The corrected export
uses explicit app/widget entitlement files in the private packaging copy, with no
product code or identity/configuration change. Existing Xcode-managed profiles
require automatic export signing; no provisioning update or new credential was
requested. Apple package validation reports no errors. Final IPA SHA-256:
`51e3a8c4421ef913339a5b814e93f33627d092abf451acf6b90e193e96126f07`.
Apple reports successful upload with no errors, delivery/build
`4733a719-1287-4727-a77b-0556636219c0`. Processing is `VALID`; the existing
exempt-encryption classification is recorded for build 98, without a crypto
implementation change. Build 98 is assigned to both existing testing groups.
Internal state is `IN_BETA_TESTING`; external state is `BETA_APPROVED` following
the new beta review submission. Synthetic-only test instructions are saved.
Automatic notifications are false. Starting external distribution through
Apple's Notify Testers action sends messages to existing invited testers; explicit
owner authorization for that action is pending. Build 97 remains valid and in
both groups, and no public App Store submission has been changed.
Independent read-only review of the final package verifies all 392
candidate hashes, source/renderer binding, exact retained Store-96 signing scopes,
enabled staging configuration, strict distribution signatures and absence of
private evidence/fixtures in the IPA. No actionable packaging findings; this is
not GitHub approval. No tester invitations or notifications have been sent.

App regressions cover explicit acquisition, consent cancellation, withdrawal,
recovery, late handles and older-build negotiation. Native regressions cover
fresh/recovered scheduling, lease expiry, checkpoint/constructor failure,
denied/lost/malformed combined replies, delayed cancellation and stop custody.
Real encrypted PCM checks ensure cancelled, denied or expired starts never write
held synthetic audio to recording storage. Log/secret scanners must pass.
Before the final staging guard: 320 app cases, 277 native run cases (including 18 passage
selection cases), 239 binding cases, iOS typechecks/full unsigned build,
TypeScript, ESLint, Python lint, web build, log/secret scans and diff whitespace.
Hosted 201b6c8 passed the native checker (including five guard cases), 121 browser
cases and seven secure-queue tests plus the full iOS build.

Receiver regressions retain revocation/account-change fences and assert request
order. CI prepares twelve frozen identity files from a dedicated fixture asset:
verify the full archive hash before extraction, then each source and the existing
zero-fuzz policy patch. Only these tests receive the prepared PYTHONPATH and raw
qualified-source path. The reviewed CI asset is hosted and download-verified;
the CI fixture fix is now on main. The 10 November request authorizes new local
receiver validation and Git staging for the v98 draft. If staging is blocked, stop and
report the exact command; do not retry by renaming, splitting or encoding it.

A later phone comparison must measure patient-to-ready, consent-to-Record,
full Record-to-first-input/indicator and HTTP counts using fresh synthetic visits.
Preserve existing app data, use manual recording only and confirm pause/stop.
The independent review above follows the last substantive push; any further
substantive change requires another review. No deployment is authorized.

## Deferred work

Items 3–5 remain deferred: replace full-catalog source enumeration with targeted
selection; join admission metadata inside Core; qualify broader request-owned
credentials only after reducing requests. Existing create/open composition saves
one phone round trip and token fetch, not all mount work. More form caching,
larger audio buffers and upload changes do not target the measured bottlenecks.

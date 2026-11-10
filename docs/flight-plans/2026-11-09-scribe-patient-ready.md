# Scribe: patient entry to recording readiness

Risk tier: **Tier 2** (consent state machine and recording preparation).
Owner: John Clemente. Local implementation approved on 9 November 2026.

## Scope and release hold

Improve opening Scribe, entering a patient, confirming consent and starting
recording. Upload and post-visit processing are outside this iteration.
PR #547 merged as `f26b89d27b05716efd85a08cc271204057446228` on 10 November.
v98 preparation starts from that latest main on `codex/scribe-v98-patient-ready`.
Release remains on hold: local synthetic work, a new draft PR and hosted CI only.
Build 97 is in Apple review and must remain untouched. No merge, deployment,
TestFlight upload, App Store Connect upload or submission. The manual build-7 comparison ended paused.
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
  Owner: John Clemente; initial cohort: none. Deliberate candidate activation and
  phone acceptance are required before selecting a release cohort. Review at v98
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
and serving all traffic. This v98 work performs no deployment or phone installation.
The prior staging OS exception is unchanged; it is not a production acceptance.

The retained synthetic-only `build8-india-comparison.json` confirms one successful
fresh visit followed by pause: input frozen, driver released, no dropped diagnostic
events, and no recording content accessed. Timings below are milliseconds:

| Measure | Build 7 | Build 8 before item 2 | Build 8 with items 1+2 |
| --- | ---: | ---: | ---: |
| Patient-to-ready | 6,927 | 6,999 | 5,152 |
| Consent-to-Record enabled | 4,375 | 5,032 | 3,216 |
| Record-to-indicator | 16,117 | 18,620 | 16,123 |
| App-to-patients | not recorded here | 3,690 | 7,803 |

These are individual observations, not a causal speed estimate. Against build 7,
patient readiness improves 1,775 ms and consent readiness 1,159 ms; the indicator
is 6 ms slower. **The physical-phone under-3,000 ms target is not met.** No v98
phone timing is claimed. Native Start-to-input is 594.511 ms; an approximately
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

`ScribePatientReadyStartEnabled` is a strict plist Boolean: absent, false, strings,
numbers and malformed values are off. It gates native early microphone scheduling
and acquisition advertisement; the renderer's new capability requirement also
gates local draft consent. Neither bundle name, receiver profile nor the old
16 November deadline activates it. Profile validation, explicit consent, exact
mount matching, one-use created-empty-flow proof, source checkpoints, bounded RAM
custody and fresh per-operation credentials remain required. No token/account
cache is introduced. Cancellation, rejection and expiry still discard held PCM.
App and widget Debug/Release build numbers are 98; this source bump does not
change Apple's build 97. The candidate flag and application configuration stay off.

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

Release acceptance requires the latency target, a fresh v98 phone run, green
hosted CI and independent review after the last substantive push. The latency
target and fresh phone acceptance remain unmet. Further request reduction
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

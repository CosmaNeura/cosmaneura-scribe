# Scribe: patient entry to recording readiness

Risk tier: **Tier 2** (consent state machine and recording preparation).
Owner: John Clemente. Local implementation approved on 9 November 2026.

## Scope and release hold

Improve opening Scribe, entering a patient, confirming consent and starting
recording. Upload and post-visit processing are outside this iteration.
Release is on hold: local staging work, draft PR #547 and hosted CI only.
No merge, deployment or TestFlight. The manual build-7 comparison ended paused.
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
- Limit this local-consent experiment to the staging personal profile through
  16 November 2026. The earlier consent-preparation experiment remains expired.
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
   it only for the beta bundle and staging receiver profile. Native code also
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
the driver. The staging receiver is unchanged, so item 2 is not yet active.
The 693 ms native Start-to-input excluded the full post-tap request chain.

## Validation and recovery

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
push this CI fix next. Do not retry blocked local receiver tests or Git staging.

A later phone comparison must measure patient-to-ready, consent-to-Record,
full Record-to-first-input/indicator and HTTP counts using fresh synthetic visits.
Preserve existing app data, use manual recording only and confirm pause/stop.
Independent review follows the last substantive push; no deployment is authorized.

## Deferred work

Items 3–5 remain deferred: replace full-catalog source enumeration with targeted
selection; join admission metadata inside Core; qualify broader request-owned
credentials only after reducing requests. Existing create/open composition saves
one phone round trip and token fetch, not all mount work. More form caching,
larger audio buffers and upload changes do not target the measured bottlenecks.

# Native request performance

## Verify the signed desktop package before timing

After the final native-helper signing and enclosing-app signing, run this
read-only check against the actual Apple Silicon app that will be installed:

```sh
python scripts/check_signed_desktop_package.py '/absolute/path/Cosmaneura Scribe Beta.app'
```

It verifies all three final helper hashes against `provider-profile.json`, the
existing provider identity and exact existing Keychain claims, an embedded DER
claims slot, and Apple's strict deep signature validation. It neither launches
the app nor accesses data keys. A successful check qualifies these package
properties; it does not prove launch, network access or recording readiness.

Re-signing a helper changes its hash even when its runtime code is unchanged.
Update that helper's profile pin from its final signed bytes before signing the
enclosing app. Apple's default `codesign --display --entitlements -` output can
be a pretty dictionary rather than XML. Treating it as an absent plist can drop
existing provider claims during re-signing. Preserve the verified existing
claims, then check the actual signed Mach-O data; do not broaden access or accept
empty claims. Run `python scripts/test_signed_desktop_package.py` for the local
regressions covering these two observed failures.

Keep a known working package for recovery. Follow package verification with an
authorized normal launch and a synthetic visit-to-Ready check. Record those
results separately from the read-only package checks.

Before physical audio timing, follow the
[physical audio test environment](physical-audio-test-environment.md) procedure.
Device Hub mirroring has interfered with iPhone microphone capture in the current
test setup. Verify it is closed before and after each run; do not use mirrored
screens to qualify recording readiness.

The iPhone bridge and Mac provider helper use Apple's unified logging to record
local request timing under subsystem `com.cosmaneura.scribe.performance`, category
`provider`, at info level. A `provider_request` event contains only the validated
action enum, token retrieval milliseconds, receiver milliseconds, total
milliseconds, numeric HTTP status and whether reply validation completed.
It has no request/session/account/encounter identifiers, credentials, URL, body,
audio, transcript, note text or error description. No remote telemetry is added.

Token and receiver durations use a monotonic clock. Receiver time begins just
before the existing wire call and ends on its reply. A receiver duration of -1
means no wire call began; status 0 means no HTTP reply arrived. Completed means
the native reply passed validation, including a sanitized rejection; it does not
mean clinical success. Failures and cancellations still emit the bounded timing
record, with the elapsed time of the phase that did not complete.

For an authorized synthetic Mac opening check, start a narrowly filtered local
log stream, then open the existing synthetic encounter through the normal UI:

```sh
/usr/bin/log stream --style json --level info --predicate 'subsystem == "com.cosmaneura.scribe.performance" AND category == "provider"'
```

Stop that stream after the check. Compare catalog/mount timings across repeated
openings on the same release. These are native request durations, not the full
tap-to-visible-review or tap-to-live-microphone interval. Do not weaken fresh
authorization or infer a 50% UX improvement from these narrower measurements.
If receiver time dominates, measure the server phases before changing them.

Fresh Clerk token retrieval also emits a `provider_token` event in category
`token`. This invocation-local observer contains only bounded total and HTTP
milliseconds, request/response counts, retryable-response count, pending-request
count and completion. Middleware increments numeric counters without retaining
the request, response, headers, body, URL, credential or exception. It does not
change `skipCache: true`, SDK retry behavior, account checks or token policy.

HTTP time covers the union of outgoing SDK request intervals until their
responses, including requests made by child tasks in that token invocation.
It excludes response processing and backoff between completed HTTP attempts.
A network failure has no response callback: its pending interval remains open
until the token call ends, so that HTTP duration may also include later backoff.
Pending requests make this limitation visible. Counts do not identify endpoint
paths or prove that every SDK request was a token-mint request. Detached SDK
tasks have no invocation observer. Closing freezes the numeric ledger; late
responses are ignored. Total minus HTTP therefore is not a universal measure
of SDK CPU time. No DNS/TLS breakdown or remote credential telemetry is added.

Run `python scripts/check-native-transport.py --output /absolute/new/directory`
for the offline token timing, native auth and transport regressions. Compile
the actual helper with the exact retained Clerk dependency to verify middleware
compatibility separately; the offline numeric tests alone do not prove runtime
task inheritance in that SDK. Use a short approved synthetic preparation and
filter only category `token` to compare actual request counts with the existing
native token totals. Timing cannot establish successful recording or replace
visible consent-to-Ready measurement.

The standalone receiver also emits cumulative request phase durations through
Scribe's existing safe event logger. Labels have the form
`provider.<fixed-phase>`, followed by `provider.<fixed-action>.total` in the same
synchronous emission. The action comes from the receiver's closed route list;
phases are `registry`, `workload_token`, `core_exchange`, `core_mount`,
`core_binding` and `core_operation`. Only the label and
monotonic duration are supplied; the existing logger's identifier/error fields
remain null. No token, URL, body, account, visit, transcript or exception text
is passed to the logger. This adds no telemetry destination or client response
field.

`registry` covers fresh identity and current-row checks. `workload_token` covers
the existing credential provider. Core phases include connection, response-body
read and protocol decoding for that fixed operation. The consent-rejection path
also performs its existing registry check inside the Core phase, so durations
are not universally additive. `total` ends when the handler returns response
headers; it excludes sending the body and native/UI work. Failed and cancelled
requests produce elapsed phases too; timings never imply successful capture.
Concurrent requests keep separate accumulators. Logging failure does not change
the request result, and late work cannot append to a completed observation.

Use a short, approved synthetic request window when comparing server phases;
events deliberately have no request identifiers. Keep the native token and wire
timings alongside them. Neither query counts nor these server durations alone
prove that Record-to-audio readiness has been halved.

## Local workflow and Instruments timing

The desktop app's existing private, bounded `runtime-diagnostics-v1.jsonl`
adds three fixed numeric durations. `provider_recorder_attach` ends when the
main process finishes the recorder acquisition/attachment request; it includes
failed requests and can end before background preparation. `provider_recorder_prepare`
starts at that request and ends once the trusted recorder reports initial
`ready` / `capture_ready`, including background preparation. `provider_consent_to_ready`
starts immediately before the first successful encrypted consent-journal save
and ends at that same Ready state. The consent span is retained only in the
current main-process encounter and consumed for its matching admission key.
Reopening a saved visit has no first-consent span.
An admission rejection, lost response or different request key discards the
first-consent span; later recovery cannot turn that failed attempt into a
successful initial-readiness measurement.

Ready measurements are not emitted for failed preparation, insufficient or
unknown storage, required permissions, cancellation or changed ownership. The
observer ends on the first settled state; a later retry cannot convert the
failed attempt into a successful measurement. Log only the fixed event and
numeric duration, never the admission key or recorder snapshot. Diagnostic
failures cannot change recording access, ownership or cleanup.

These are main-process boundaries. The consent span excludes the short interval
from the button click to receipt of its journal-save request and final renderer
paint. It also excludes a later meeting selection or Start action. Pair it with
the visible Ready observation when assessing the full 5–7 second UX target;
do not count attachment settlement or a sum of overlapping backend timings as
proof of readiness.

The provider workspace and recorder also emit bounded User Timing measures
named `scribe.ui.<fixed-action>.<resolved|threw|cancelled>`. They contain numeric
times only. Names come from a closed action list; patient, encounter, session,
query, note, error and request values never enter the measurements. Each fixed
action/outcome keeps only its most recent observation. No telemetry destination,
network exporter, persistence or new WebView inspection permission is added.

`select-patient` and `patient-create` cover the normal new-visit action through
opening its next view. `prepare` covers explicit consent/start handling, while
the nested `record` covers the controller start operation. `open`, `read`,
`generate`, `save`, `resolve`, `stop-upload` and `upload-retry` isolate the other
long waits. Read these local measures through an already-authorized browser
or renderer performance tool. Release iPhone WebViews may not be inspectable;
native Appium accessibility observations remain a separate measurement path.

`resolved` means the action promise returned, not that a clinical or recording
operation succeeded. Controllers may return with an error/recovery state.
Check the visible state and durable result independently. These intervals end
at action settlement and exclude later browser paint; `record` does not prove
first audio input. Compare it with native `firstInputBuffer` diagnostics.
Overlapping/nested intervals must not be summed. Cancellation and exceptions
remain distinguishable; diagnostic API failures do not change the product flow.

The native provider connection adds Instruments signpost intervals named
`Provider request`, `Provider token` and `Provider receiver` under the existing
`com.cosmaneura.scribe.performance` / `provider` subsystem/category. Each request
uses its own local signpost identity. Intervals close on success, rejection,
exception or cancellation. Existing content-free request logs provide the fixed
operation name and status alongside these intervals; authorization, wire data
and response validation are unchanged. No raw text is supplied to signposts.

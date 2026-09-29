# Native request performance

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

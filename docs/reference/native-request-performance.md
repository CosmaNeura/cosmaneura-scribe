# Native request performance

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

# Bounded iPhone startup diagnosis

Tier 1. iPhone24 accepted the first recording start, then failed two explicit
continuations, including after normal stop and encounter reopen. Source-start
metadata confirms all three source owners stopped. The player never started,
so this run does not establish microphone signal or transcription quality.

The current public error intentionally conflates authorization and audio-start
failures. Reuse the desktop runtime journal's bounded, local, allowlisted
lifecycle approach to distinguish those stages on the next synthetic test.
The native iPhone plugin enables a dedicated Caches file containing at most128
enum events and UTC timestamps (32KiB bound), with private mode and backup
exclusion. Writes run off the capture path; storage failure is non-fatal.
There are no audio, transcript, identity, session, token, URL, or raw-error fields,
no network transport, and no new JavaScript bridge method. Disabled native-core
users do not collect events. Existing authorization, routing, event handling,
capture, stop, and upload behavior remains unchanged.

Validation: native package tests cover bounded concurrent admission, exact safe
schema, permissions/backup exclusion, disabled behavior, immutable destination,
and non-fatal storage failure. Compile the iPhone plugin in its actual app archive.
Local evidence must distinguish diagnostic readiness from fixing the failed
continuation. Same-identity installation preserves the queue and keys; the next
approved short synthetic test reads only this dedicated diagnostic file.

Recovery: use the prior same-identity app artifact; no data migration, fixture
mutation, recording reset, or cloud deployment is part of this change.

# iOS provider timing journal

Risk: Tier 1. This records existing, content-free request measurements locally.
It changes no authentication, consent, source authority, retry, recording,
transport, application configuration, or production deployment.

The physical build 87 run reported 5,092 ms from the Record handler to native
ready. Its source-ready authorization roundtrip took 4,215 ms; the remaining
audio activation and first-input path took about 621 ms. Those lifecycle events
identify the slow roundtrip but cannot divide it into token refresh, receiver,
registry and Core work. The existing request timing callback already has that
numeric information, including strictly parsed Server-Timing values, but its
info-level unified log was unavailable after this physical run.

The iOS callback now also writes a separate cache journal at
`scribe-provider-timing-v1.json`. It accepts the existing typed request timing,
not request/reply bodies, credentials, identities, URLs, raw headers or error
messages. Missing server/Core metadata stays absent for that request. Core
measurements retain explicit response-start and nonadditive markers.

The journal has at most 128 entries, 160 pending writes and 64 KiB. Admission is
bounded, serialization and filesystem work run on a separate queue, the file is
mode 0600 and excluded from backup, and any diagnostic failure is ignored by
the request. Desktop keeps its current logging behavior. Existing startup and
recording journals and retained audio are unchanged.

Validation uses the actual request/transport checks for typed metadata,
missing-metadata isolation, numeric bounds, output vocabulary, permissions,
concurrent admission and size limits, plus the actual iOS compilation check.
A native rerun must collect both timing journals and identify the dominant
operation before proposing its performance change. This PR is diagnostic source
work; it does not pass the live five-second acceptance gate or qualify a release.

Recovery before release is to revert this source change. Removing the optional
cache journal has no effect on recordings, leases or processing state.

# Desktop Record observations

The optional `withDesktopRecordPerformance(AppiumUI, {profileDirectory})`
adapter observes one existing normal Record action. It creates no recorder,
source, permission, retry or diagnostic event. Compose it **inside** a
before-Record scope/source checkpoint so that its sampling starts after that
wait. The engine journal retains the complete Record phase, including the wait.
Retain checkpoint entry and dispatch timestamps separately when using a wrapper.

An owned named scenario may set `desktopInspector.discoverCurrentProcess: true`
and omit `pid`. The normal inspector creation resolves the sole loopback listener,
checks its executable/start row and actual Electron identity, and verifies the
configured signed bundle. Never regenerate a binding by copying a prior PID.
Explicit PID configurations retain the same checks. No app is launched by this
option; cold/warm launch trials need their own normal launch dispatch evidence.

## Prospective targets and boundaries

The user's strict **less than 5000 ms** targets are reported separately for:

- Native readiness: native ready acknowledgement **and** at least one second of
  accepted converted audio frames observed in the same settled recorder.
- The normal configured visible Recording assertion.

The existing provisional engine `recordReadyMs = 3000` budget is unchanged.
Record starts at the configured raw adapter click invocation, not engine action
entry, physical touch, or source playback. The click acknowledgement, native
ready acknowledgement, accepted-frame observation and UI assertion have separate
times. Controller/main-process monotonic clocks are correlated using repeated
RPC brackets; inconsistent mapping cannot qualify.

Desktop 922 publishes `floor(acceptedMixedPCM16Frames / 16000)` as
`elapsedSeconds`. On an initially ready, zero-frame, zero-chunk recorder, a later
settled same-scope value of at least one proves at least 16000 accepted converted
frames by the read return. This is a conservative upper bound; exact first native
and converted buffer timestamps remain **unavailable**. Transitional pending
snapshots are retained but cannot qualify accepted frames.

The source starts only after Recording. Nonzero marker arrival and saved audio
must be checked separately; neither silent buffers nor `audio_packet_sink`
duration logs prove saved audio. No source-start delay is subtracted to improve
the Record result.

## Evidence and limits

Only current-process allowlisted metadata from the private bounded
`runtime-diagnostics-v1.jsonl` is read. Initial/final diagnostic rows, intermediate
file hashes, current scope and native/UI observations are retained privately.
File changes, lost attempt anchors, changed owner/scope, failed native events,
missing counters or uncertain input leave timing unqualified. Normal action
failure is rethrown unchanged; launched readers are awaited before returning.
No timing receipt grants consent, authority or cleanup permission.

`desktop-phase-*` files retain controller monotonic setup, sign-in, workspace,
creation, preparation and consent intervals without copying result bodies.
`host_open` to `window_ready` is a separate application diagnostic interval;
neither it nor inspector attachment establishes cold/warm OS launch latency.
Those boundaries require a fresh, explicitly classified normal launch trial.

Focused tests (Node 24, owned loopback only):

```sh
node --experimental-test-module-mocks --test \
  tools/virtual-lab/coordinator/desktop-observer.test.mjs \
  tools/virtual-lab/coordinator/desktop-performance.test.mjs \
  tools/virtual-lab/coordinator/desktop-performance-lifecycle.test.mjs \
  tools/virtual-lab/coordinator/native-performance.test.mjs \
  tools/virtual-lab/coordinator/native-performance-lifecycle.test.mjs
```

Recovery is to stop selecting this optional adapter and use the prior reviewed
coordinator. Existing evidence and any uncertain native lease remain preserved.
The source change does not rebuild or replace either client.

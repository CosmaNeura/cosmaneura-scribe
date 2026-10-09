# Physical audio test environment

## Mirroring interference observed September 28–29, 2026

Treat Device Hub phone mirroring as an interfering test condition in the current
Mac/iPhone setup. Keep Device Hub and phone mirroring closed throughout physical
microphone acceptance and startup measurements. Do not reopen them to observe
recording. Use direct phone controls and the existing bounded timing/signal
diagnostics instead.

Two comparisons support this rule:

- On September 28, Scribe's microphone bars moved after screen sharing was turned
  off while USB remained connected. Device Hub had reported audio-stream errors
  during capture. This shows that USB charging alone does not prevent recording.
- On September 29, the owner reported that Voice Memos could not record. Closing
  Scribe did not restore it. Device Hub was still running; after its normal Quit,
  a process check confirmed it stopped and the owner confirmed Voice Memos worked.

This establishes an observed interference condition, not Apple's underlying OS
mechanism or a universal restriction across devices/versions. It does not show
that existing Voice Memos recordings were deleted. Do not deliberately recreate
the failure during ordinary acceptance or change OS permissions to work around it.

Scribe does **not** embed or depend on the Voice Memos app. Its iPhone adapter in
`apps/capture/native-plugins/ios-pcm-capture/Sources/CosmaneuraIOSAVFoundationDriver/LiveAVFoundationSystem.swift`
uses Apple's AVAudioSession and AVAudioEngine directly, feeding the existing
encrypted recording pipeline. Voice Memos is a separate comparison app. Changing
recorder libraries would not establish that an OS-level input conflict is fixed.

## Before and after each physical microphone check

1. Use the already authorized synthetic encounter and current recording approval.
   Preserve all recordings, keys and pending uploads. Check device availability
   when it is unknown; do not interrupt another recording app.
2. Verify Device Hub and phone mirroring are closed. A previous closed-state
   observation is insufficient: Device Hub was later found running in the
   September 29 incident. On the Mac, this read-only check matches both app paths:

   ```sh
   /usr/bin/pgrep -fl '/(DeviceHub|iPhone Mirroring)[.]app/Contents/MacOS/'
   ```

   Exit 1 with no error means no matching process was found. Exit 0 means a
   matching app is running; stop the test and close it normally when appropriate.
   Any inspection error means **unknown**, never a pass. This check does not
   launch apps, operate the phone, or prove absence of all remote-capture tools.
3. Record non-content metadata: exact app/build and backend, OS versions,
   mirroring observation/time, USB connected or disconnected, requested/actual
   microphone route, and cold versus immediate-repeat start. Keep other conditions
   fixed when comparing builds. USB may stay connected if it does not change the
   selected audio route.
4. Measure the native start request, preparation stages, engine readiness, first
   buffer and first nonzero signal separately. Verify bars against actual signal.
   A moving timer, stale mirrored screen, or silence alone does not prove capture.
5. Confirm Pause/Stop and native microphone release, then repeat the process
   check. If mirroring ran during the recording or its state is unknown, label the
   run accordingly; do not use it to qualify normal capture or a UX speed target.
   Retain useful phase timings with that limitation. Do not discard saved work.

Reopening apps or updating the phone is separate from a microphone check. The
process check grants no microphone or installation authority.

## Performance interpretation

Mirroring interference can prevent usable input and make screen-based timing
unreliable. It has not been shown to account for all Scribe startup latency.
The existing build 40 and 42 checks were documented with sharing off or Device
Hub closed, and measured nonzero input plus confirmed release. They did not have
a continuous mirroring-state trace, so they are not a controlled mirroring A/B.

The September 28 build 42 screen-lock check measured 8.273 seconds from the
native start request to readiness: lease preparation 2.056 seconds, storage
reservations 2.828 seconds, source authorization 3.000 seconds, and native driver
startup 0.308 seconds. The three preparation phases account for approximately
95% of readiness time. Preserve the server/preparation optimization work; do not
attribute that delay to the audio engine or declare the speed target met by
closing Device Hub.

Use an unmirrored current-build baseline at the next already-planned phone test,
including a cold start and immediate repeat. Native timestamps follow UI dispatch;
first nonzero signal also depends on when speech begins. Neither alone measures
the full tap-to-visible-bars interval. See [native request performance](native-request-performance.md).

Local acceptance evidence is retained under
`scribe-native-acceptance-20260924/voice-memos-devicehub-20260929/`:
`RESOLVED.json` records the owner's recovery report; `PERFORMANCE_ASSESSMENT.json`
binds this assessment to the original timing receipts. Historical recordings and
receipts stay unchanged.

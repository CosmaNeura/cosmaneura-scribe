# Owned virtual microphone source

The coordinator can mix one `virtual-microphone` participant with Zoom
participants. Each uses a separate hash-bound fixture from the existing consented
fixture registry. A combined `visit.wav` cannot run beside role tracks.

Compile the helper inside the verified native target's owned root, then pin the
resulting binary SHA-256 in the scenario's native configuration:

```sh
xcrun swiftc -swift-version 5 -parse-as-library \
  -module-cache-path /absolute/owned/cache \
  -o /absolute/owned/bin/microphone-source \
  tools/virtual-lab/coordinator/microphone-source.swift
```

The participant entry uses `kind:"virtual-microphone"`, `persona`, `caseId`,
`file`, and `output:{executable,sha256,deviceUID:"BlackHole2ch_UID"}`. The Appium
adapter supplies the already verified `target` and run/output resource ownership
to SourceGroup. The executable must be inside that target root; a missing helper,
changed binary, default device or physical device fails. The native helper checks
the exact virtual device and selects only its own output AudioUnit. It does not
open an input node or change any system audio default.

Initialization supplies validated PCM16 mono 16 kHz bytes, their separate PCM
hash, the registry-validated WAV hash and synthetic consent ID. It requires at
least 100 ms leading silence, nonzero signal, no clipped samples and at most ten
minutes of PCM. The running output renders actual zeros until a scheduled start.
The factory requires an observed silent callback before returning. Every start
and resume requires fresh product UI and native Recording metadata, matching
consent/session and the original bound recording session. No fixture statement
can substitute for this native observation.

SourceGroup calibrates the helper's monotonic host clock together with browser
clocks and schedules a common future epoch. The helper retains its exact rendered
PCM offset when paused; a pause reply waits for at least 256 observed silent
output frames. Resume continues that offset. Fixture changes preserve the output
graph and require an idle product observation. Device reselection/loss produces
silence before another PCM sample. Each render callback checks the selected
output AudioUnit; this lab-only check is not product performance instrumentation.

First-signal receipts identify `coreaudio-render-callback`, its actual host
timestamp and source offset, a 256-frame RMS window, and callback size. They are
source-graph measurements, separate from Zoom delivery, Scribe input, persisted
audio and transcription. The existing provisional 100 ms source onset tolerance
is unchanged. Native input synchronization and expected saved words require an
actual recording and playback test.

The helper accepts bounded JSON only over its inherited pipes and owns no
listening socket. It checks parent continuity and a 900-second monotonic lifetime;
EOF or parent loss stops only its output. Cleanup waits for the actual child exit
and a fresh launch-marker process inventory. If graceful shutdown fails it may
signal only its current child-process handle, never a saved PID or Scribe itself.
Unknown source work remains unresolved and retains coordinator quarantine.

Offline checks compile the actual source clock with `-D MICROPHONE_SOURCE_TEST`
and `microphone-source.test.swift`. They exercise silence, sample timing, duplicate
start refusal, pause offset, resumed completion and hash rejection without
opening an AudioUnit. JavaScript tests cover actual owned subprocess IPC,
cancellation, malformed replies, target/binary checks, strict cleanup receipts
and a separately labelled mock mixed-source schedule. These are not live
microphone or saved-audio acceptance.

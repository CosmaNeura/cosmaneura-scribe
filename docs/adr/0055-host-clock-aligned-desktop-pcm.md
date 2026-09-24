# ADR 0055 — Align desktop meeting audio into Scribe PCM

Date: 2026-09-22

Status: local native source preparation; not activated or mounted in a host

## Provider outcome and decision

The native desktop source produces separate microphone and system streams with
different rates, start times and clocks. Joining their callback buffers would
shift speech and lose timing. Add `AlignedMeetingPCM` as its native sink, producing
mixed mono PCM16 at the existing Scribe 16 kHz rate for the main-process encrypted
capture pipeline. No raw-media renderer interface or alternate service is added.

Native frames now retain source sample positions as well as host timestamps:
AVAudioTime's sample position for the microphone, and the CoreMedia presentation
time expressed at the stream sample rate for ScreenCaptureKit. The mixer requires
exact consecutive source positions and unchanged rate/channel format. Missing
samples, repeated/backward positions, missing clocks or format changes terminate
input rather than becoming silence, a restart, or a microphone-only fallback.

Adjacent observed host timestamps determine each packet's duration. A nominal
clock slope outside 0.995–1.005 is rejected. This ceiling is not a hardware
accuracy claim; the independent sample-position check rejects a skipped sample
even if its apparent slope is inside the ceiling. The final packet uses the last
observed slope after the owner confirms native shutdown and queue drain.

Both sources must cover the recorded interval. The sink accepts an explicit
common start before any PCM is delivered; the host must remain in its starting
state until then. Startup pre-roll and unmatched final tails are returned as
metadata. They are not padded with silence or represented as complete coverage.
The eventual host must preserve and expose incomplete coverage in its outcome.

Stereo channels are individually clamped and averaged; microphone and system
audio then receive equal weight. Integer rational overlap weights integrate
supplied samples on the 62,500-nanosecond destination grid. PCM quantization retains
the existing asymmetric signed scaling and floor(x + 0.5) rounding. There is no
echo cancellation, automatic gain, language inference or audio file writer.

This conversion is explicitly versioned `host-aligned-area-v1`. The existing
`area-weighted-v1` nominal-rate resampler is unchanged. Nanosecond clock anchors
can move a value by one PCM unit relative to an ideal nominal clock, so the new
algorithm has separate committed goldens checked with exact Fraction arithmetic.
It does not claim arbitrary callback segmentation gives identical bytes when
the measured clock anchors themselves differ.

Each track retains at most four resolved frames plus one pending frame, with the
existing 8,192-frame native input bound. Output packets contain at most 4,096 PCM
frames and sequential frame offsets. The owner supplies the Core-derived total
output bound. Missing/slow sources fail at the queue bound. Samples clear after
consumption, rejection, discard and drain; downstream copies remain their owner's
responsibility. Sink calls are synchronous and must not wait for network I/O.

Normal `MacMeetingAudio.stop(mode: .drain)` now seals admission and drains input
accepted before stop. The default stop, cancellation and terminal failures still
discard pending input. A failed sink during normal drain reports failure and
discards the rest. The existing controller still owns consent, capability,
recording lease, native indicator and stop deadline. An unconfirmed OS stop is
not permission to finish or release the native handle.

## Risk, verification and recovery

Tier 2: native audio ownership and fidelity. This continues ADR 0054's local
invented-data flight plan. No auth, consent policy, encrypted-store format,
Core/OS source, configuration, dependency, active receiver or installed app changes.
Recovery leaves the native package unmounted; previous apps/artifacts remain intact.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-desktop-mixer-20260922.IPmHEd/`.
`tests-current.log` records the full native source compile with warnings as errors and
23 passing Swift checks. These exercise the real native delivery queue and mixer together,
offset/rate/stereo conversion, observed clock drift, a one-sample dropout, missing
sources, format changes, normal/failing stop drain, output limits, rejection,
clearing and final partial periods. Golden bytes are independently verified by
`scripts/check-desktop-mixer-golden.py`, using exact rational arithmetic and the
existing invented waveform. Initial logs preserve the discovered floating-point
rounding defect and the nominal-versus-measured-clock golden difference.
The exact-rational verifier, affected Python lint, ADR numbering and Git
whitespace checks pass. Protected authentication/capture-authority hashes match
the prior checkpoint. No broad unchanged service/preview suite was repeated.

## Remaining integration and acceptance

Next bind this native source/sink to the actual desktop main-process recorder,
existing WAV/encryption/upload/recovery path and persistent recording UI. The
host must distinguish OS startup from the common recorded start, persist the
completion's actual coverage, and call finish only after confirmed normal drain;
interruptions use discard. No provider can use this source in an installed app yet.

Real ScreenCaptureKit silence delivery and clock-position behavior, microphone
timing, long-session drift, echo/headphones, capture extent, native start/stop
fault injection, sleep/device changes and actual Meet/Zoom fidelity are still
unqualified. No physical source or permission prompt was started. Chrome window
selection still does not establish tab-isolated audio. Full Core runtime binding,
standalone desktop/iOS packaging, physical workflow and signed release remain open.

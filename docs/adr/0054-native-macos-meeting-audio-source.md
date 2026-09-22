# ADR 0054 — Prepare native macOS meeting audio for the provider workflow

Date: 2026-09-22

Status: local source preparation; unmounted and disabled

## Context and decision

The current desktop companion has a metadata-only mock. The complete Scribe
pipeline requires captured audio in its existing encryption/transcription/review
flow, while the desktop boundary keeps raw audio and capabilities outside the
renderer. The historical Recall package is not installed or qualified. Adding
that service implicitly would not supply the existing local encrypted PCM path.

Add `ScribeDesktopAudio`, a dependency-free macOS 14.2 native source using Apple's
ScreenCaptureKit and AVFoundation. It prepares an actual OS source implementation
without changing the existing controller, `capture-authority.ts`, renderer IPC,
feature configuration, consent policy, storage profile or service integration.
This does not activate a native shell or retire the historical alternative.

The trusted host supplies an explicit selected Chrome/Zoom window and PID. The
source checks current permission, then re-resolves the window/PID/bundle before
starting. It makes no permission requests and exports no screen frames. Desktop
microphone and system audio retain their sample rates/channel layout and common
host-clock timestamps for the main-process pipeline. There is no raw-media bridge
to the renderer, file writer, network client or credential consumer.

The producer's four-slot queue bounds application-owned audio. Inputs are limited
to 8,192 frames, two channels, finite float samples and increasing per-source
timestamps. Sink rejection, overflow and invalid input stop delivery and emit one
fixed failure. Rejected, accepted and drained buffers are cleared. This claim
excludes framework-owned OS buffers and copies explicitly taken by the trusted
sink for encryption.

The capture window has a required duration derived by the host from current Core
authority; a numeric maximum is not a grant. Window expiry, workstation lock,
sleep, native stream error and engine/device changes end input. The source does
not automatically resume. Stop owns partial startup, waits for native start to
settle, stops both sources and drains delivery. Failed stop retains the same
handles for retry. The main controller remains responsible for its deadline,
single-process/recording lease, persistent indicator and emergency termination.

## Risk and flight plan

Tier 2: native capture and audio ownership. This increment is restricted to the
owner's authorized local provider-workflow preparation with invented data.

1. Prepare dormant native source and qualify memory conversion/bounded delivery.
2. Bind timestamp alignment/mixing and the main-process encrypted capture flow,
   retaining the existing authority and metadata-only recorder IPC boundary.
3. Complete deterministic native lifecycle fault checks and concrete native host,
   permission, backend and signing configuration before proposing activation.
4. Qualify consented physical Meet/Zoom capture, clock drift, gaps/silence, echo,
   device/network interruption, offline recovery and stop/termination behavior.
5. Carry the resulting audio through existing STT, creator review and Core SOAP
   fidelity acceptance, then signed release/update/rollback qualification.

Recovery leaves this package unmounted. No installed app, Keychain namespace,
Core/OS source, active service, shared schema or existing capture record changed.
The prior Mac R2 and W13 artifacts remain preserved. No new external dependency,
service, environment variable or live trial is introduced. Independent review is
still required before any future PR; no other task was contacted for this work.

## Evidence and remaining limits

Evidence root:
`/Users/jw/Desktop/Cosmas/scribe-desktop-audio-20260922.uiZP2V/`.

The complete source compiles with Swift 6, a macOS 14.2 minimum and warnings as
errors. Ten Swift checks pass in `tests-current.log`: bounded delivery/overflow,
consumer rejection, clearing after acceptance/freeze, independent timestamps,
invalid frame/selection rejection, interleaved and planar AVFoundation memory
conversion, disabled startup and refusing a start after explicit stop.
All samples are generated under an explicit invented-consent fixture. No enabled
OS capture, permission request, native app launch, Keychain access or service call
occurred. No existing completed phone or Speech/translation trial was repeated.

Initial build logs retain unavailable user-cache/nested SwiftPM sandbox attempts.
Owned cache/config/build paths and disabled **SwiftPM's nested manifest sandbox**
allowed compilation inside the unchanged outer task sandbox. The first test
compile exposed a Swift Testing key-path macro issue; an ordinary evaluated
predicate corrected the fixture. Final product/test compilation passes.

The source is not wired to Electron or the provider workflow. Native asynchronous
startup/shutdown failure injection, physical source behavior, aligned mixing,
resampling/WAV, encrypted main-process upload/recovery and the full desktop host
remain open. Windows is not implemented by this macOS framework package.

A window filter does not establish tab-specific audio isolation. Chrome may
include other tabs/windows. The native UI must disclose the actual extent and
physical qualification must establish it before activation; this source is not
accepted as meeting-only capture. It is not evidence of physical fidelity, a
standalone desktop beta, signing, distribution or production/PHI readiness.

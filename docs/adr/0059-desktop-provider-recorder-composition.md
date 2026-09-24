# ADR 0059 — Connect the desktop recorder to the provider workspace

Date: 2026-09-22

Status: local main/renderer composition verified; standalone app uninstalled

## Provider outcome

The existing provider workspace can now use a recorder owned by desktop main.
Start, startup cancellation, Stop/upload, interrupted recovery and creator review
use its command/state view. The view does not receive sources, storage handles,
audio, keys, upload URLs, selected-window IDs or capture capabilities. Its mobile
resource path and foreground policy remain unchanged.

`DesktopProviderRecorder.open` composes the existing `CaptureFlowController`,
`DesktopCaptureController`, `NativeProcessPCMDriver` and desktop PCM/WAV source.
It remains disabled by default. The trusted caller must supply its actual
authenticated Core BFF factory, fresh normalized mount/start authority, selected
session, stable creator-scoped stores and key factory, coverage store, approved
helper path/hash, observed workstation state, native window picker, persistent
indicator and exclusive-resource release. No fallback grant, identity, custody
key, picker, indicator, helper or backend configuration is provided.

Before preparing/restoring, main checks the authorized session and retained
configured mixed-channel state. A server-capturing session without its retained
state is refused. A restored capture is paused; it does not start a source or
replay an attempt with retained coverage. Further recording after interruption
still requires explicit reconciliation/new authority; this change does not add
an automatic resume or a second capture/consent protocol.

## Capture and ownership

Start enters the existing desktop controller. Its process lease, fresh authority,
one-time capability and persistent indicator precede native acquisition. The
native selection callback is accessible only during that authorized start. Its
absolute recording limit comes from the existing configured capture receipt.
Main never sends the capability secret to the helper or the view. An actual
host still must obtain the user's deliberate native selection; a Chrome window
does not prove tab-only audio. The provider view discloses application audio
scope and directs the user to select Meet/Chrome or Zoom.

The flow marks its retained phase before asynchronous source startup. The view
therefore has separate Starting and Recording states; only successful native
startup/activation enters Recording. Cancel start remains available while Start
is pending. Native stop is separate from upload: the desktop controller confirms
source closure and clears its indicator/lease before the existing flow uploads.
A slow or failed upload cannot keep a successfully stopped recorder labelled
Recording. Failed source closure keeps the same handle and visible warning;
explicit Stop retries do not start another helper.

Revocation/teardown cancels startup, stops capture and awaits prior work before
closing storage or releasing exclusive ownership. Failed stop/indicator closure
retains the owner for retry. The existing controller now marks shutdown closed
only after clearing the indicator, so a failed indicator update remains retryable.
The desktop PCM readiness promise is observed from creation because cancellation
can close its handle before the shared native lifecycle begins awaiting it.
This preserves the rejection for awaiters and prevents an unhandled rejection.

Coverage metadata is retained separately from audio chunk counts. The view shows
unmatched start/end time omitted from the common interval and warns when a
completion is absent. It does not infer complete clinical coverage or fidelity
from a successful upload.

## Fixed renderer bridge

`DesktopProviderRecorderIpc` attaches to one already-authorized main recorder.
It accepts only read/start/stop/permissions/resume-upload/release/deactivate on a
fixed versioned channel. Main validates exact request keys, UUIDs, webContents
identity and the exact top-level packaged `app://cosmas` origin. It has no
renderer initialization, backend request, source-selection or credential API.
Frame navigation, renderer failure and destruction revoke the boundary and
attempt native cleanup. The host retains the boundary/recorder if cleanup fails.

The sandboxed preload exposes `scribeRecorder` with request/subscribe for only
that fixed command set. `connectDesktopRecorderView` creates the renderer's plain
controller view. Each mount has a main-generated recorder UUID and monotonically
increasing state revision; stale replies cannot overwrite newer events or select
a different recorder. Snapshot fields are a strict scalar metadata allowlist;
legacy transcript/status payloads must be null. After access ends, no read or
late command reply can return recording state. Deactivation replies carry no
snapshot. The shared application/workspace clears protected DOM immediately.

## Verification and remaining runtime work

Tier 2: trusted capture/renderer lifecycle, within the approved local provider
workflow and existing real-services flight plan. No auth policy, Core/OS source,
schema, environment, dependency, native credential store or installed app changed.
Recovery is to leave these modules unmounted; preserve all retained recordings
and existing native applications. The service-auth and capture-authority files
remain byte-identical.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-desktop-provider-20260922.vqbwAd/`.
All 63 desktop and 202 capture checks pass, plus both workspaces' types/lint,
provider/main builds and a Node main-bundle import without activation. Five new
main-recorder checks use the existing independently built Swift generated-audio
helper, real pipes, real encrypted SQLite stores, invented all-party consent and
a disposable loopback BFF. They cover Start/Stop through the command view, slow
upload after confirmed stop, unconfirmed stop/retry with the same helper, cancelled
window selection, revocation/reopen/upload, and rejected changed authority.
They do not use a real backend or microphone; the fixture BFF's consent modality
is its existing in-person protocol, not evidence of live virtual-visit consent.

Three compiled provider DOM checks cover desktop guidance, startup cancellation,
unconfirmed-stop retry/review and immediate revocation clearing. Ten existing
compiled application checks also pass. Two command-view checks cover late/reordered
replies and cancellation during acquisition; an existing-controller regression
proves recovery after indicator failure. Earlier fixture-modality, test annotation,
readiness-rejection and unavailable-jsdom-path diagnostics are retained. The DOM
runner reuses the existing local jsdom 25.0.1 package read-only; none was installed.

This is not an installed Electron acceptance run. Executable main/preload bootstraps,
the native picker and persistent indicator, device key custody, desktop provider
backend/journal ports, actual Core/account/workload/upload/navigation configuration,
standalone identity/packages and physical desktop/iOS acceptance remain necessary.
MCD session lifecycle, iOS 17, Meet/Zoom, fidelity through Core SOAP, signed install/
update/rollback and operating acceptance remain open. W13 build 4, Mac R2 and the
private receiver are preserved. No completed phone or live-service trial was repeated.

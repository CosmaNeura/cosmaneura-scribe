# One compact desktop recorder with independent recovery

Risk: Tier 2 by effect: recording visibility and cessation failure handling.
Owner: John Clemente. Initial cohort: owner's staging Mac beta; review by
2026-10-07 before broader distribution. The owner requested less competing UI
over Zoom, smaller guidance below controls and reliable recovery from freezes.

During starting, recording, stopping and a confirmed pause, the main window is
480×360, held above ordinary app windows across Spaces, with the encounter, status, timer and relevant
Pause/Resume/Stop actions together. It restores its prior bounds after recording
finishes. It changes presentation only, never source selection or consent.
Account actions return in the expanded view. Incomplete coverage and unconfirmed
stop remain explicit; a normal paused state says that no audio is recorded.

## Native handoff

The presentation helper accepts a new private, explicitly selected v2 protocol.
Old v1 callers retain their native panel behavior. Main offers an exact OS
window identifier over its inherited pipe. The helper gets the parent PID
itself and verifies ownership, status-window level, opacity, work-area bounds and
absence of occluding windows. It reads no window titles or pixels. A 2.5-second
monotonic lease expires without refresh. Invalid identity cannot rebind it.

Main also requires a recent, timely response to a constant no-op renderer probe.
Only one probe may be outstanding; responses later than one second cannot renew
freshness, which expires at 1.5 seconds. The existing one-second presentation
heartbeat samples that state. Missing proof returns the native backup panel;
the native menu Stop remains independent throughout. Loss of both control
surfaces retains fail-closed cessation and stop-failure recovery. A renderer
unresponsive/crash event closes through the existing awaited stop path, never
destroying an unconfirmed active recorder first.

These budgets describe polling/lease behavior, not a guaranteed physical UI
reaction time. An actual OS harness with a synthetic Electron window and the production
presentation helper verified the exact window owner and layer, healthy-main
handoff, minimize/restore, a higher owned occluder, lease expiry and renderer
stall. Status level 25 keeps the controls above the observed screen-wide layer
20 overlay and below OS popup menus at level 101. The renderer offer withdrew
in 1,511 ms; expired-lease fallback was observed at 3,084 ms. No microphone or
installed Scribe was used. These single-display synthetic checks do not qualify
physical fullscreen Zoom, multiple displays or a real recording.

## Verification and delivery

Run desktop ownership/transport/failure tests, capture regressions, Swift tests,
the isolated Electron stall check and browser checks against the full app
wrapper at 480×332 content size. Keep stop enabled while paused, show failed-stop
recovery, preserve incomplete-coverage warnings, and keep normal controls and
source guidance inside the small viewport. Simulated clinician screenshot
feedback is not human clinical acceptance.

Record exact tested/reviewed commit and local results in the PR, merge, then
build/sign Mac38 from that clean merged source with preserved identity,
configuration, entitlements, queues and keys. Install only while the existing
app is idle. The companion iPhone52 delivers the separately merged shared UI
and optional-DOB work; native desktop handoff is not an iPhone feature.

Recovery: retain the independent native panel whenever main coverage is absent.
For a package regression, restore only a DOB-compatible signed build once NULL
patients exist; otherwise forward-fix from the retained merged source. Never
reset or uninstall, discard a queue, invent a DOB, remove a pending request or
silently treat an uncertain stop as complete. No production or schema change
is part of this PR.

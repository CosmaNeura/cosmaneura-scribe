# Desktop Close Scribe affordance

Risk: Tier 2 because this adds a narrow renderer-to-main IPC boundary.

The user could not find a way to close a Scribe-owned box. Normal app-menu Quit
removed it; the exact window the user meant was not independently identified.
Add a visible Close Scribe action to the existing desktop application header.
The iPhone renderer does not insert this action.

## Behavior and boundary

- Reuse the workspace's existing unsaved-note decision: keep editing, save and
  continue, or explicitly discard. An in-progress save that has not reached its
  durable journal keeps the editor open. A journaled pending save retains its
  exact request and can be recovered after reopening.
- Send only `scribe:application:close:v1`, with no arguments, through a frozen
  `scribeApplication.close()` preload API. Reject extra arguments, other senders,
  subframes, non-entry URLs, destroyed renderers and removed handlers.
- The main handler calls the existing `requestClose`. Existing shutdown owns
  source cessation, pending acquisition, queue/journal cleanup and failed-stop
  retry. Keep this close handler until confirmed cleanup finishes, so the same
  window and owner remain retryable after a stop failure.
- Do not use renderer `window.close()`: an isolated Electron 44.4.3 test found
  that it destroyed the window before the existing main shutdown completed.
- Do not change consent, key custody, recording/upload implementation, clinical
  review, account authority, native fallback indicators or OS indicators.

## Validation and release

Use the existing staging desktop beta cohort and signed-build release control.
No native installation or capture is performed by this source change. Final
build/sign/install remains a separate owner-authorized delivery step.

Validate the real compiled desktop bootstrap and note guard with synthetic
data; test the fixed IPC's allowlist and existing shutdown retention. Run an
isolated hidden Electron fixture with the complete product preload for normal
close and failed-stop retry. Browser layout checks cover 480/780-pixel widths,
including the 480x360 recording window and the unsaved-note dialog. No test
uses a microphone, live patient data or the installed Scribe app.

Record the exact final reviewed/tested commit and commands in PR evidence.
Previous Mac43 is the recovery artifact. Install a prior signed same-identity
package only after normal idle-state/close checks; preserve application data,
keys, saved recordings, pending queues and notes. This change has no migration
or server rollout requirement. Native-menu Quit's existing note-edit behavior
and disconnected fallback-helper recovery remain separate work.

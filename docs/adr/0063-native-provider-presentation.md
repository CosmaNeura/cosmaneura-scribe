# ADR 0063 — Native provider window choice and recording presentation

Date: 2026-09-22

Status: disabled source preparation; macOS 14.2 typecheck only

`MacProviderPresentation.swift` adds two explicit native resources for the
unfinished desktop factory. Neither is instantiated by the helper or packaged
host. The existing audio implementation, private-pipe protocol, permissions,
protected authority validator and dependencies are unchanged.

`MacProviderWindowPicker` requires an existing native application and already
granted microphone/screen permissions. It enumerates visible Chrome/Zoom windows
and requires a deliberate choice in a native panel. It never selects a default,
prompts for OS permission, starts capture, takes screenshots or logs titles. The
panel discloses microphone/application capture and Chrome's possible inclusion of
other tabs/windows. Selection remains native metadata, revalidated by the existing
audio source at start. Cancellation is scoped to its request, so a delayed cancel
cannot dismiss a subsequent choice; cancelled calls cannot publish a selection.

`MacProviderRecordingIndicator` owns a menu-bar item and persistent native panel.
Stop/close invokes the trusted owner's stop callback and leaves the indicator
visible. Only that owner can publish inactive after confirmed source shutdown.
Failed state cannot return to recording, and another session cannot replace the
active session. Visibility loss publishes the unconfirmed-stop warning and calls
the owner's failure callback once. The future host must check visibility on its
heartbeat as well as screen-change notifications and retain the object through
failed stop/retry.

The source retains macOS 14.2 support. Mapping the system sharing picker's filter
back to this existing window-ID protocol would require filter-inspection APIs
introduced in macOS 15.2; the new panel does not silently raise the minimum.

Tier 2 under the approved local native/provider composition flight plan. Both
objects default to disabled. Recovery leaves them unbound. No app, sign-in,
Keychain action, native permission prompt, running source or deployment occurred.

Verification: all library Swift sources typecheck with Swift 6 and warnings as
errors targeting arm64 macOS 14.2. Command and hashes are recorded in
`build/native-presentation-20260922/checkpoint.json`; the final compiler log is
`typecheck-final-r2.log`. The existing audio/helper trials were not repeated.
This is source compatibility evidence. GUI layout, actual window selection,
full-screen/multiple-display visibility, menu-bar hiding, OS failure handling,
native IPC ownership and installed physical capture remain unqualified. The
packaged `standalone/provider-host.mjs` is still missing.

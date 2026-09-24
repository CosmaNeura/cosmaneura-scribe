# ADR 0061 — Packaged desktop provider host composition

Date: 2026-09-22

Status: local host composition verified; runtime and native/backend factory absent

## Outcome

A dedicated main/preload entry now composes the full desktop provider workspace
inside the intended packaged application. A standalone build script emits main,
preload, four renderer assets, an exact renderer manifest and a source/artifact
receipt. It refuses an existing output directory. It does not install a runtime,
bundle a native/backend factory, sign an app, choose an environment or launch.

Main requires the intended packaged app and single-instance lock before native
construction. It registers the existing secure scheme before readiness, verifies
the four fixed renderer assets, installs renderer security and fixed IPC before
loading/showing the workspace, and uses an isolated nonpersistent session.
Only exact packaged asset GET URLs are served; arbitrary files, query strings,
remote network requests, manifest and main/preload source are unavailable.
The hash manifest detects mismatched inputs; distribution signing is separate.

Window close, navigation, renderer failure and app quit retain provider/native
ownership until cleanup succeeds. A late startup owner is still disposed. Failed
cleanup keeps the app and owner available for an explicit stop retry. Protected
renderer content clears before asynchronous disposal. Closing is not a new
native logout policy. The factory must clean up rejected acquisition and must
not start a capture source during construction.

`standalone/main.mjs` uses a fixed bundled `provider-host.mjs` module, whose
implementation remains missing; `provider-host.d.mts` is only its declaration.
It checks proposed Electron 44.4.3/Node 24. Main and preload JavaScript entries
typecheck against the actual published Electron declarations in external evidence.
The response-header port now matches Electron's real string-or-array header type;
the existing security behavior is unchanged. No dependency was adopted.

## Verification and recovery

Tier 2: packaged provider/renderer lifecycle within the existing local workflow
approval and [flight plan](../flight-plans/scribe-real-services-qualification.md).
Recovery is to keep the host unmounted and the runtime proposal unapplied.
No auth implementation, consent policy, protected authority file, Core/OS source,
schema, installed app, environment, native resource or service changed.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-desktop-host-20260922.3e7wlxvy/`.
All 75 desktop checks pass, including six new host asset/start/quit/ownership
checks. Desktop typecheck, actual Electron declaration typecheck, affected lint
and the packaged host build pass. Three compiled full provider UI/main checks
also pass with the actual compiled preload: sender rejection before native
access; explicit translation review through journaled Core SOAP edit/navigation;
and immediate revocation clearing. Electron itself and the backend are fakes.
The existing generated Swift pipe/SQLite regressions ran; no physical recording
or completed live-service trial ran. Capture source is unchanged from the prior
202-test/13-other-DOM-check checkpoint; those checks were not repeated here.

See the [runtime packet](../beta/SCRIBE_DESKTOP_RUNTIME_PACKET_20260922.md) for
the unapplied dependency proposal. Actual native session/key custody, picker and
indicator, provider/Core configuration, installed desktop/mobile workflows,
identity lifecycle, physical/offline/Meet/Zoom/iOS 17 acceptance, Core fidelity and
signed distribution/operations remain open. The
[shared Core decision](../beta/SCRIBE_SHARED_CORE_DECISION_20260922.md) is settled,
but the actual release contract and isolated configuration still need reconciliation.

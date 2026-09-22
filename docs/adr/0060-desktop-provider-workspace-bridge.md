# ADR 0060 — Desktop provider backend and journal bridge

Date: 2026-09-22

Status: local main/preload/UI integration verified; executable host uninstalled

## Provider outcome

The desktop provider application can now select/create an encounter, reopen its
retained recording/review progress, save an explicit translation decision, prepare
and edit its existing Core note, and navigate to that Core encounter. The main
process owns the authenticated backend, provider/review journals and current
recorder. The renderer receives intended provider content and fixed actions.
It receives no SDK token, backend URL, upload credentials, raw audio, native
source or storage/key handles. SOAP behavior remains in the existing Core flow.

`mountDesktopProviderApplication` reuses the complete provider application and
workspace. `DesktopProviderWorkspaceMain` accepts an injected trusted native
session and authorized workspace factory. `DesktopProviderWorkspaceIpc` binds it
to one packaged top-level renderer; the preload exposes only `scribeProvider`
and the existing `scribeRecorder`. Pure workspace contracts are separated from
browser imports, allowing the main bundle to load without a browser environment.

The factory is still an integration requirement, not a configured production
backend. This change does not select/install Electron or provide an executable
bootstrap, native sign-in host, custody key, picker, indicator or Core profile.

## Boundary and ownership

Requests use a fixed versioned channel and an exact envelope with UUID request,
connection and encounter identifiers. Main generates the latter two and binds
them to the current native session revision. Sender identity, top-level frame
and `app://cosmas` origin are checked before initialization and after asynchronous
work. Native initialization failures become a fixed unavailable response; SDK
error details do not cross IPC. Navigation, destruction and renderer failure revoke the boundary and attempt
cleanup. The host must retain the owner if native cleanup is unconfirmed.

The Core action bridge permits only capture admission, creator review/translation
decision and existing note operations. It verifies the mounted workspace/binding
and nonce. Recorder BFF credential, lease, reservation, upload and completion
operations are unavailable through this surface. Only successful bounded JSON
content or a limited status with no error body crosses it. Journals use their
existing validation/CAS; review and recorder access require the saved session.

Session events carry only phase and revision. A newer event wins over an older
read/mutation reply. Revocation immediately aborts connection/encounter signals
and clears the UI; late content replies cannot reopen it. Encounter changes wait
for the old owner to stop. Shutdown waits for pending backend/recorder handoffs
before releasing handles. Concurrent recorder acquisition is rejected. A recorder
returned after cancellation, or whose IPC attachment fails, remains owned until
deactivation succeeds. Failed cleanup can be retried and blocks replacement.

Ordinary pending requests are bounded to eight. Cancellation does not consume
that capacity; logout and disconnect each reserve one bounded slot. Held content
requests therefore cannot prevent the native logout call. Cleanup completion
still requires the existing host operations to settle or honor their signals.

## Verification and recovery

Tier 2: trusted provider/renderer lifecycle within the already-approved local
provider workflow and [existing flight plan](../flight-plans/scribe-real-services-qualification.md).
No authentication policy, native credential implementation, Core/OS source,
schema, dependency, environment or installed application was changed. Recovery
is to leave these modules unmounted while retaining all stored work and existing
apps. Protected authority files remain byte-identical.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-desktop-workspace-20260922.YKxJkx/`.
All 69 desktop and 202 capture checks pass. Six new main checks cover action
mapping, scope/credential-operation rejection, revocation during content work,
late acquisition, failed stop/attachment ownership, duplicate acquisition,
connection-opening logout, and cancellation/logout at full request capacity.

Three compiled DOM checks exercise the actual new main/preload mapping through
an in-process IPC fake: foreign senders rejected before native access; explicit
Spanish translation acceptance through journaled SOAP preparation/edit/save and
Core navigation; immediate revocation clearing and listener/owner cleanup.
Three existing recorder DOM checks and ten application checks also pass, along
with both typechecks, affected lint and provider/main builds. Initial test-type,
mock-lint and asynchronous-fixture-close diagnostics are retained in the evidence.
The existing jsdom package was reused read-only; no dependency was installed.

These are invented content, consent, native session and backend fixtures. Existing
regressions retain the qualified generated-audio helper/SQLite checks. No physical
recording, real Core request, Electron launch or completed live-service trial ran.
W13 build 4, Mac R2, private receiver/TLS/database, and other tasks are untouched.

Next: executable standalone hosts, native picker/indicator and device key custody,
the pending standalone identity decision, and reviewed actual Core/workload/
account/upload/navigation configuration. Complete installed desktop/iOS 17+
workflow, refresh/revocation/identity continuity, physical interruptions/offline/
Meet/Zoom, fidelity through Core SOAP and signed release/operations acceptance
remain open. This checkpoint does not establish an operational MCD beta.

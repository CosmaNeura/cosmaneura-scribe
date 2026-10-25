# Passive native observations

Install `installVisitScopeObserver({runId})` before the normal Create Visit flow
in a verified owned debug WebView. Its `readCreated()` and `readCurrent()` return
metadata from actual creation/mount responses. A changed authentication revision
or mount invalidates capture observations. It never creates an encounter itself.

After observing the created appointment/workspace, install
`installAdmissionObserver(binding, projectNoteObservation)` before preparation
and consent. Pass the actual `runId`, `workspaceId` and `appointmentRef`; the
observer requires the normal admitted response and matching nonce/revision.
`readRecording()` expires after 15 seconds and hides state during a mutation.
`readTerminal()` retains the first observed sealed state for that recording,
separately from live state. A later poll cannot move its stop timestamp.

`readCurrentNote()` returns the latest normal Core note response, or null while
the latest request is unresolved or invalid. `readNote(action)` retains the
corresponding read/prepare/save receipt. Session, note, transcript and ordered
content hashes support comparison with the saved dashboard route. Neither API
returns note prose, signed URLs, tokens or binding authority. The normal product
continues to own every request, authentication check and mutation.

For restart recovery, pass `observerSHA256` with the visit options and as the
third admission argument. Compute it from the exact injected function sources
(include the note projector for admission), and reject a retained observer whose
`describe()` reports another hash. `describe()` also reports the actual count of
unsettled native replies; an empty new controller is not evidence of settlement.

Remove observers in reverse installation order: admission first, visit second.
`uninstall()` reports uncertainty if a wrapper was replaced or native replies
remain pending, and leaves that observer installed. Retain observers only for
the same owned run and implementation during recovery. No
helper-generated receipt can satisfy the native or account acceptance gates.

Run the secretless regression cases with Node 24:

```sh
node --test tools/virtual-lab/native/*observer.test.mjs tools/virtual-lab/native/note-observation.test.mjs
```
